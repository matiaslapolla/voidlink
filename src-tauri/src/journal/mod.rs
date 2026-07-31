//! The append-only event log — Stage 2's spine.
//!
//! ## What it is
//!
//! One durable, ordered record of things that happened: an agent turn ran, a
//! command finished in a terminal, a commit appeared, a branch was switched.
//! Every cross-cutting surface the product still owes — Mission Control, hill
//! charts, scheduled check-ins, standup generation, "what did the agent do
//! while I was asleep", per-agent audit trails, triggers — is a *view over this
//! table*. None of them are buildable before it exists, which is why it comes
//! first.
//!
//! It is deliberately **not** a replacement for anything already persisted.
//! `voidlink-agent-threads` stores a conversation as the panel re-renders it;
//! this stores what happened, once, in a shape a query can answer. The two
//! disagree on purpose (see `store/layout/persistence.ts`, which says so at the
//! `agentThreads` key).
//!
//! ## Why Rust owns it, rather than a `store/log.ts`
//!
//! Four reasons, in the order they are load-bearing:
//!
//!   1. **Three windows write.** The workbench, the editor window and the git
//!      window are separate webviews sharing one `localStorage` origin, and
//!      `persistence.ts` writes through a 120ms debounce that serialises a whole
//!      collection. Two windows appending to one array is a read-modify-write
//!      race whose loser's events vanish silently. An append-only log with a
//!      lost-write mode is not an append-only log. One writer, in Rust, has no
//!      such mode.
//!   2. **Only Rust sees some of the events.** The filesystem watcher is where a
//!      commit made in an external terminal — or by an agent — becomes
//!      observable. Routing that through a window to be written back would drop
//!      it whenever no window happened to be listening, which is exactly the
//!      "while I was asleep" case.
//!   3. **Growth.** `localStorage` is a ~5MB origin-wide budget already shared
//!      with every layout key, and its failure mode there is a toast that says
//!      durability was lost. Acceptable for pane geometry; not for an audit
//!      trail. A rotated file on disk has room to be honest.
//!   4. **Stage 3 is cross-workspace.** Mission Control joins across repos. A
//!      per-worktree blob in the layout store is the wrong shape for that query
//!      and would have to be thrown away.
//!
//! ## Why the module is called `journal`
//!
//! Because `log` is already an extern crate this file calls (`log::warn!`), and
//! a `crate::log` module sitting next to it is a name resolution puzzle nobody
//! should have to solve while reading a stack trace. The product word is still
//! "event log"; the module word is `journal`.
//!
//! ## The schema, and the two decisions inside it
//!
//! `kind` is a **dotted string, not an enum**. An enum would mean every new
//! event kind is a lockstep Rust+TS change, and — worse — that replaying a log
//! written by an older build fails on the first unknown variant. A log that
//! cannot be read by a future version of the reader is not durable. Unknown
//! kinds are legible anyway, because of the second decision:
//!
//! `summary` is **mandatory and written at append time**. One human-readable
//! line, composed by whoever knew what happened, while they still knew. This is
//! what makes standup and check-in generation possible without a bespoke
//! renderer per kind, and what keeps a two-year-old event readable after its
//! `data` payload has changed shape twice. `data` is the machine half and is
//! free to drift; `summary` is the contract.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Broadcast to every window when events land, carrying the events themselves.
///
/// The payload is the batch rather than a "something changed" ping: a window
/// that wants to append to a live view should not have to re-query to find out
/// what it already could have been told.
pub const JOURNAL_APPENDED_EVENT: &str = "voidlink://journal-appended";

/// How many events are held in memory for fast querying.
///
/// The common query — "the last day or two, in this repo" — is served from this
/// ring without touching the disk. A query that reaches past it falls back to
/// reading both generations (see `journal_query`), so the ring is a cache and
/// not a horizon: what it holds is a performance question, not a data one.
const RECENT_CAP: usize = 2000;

/// Rotate at 4 MiB, keeping one previous generation.
///
/// At roughly 250 bytes an event that is ~16k events per file. Two generations
/// is enough that a rotation never loses the window a check-in would look at,
/// and few enough that the log cannot quietly become the largest thing in the
/// app data directory.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// How far back the log is meant to be able to answer questions: six weeks.
///
/// Not an arbitrary round number — it is one Basecamp cycle, which is the
/// longest window any planned reader looks at. Hill charts plot a cycle, a
/// check-in compares against the start of one, and "what happened while I was
/// away" is days. Retention shorter than the longest reader's window makes that
/// reader silently wrong; much longer buys nothing and grows a file forever.
const RETENTION_MS: i64 = 42 * 24 * 60 * 60 * 1000;

/// The oldest `at` a query may return. Events before it are dropped on read and
/// their file is deleted once every event in it has aged out.
fn horizon() -> i64 {
    now_millis() - RETENTION_MS
}

// ── The record ───────────────────────────────────────────────────────────────

/// Who caused an event.
///
/// Three values and not an open string, because attribution is the one field a
/// view is allowed to *branch* on — "show me only what the agents did" is a
/// primary Mission Control filter, and it must not depend on spelling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Actor {
    /// A person, acting through the UI.
    User,
    /// An agent turn.
    Agent,
    /// VoidLink itself, or an observation of something it did not do — a commit
    /// that appeared on disk has no known author from the watcher's point of
    /// view, and claiming one would be a lie a standup would then repeat.
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    /// Unix milliseconds, from Rust's clock.
    ///
    /// One clock rather than each window's, so events from three webviews sort
    /// coherently against each other and against the watcher's.
    pub at: i64,
    /// Dotted kind, e.g. `git.commit`, `agent.turn.finished`. See the module
    /// comment for why this is a string.
    pub kind: String,
    pub actor: Actor,
    /// The agent's name for `Actor::Agent`; `None` otherwise.
    pub actor_name: Option<String>,
    /// Repository root. The join key every cross-repo view groups by, which is
    /// why it is stored even when it duplicates something in `data`.
    pub repo: Option<String>,
    /// The workspace this repository belongs to, as the user named it.
    ///
    /// `repo` alone is enough to *group* and not enough to *ask a question*:
    /// "everything on the API project" spans a main checkout and four
    /// worktrees, which are five different `repo` values and one workspace.
    /// Denormalised onto every event rather than joined at read time because
    /// the join table lives in the frontend's `localStorage` and a workspace
    /// the user has since deleted still has history worth reading.
    ///
    /// `#[serde(default)]` on both halves is what lets this land on a log that
    /// is already accumulating: lines written before this field existed parse
    /// as `None` instead of failing, which is the same durability contract the
    /// open `kind` string buys.
    #[serde(default)]
    pub workspace: Option<String>,
    /// The thing acted on: a branch name, a file path, an agent name.
    pub subject: Option<String>,
    /// One human-readable line. Always present. See the module comment.
    pub summary: String,
    /// Kind-specific payload. Free to change shape; nothing may depend on it
    /// being present or well-formed.
    #[serde(default)]
    pub data: serde_json::Value,
}

/// What a caller supplies. The log stamps `id` and `at` itself, so a caller
/// cannot backdate an event or collide two ids.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    pub kind: String,
    #[serde(default = "default_actor")]
    pub actor: Actor,
    #[serde(default)]
    pub actor_name: Option<String>,
    #[serde(default)]
    pub repo: Option<String>,
    /// Usually left unset: `append` fills it from the repository registry, so a
    /// caller that knows the repo does not also have to know the workspace.
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

fn default_actor() -> Actor {
    Actor::User
}

/// A query over the ring. Every field is optional and they intersect.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    /// Only this repository.
    #[serde(default)]
    pub repo: Option<String>,
    /// Only these repositories. Unions with `repo` rather than intersecting —
    /// a query naming both means "this one or any of those", which is the only
    /// reading under which passing both is not simply a mistake. Mission
    /// Control uses this to ask about six worktrees in one round trip instead
    /// of six.
    #[serde(default)]
    pub repos: Option<Vec<String>>,
    /// Only this workspace. The Basecamp-shaped question: everything on one
    /// project, across its main checkout and every worktree hanging off it.
    #[serde(default)]
    pub workspace: Option<String>,
    /// Only these kinds — matched as **prefixes**, so `"git."` selects every
    /// git event and `"agent.turn.finished"` selects exactly one kind. Prefix
    /// rather than equality because the kinds are a dotted hierarchy and a view
    /// almost always wants a subtree of it.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    /// Only these actors.
    #[serde(default)]
    pub actors: Option<Vec<Actor>>,
    /// Unix millis; events at or after it.
    #[serde(default)]
    pub since: Option<i64>,
    /// Most recent N, applied last. `None` means every match in the ring.
    #[serde(default)]
    pub limit: Option<usize>,
}

impl Query {
    fn matches(&self, event: &Event) -> bool {
        // `repo` and `repos` are one predicate with two spellings, evaluated
        // together so that supplying both cannot silently exclude everything.
        if self.repo.is_some() || self.repos.is_some() {
            let named = self.repo.iter().map(String::as_str);
            let listed = self.repos.iter().flatten().map(String::as_str);
            let hit = event
                .repo
                .as_deref()
                .is_some_and(|r| named.chain(listed).any(|want| want == r));
            if !hit {
                return false;
            }
        }
        if let Some(workspace) = &self.workspace {
            if event.workspace.as_deref() != Some(workspace.as_str()) {
                return false;
            }
        }
        if let Some(kinds) = &self.kinds {
            if !kinds.iter().any(|k| event.kind.starts_with(k.as_str())) {
                return false;
            }
        }
        if let Some(actors) = &self.actors {
            if !actors.contains(&event.actor) {
                return false;
            }
        }
        if let Some(since) = self.since {
            if event.at < since {
                return false;
            }
        }
        true
    }
}

// ── State ────────────────────────────────────────────────────────────────────

/// The last observed refs of a repository, for deriving semantic git events.
/// See `note_repo_change`.
#[derive(Debug, Clone, Default, PartialEq)]
struct RepoHead {
    oid: Option<String>,
    branch: Option<String>,
    operation: Option<String>,
}

/// What the frontend knows about a checkout that Rust otherwise cannot see.
///
/// The workspace/worktree model lives in the layout store, in `localStorage`,
/// which Rust has no access to and no business parsing. So the frontend
/// publishes it — every window, on every workspace change, idempotently — and
/// Rust keeps the last thing it was told.
///
/// It is a *cache of a frontend fact*, never a source of truth, which is why
/// nothing here fails when it is empty. An unregistered repository still gets
/// its events; they just carry no workspace, and a workspace-scoped query
/// misses them. Degrading to "less grouping" beats refusing to record.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    /// Worktree path — the same string that appears as `Event::repo`.
    pub path: String,
    pub workspace_id: String,
    /// The workspace's display name, denormalised for the same reason
    /// `Event::workspace` is: a deleted workspace's history stays readable.
    pub workspace_name: String,
    #[serde(default)]
    pub worktree_id: Option<String>,
    /// Whether this is the workspace's main checkout rather than a linked
    /// worktree. Mission Control sorts on it; nothing else reads it.
    #[serde(default)]
    pub is_main: bool,
}

/// An agent turn that is running in a repository, or recently was.
///
/// `until` is `None` while the child process is alive and a timestamp once it
/// has exited — see `GRACE_MS` for why the window outlives the turn.
#[derive(Debug, Clone)]
struct Working {
    token: u64,
    name: String,
    /// When the turn started, so Mission Control can say how long it has been
    /// running. Not derivable from the log: turns are recorded on their *end*
    /// precisely so the log has no dangling open intervals (see the comment at
    /// `recordTurn` in `commands/agent.ts`), which means live state has to come
    /// from live state.
    since: i64,
    until: Option<i64>,
}

/// An agent turn that is running right now, for Mission Control.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveAgent {
    pub repo: String,
    pub name: String,
    pub since: i64,
}

/// How long after a turn ends its repository stays attributable to it.
///
/// A turn whose *last* act is a commit writes, exits, and only then does the
/// watcher's 250ms debounce elapse and the ref read happen. Closing the window
/// on the child's exit would therefore misattribute exactly the events that
/// matter most — the ones where the agent finished by committing its work.
///
/// Five seconds is an order of magnitude above the debounce plus a ref read,
/// and short enough that a user committing by hand immediately after reading an
/// answer is outside it. It is a heuristic either way, which is why everything
/// it attributes is marked `inferred`.
const GRACE_MS: i64 = 5_000;

#[derive(Default)]
struct Inner {
    /// `None` until `init` resolves the app data directory, and after any write
    /// failure that makes the file unusable. The in-memory ring keeps working
    /// either way — losing durability must not also lose the session's events,
    /// for the same reason `persistence.ts` keeps state in memory when
    /// `localStorage` throws.
    path: Option<PathBuf>,
    bytes: u64,
    recent: VecDeque<Event>,
    /// Whether the ring currently holds *every* event still within retention.
    ///
    /// When true — the overwhelmingly common case, since 2000 events is weeks
    /// of ordinary use — any query can be answered without opening a file. It
    /// goes false the first time an event is evicted or a rotation happens, and
    /// never goes true again for the life of the process.
    ring_is_whole: bool,
    heads: HashMap<String, RepoHead>,
    /// Worktree path → what the frontend last said about it. See `RepoIdentity`.
    repos: HashMap<String, RepoIdentity>,
    /// Repository root → the agent turns running in it. Keyed by repo because
    /// that is what the watcher has when it needs to answer "who did this".
    working: HashMap<String, Vec<Working>>,
    next_token: u64,
}

#[derive(Default)]
pub struct JournalState {
    inner: Mutex<Inner>,
}

impl JournalState {
    /// Recover rather than propagate a poisoned lock, the same policy
    /// `blocking_git!` applies: one panicking append is not a reason to stop
    /// recording everything afterwards.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Inner {
    /// Push into the ring, evicting the oldest when it is full.
    ///
    /// The one place eviction happens, so `ring_is_whole` cannot be left stale
    /// by a second push site that forgot to clear it — which would make queries
    /// silently answer from a partial ring.
    fn remember(&mut self, event: Event) {
        if self.recent.len() == RECENT_CAP {
            self.recent.pop_front();
            self.ring_is_whole = false;
        }
        self.recent.push_back(event);
    }

    /// Turns running right now, in a stable order.
    ///
    /// Turns inside their post-exit grace window are excluded. The grace exists
    /// so a commit landing after the child died is still attributed; reporting
    /// those five seconds as "still running" would leave a spinner on a turn
    /// the user just watched finish.
    ///
    /// Sorted because a `HashMap` iterates arbitrarily, and a list that
    /// reshuffles on every poll is a list nobody can read.
    fn active_agents(&self) -> Vec<ActiveAgent> {
        let mut out: Vec<ActiveAgent> = self
            .working
            .iter()
            .flat_map(|(repo, turns)| {
                turns
                    .iter()
                    .filter(|w| w.until.is_none())
                    .map(move |w| ActiveAgent {
                        repo: repo.clone(),
                        name: w.name.clone(),
                        since: w.since,
                    })
            })
            .collect();
        out.sort_by(|a, b| a.repo.cmp(&b.repo).then(a.since.cmp(&b.since)));
        out
    }

    /// The agent to credit for something observed in `repo` at `now`, if any.
    ///
    /// Also prunes windows that have expired, so the map cannot grow for the
    /// life of the process. The *most recently started* turn wins when two
    /// agents overlap in one repository: neither answer is knowable, and the
    /// newer one is the better guess.
    fn agent_in(&mut self, repo: &str, now: i64) -> Option<String> {
        let turns = self.working.get_mut(repo)?;
        turns.retain(|w| w.until.is_none_or(|until| until >= now));
        if turns.is_empty() {
            self.working.remove(repo);
            return None;
        }
        turns.last().map(|w| w.name.clone())
    }
}

/// Marks a repository as having an agent working in it for as long as it is
/// held, plus `GRACE_MS` after it is dropped.
///
/// RAII rather than a matching `end()` call, so a turn that ends by panic,
/// cancel, or a killed child still closes its window — the same reason
/// `agent/mod.rs` wraps its turn registry in `TurnGuard`. A leaked window would
/// silently credit the agent with everything the user did afterwards.
pub struct AgentWork {
    repo: String,
    token: u64,
}

/// The app handle, stored once at `init`.
///
/// A global rather than a parameter for one reason: `agent_working` is called
/// from inside `agent_stream_query`, and threading a handle in would put an
/// `AppHandle` in that command's signature — which its end-to-end tests, the
/// ones that actually spawn and kill a child process, would then need a mock
/// app to satisfy. Trading a hidden global for a mock app in the tests that
/// verify no orphan process survives a cancel is the wrong trade.
///
/// Unset outside a running app (every unit test), where registering a window
/// is a no-op and reading one finds nothing — which is the correct behaviour.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

fn with_journal<T>(f: impl FnOnce(&mut Inner) -> T) -> Option<T> {
    let app = APP.get()?;
    let state = app.state::<JournalState>();
    let mut inner = state.lock();
    Some(f(&mut inner))
}

impl Drop for AgentWork {
    fn drop(&mut self) {
        let until = now_millis() + GRACE_MS;
        with_journal(|inner| {
            if let Some(turns) = inner.working.get_mut(&self.repo) {
                for turn in turns.iter_mut().filter(|w| w.token == self.token) {
                    turn.until = Some(until);
                }
            }
        });
    }
}

/// Register that `name` is working in `repo` until the returned guard drops.
pub fn agent_working(repo: &str, name: &str) -> AgentWork {
    let token = with_journal(|inner| {
        inner.next_token += 1;
        let token = inner.next_token;
        inner
            .working
            .entry(repo.to_string())
            .or_default()
            .push(Working {
                token,
                name: name.to_string(),
                since: now_millis(),
                until: None,
            });
        token
    })
    .unwrap_or(0);
    AgentWork {
        repo: repo.to_string(),
        token,
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── Boot ─────────────────────────────────────────────────────────────────────

fn journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?
        .join("journal");
    // `app_data_dir` resolves a path; it does not create it, and on a first run
    // nothing else has.
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir.join("events.jsonl"))
}

/// Load the tail of the log into the ring and remember where to append.
///
/// Called once from `setup`. A failure here is logged and swallowed: the app
/// must boot without a writable data directory, it just does so without
/// durability.
pub fn init(app: &AppHandle) {
    let state = app.state::<JournalState>();
    let mut inner = state.lock();

    let path = match journal_path(app) {
        Ok(path) => path,
        Err(e) => {
            log::warn!("event log disabled: {e}");
            return;
        }
    };

    // A generation whose newest event has aged out is deleted before anything
    // reads it, so retention costs nothing at query time.
    prune_previous(&path, horizon());

    let text = std::fs::read_to_string(&path).unwrap_or_default();
    inner.bytes = text.len() as u64;
    // The ring starts whole only if there is no older generation to be missing.
    // `remember` clears it if the file alone overflows the ring.
    inner.ring_is_whole = !previous_of(&path).exists();
    for event in parse_lines(&text) {
        inner.remember(event);
    }
    log::info!(
        "event log at {} ({} event{} in memory, {})",
        path.display(),
        inner.recent.len(),
        if inner.recent.len() == 1 { "" } else { "s" },
        if inner.ring_is_whole {
            "the whole log"
        } else {
            "more on disk"
        }
    );
    inner.path = Some(path);
    // Published after the log is usable, for `AgentWork` — see `APP`.
    let _ = APP.set(app.clone());
}

/// Parse a JSONL blob, skipping what does not parse.
///
/// A line that does not parse is skipped rather than fatal. The realistic
/// producer of one is a torn final line from a process killed mid-append, and
/// losing that single event is the whole cost.
fn parse_lines(text: &str) -> Vec<Event> {
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Event>(line) {
            Ok(event) => out.push(event),
            Err(e) => log::warn!("skipping an unreadable event log line: {e}"),
        }
    }
    out
}

/// Where the previous generation lives. `events.jsonl` → `events.1.jsonl`.
fn previous_of(path: &Path) -> PathBuf {
    path.with_extension("1.jsonl")
}

/// Delete the previous generation once every event in it has aged out.
///
/// Whole-file granularity rather than rewriting it without the expired events:
/// a rotated generation is immutable, and a partial rewrite is a chance to
/// corrupt the only copy of events that are still inside retention. The cost is
/// that expired events linger until the *whole* file expires — which is why
/// reads filter by the horizon too, rather than trusting the file's presence.
fn prune_previous(path: &Path, horizon: i64) {
    let previous = previous_of(path);
    let Ok(text) = std::fs::read_to_string(&previous) else {
        return;
    };
    let newest = text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Event>(line).ok())
        .map(|event| event.at)
        .next();
    if let Some(newest) = newest {
        if newest < horizon {
            match std::fs::remove_file(&previous) {
                Ok(()) => log::info!("dropped an event log generation past retention"),
                Err(e) => log::warn!("could not drop an expired event log generation: {e}"),
            }
        }
    }
}

/// Every event still on disk and still within retention, oldest first.
///
/// Both generations, previous first. The current file contains everything the
/// ring holds, so this is a superset rather than something to merge with it —
/// with one stated exception: events recorded after a write failure took
/// `path` away live only in the ring, and a query that falls back to disk will
/// not see them. That is the same trade as the ring itself, and the alternative
/// (merge and dedupe by id on every deep query) costs more than the case is
/// worth.
fn read_from_disk(path: &Path) -> Vec<Event> {
    let cutoff = horizon();
    let mut out = Vec::new();
    for file in [previous_of(path), path.to_path_buf()] {
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        out.extend(parse_lines(&text).into_iter().filter(|e| e.at >= cutoff));
    }
    out
}

// ── Append ───────────────────────────────────────────────────────────────────

/// Move the current file aside, keeping exactly one previous generation.
fn rotate(path: &Path) -> std::io::Result<()> {
    let previous = previous_of(path);
    // Ignore a missing previous generation; `rename` overwrites it otherwise.
    let _ = std::fs::remove_file(&previous);
    std::fs::rename(path, &previous)
}

fn write_through(inner: &mut Inner, events: &[Event]) {
    let Some(path) = inner.path.clone() else {
        return;
    };

    if inner.bytes >= MAX_BYTES {
        match rotate(&path) {
            Ok(()) => {
                inner.bytes = 0;
                // There is now an older generation the ring does not hold.
                inner.ring_is_whole = false;
                prune_previous(&path, horizon());
            }
            Err(e) => log::warn!("could not rotate the event log: {e}"),
        }
    }

    // One line per event, one open per batch. Serialising each event separately
    // means a value that somehow fails to serialise costs that event and not the
    // batch around it.
    let mut buffer = String::new();
    for event in events {
        match serde_json::to_string(event) {
            Ok(line) => {
                buffer.push_str(&line);
                buffer.push('\n');
            }
            Err(e) => log::warn!("could not serialise a {} event: {e}", event.kind),
        }
    }
    if buffer.is_empty() {
        return;
    }

    let opened = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path);
    match opened.and_then(|mut file| file.write_all(buffer.as_bytes())) {
        Ok(()) => inner.bytes += buffer.len() as u64,
        Err(e) => {
            // Stop trying, so a full or read-only disk produces one warning
            // rather than one per event for the rest of the session. The ring
            // below still records everything this session sees.
            log::warn!("event log write failed, continuing in memory only: {e}");
            inner.path = None;
        }
    }
}

/// Stamp, persist, remember and broadcast a batch. The one write path.
pub fn append(app: &AppHandle, incoming: Vec<NewEvent>) -> Vec<Event> {
    if incoming.is_empty() {
        return Vec::new();
    }
    let at = now_millis();
    let state = app.state::<JournalState>();

    let events: Vec<Event> = {
        let inner = state.lock();
        incoming
            .into_iter()
            .map(|e| Event {
                id: uuid::Uuid::new_v4().to_string(),
                at,
                kind: e.kind,
                actor: e.actor,
                actor_name: e.actor_name,
                // The one place a workspace is resolved, so a caller can never
                // stamp one that disagrees with the registry, and no call site
                // has to know the mapping exists. An explicit workspace still
                // wins — the fan-out runner sets one for events that belong to
                // a run rather than to a checkout.
                workspace: e.workspace.or_else(|| {
                    let repo = e.repo.as_deref()?;
                    Some(inner.repos.get(repo)?.workspace_name.clone())
                }),
                repo: e.repo,
                subject: e.subject,
                summary: e.summary,
                data: e.data,
            })
            .collect()
    };

    {
        let mut inner = state.lock();
        write_through(&mut inner, &events);
        for event in &events {
            inner.remember(event.clone());
        }
    }

    if let Err(e) = app.emit(JOURNAL_APPENDED_EVENT, &events) {
        log::warn!("could not broadcast {} event(s): {e}", events.len());
    }
    events
}

// ── Deriving git events from the watcher ─────────────────────────────────────

/// Read the refs that describe "where this repository is".
///
/// Deliberately only cheap ref reads — HEAD, its branch, the operation marker
/// files. A `git status` here would be the expensive thing running on every
/// debounced filesystem burst, and the dirty-file count is not something the
/// log has a use for.
fn observe(repo_path: &str) -> Option<RepoHead> {
    let repo = git2::Repository::open(repo_path).ok()?;
    let head = repo.head().ok();
    let oid = head
        .as_ref()
        .and_then(|h| h.target())
        .map(|o| o.to_string());
    let branch = head
        .as_ref()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand())
        .map(|s| s.to_string());
    let git_dir = repo.path();
    let operation = [
        ("merge", "MERGE_HEAD"),
        ("rebase", "rebase-merge"),
        ("rebase", "rebase-apply"),
        ("cherry-pick", "CHERRY_PICK_HEAD"),
        ("revert", "REVERT_HEAD"),
    ]
    .iter()
    .find(|(_, marker)| git_dir.join(marker).exists())
    .map(|(name, _)| name.to_string());
    Some(RepoHead {
        oid,
        branch,
        operation,
    })
}

fn short(oid: &str) -> &str {
    &oid[..oid.len().min(7)]
}

/// The one-line summary of a commit, for the `git.commit` event.
fn commit_summary(repo_path: &str, oid: &str) -> Option<String> {
    let repo = git2::Repository::open(repo_path).ok()?;
    let id = git2::Oid::from_str(oid).ok()?;
    let commit = repo.find_commit(id).ok()?;
    commit.summary().map(|s| s.to_string())
}

/// Whether `child`'s parents include `parent` — i.e. whether HEAD moving from
/// `parent` to `child` was an ordinary commit rather than a reset or a rebase.
fn is_child_of(repo_path: &str, child: &str, parent: &str) -> bool {
    let Ok(repo) = git2::Repository::open(repo_path) else {
        return false;
    };
    let (Ok(child_id), Ok(parent_id)) = (git2::Oid::from_str(child), git2::Oid::from_str(parent))
    else {
        return false;
    };
    let Ok(commit) = repo.find_commit(child_id) else {
        return false;
    };
    commit.parent_ids().any(|p| p == parent_id)
}

/// Turn "this repository changed on disk" into what actually changed.
///
/// This is the reason the log is worth having in Rust and not just the reason
/// it is *possible*: it observes commits, branch switches and rebases whether
/// they came from a VoidLink button, a `git` typed into VoidLink's own terminal,
/// an agent, or another application entirely. Instrumenting the ~40 mutation
/// call sites in the frontend would catch only the first of those four, and
/// would drift the first time somebody added a forty-first.
///
/// The first observation of a repository records state and emits nothing —
/// discovering where a repository already was is not news.
///
/// Called *after* the refresh pulse goes out, and without taking the per-repo
/// git lock. Both on purpose: the watcher's callback thread must not be held
/// behind a `fetch` that happens to be running, and a refresh the user is
/// waiting on must not queue behind bookkeeping.
pub fn note_repo_change(app: &AppHandle, repo_path: &str) {
    let Some(next) = observe(repo_path) else {
        return;
    };

    let (previous, agent) = {
        let state = app.state::<JournalState>();
        let mut inner = state.lock();
        let previous = inner.heads.insert(repo_path.to_string(), next.clone());
        (previous, inner.agent_in(repo_path, now_millis()))
    };
    let Some(previous) = previous else {
        return;
    };
    if previous == next {
        return;
    }

    // The two facts that need the repository open, read once and only when the
    // commit actually moved — so `derive` below stays pure and testable.
    let moved = match (&previous.oid, &next.oid) {
        (Some(from), Some(to)) if from != to && previous.branch == next.branch => Some(Moved {
            is_child: is_child_of(repo_path, to, from),
            summary: commit_summary(repo_path, to),
        }),
        _ => None,
    };

    append(app, derive(repo_path, &previous, &next, moved, agent.as_deref()));
}

/// What a HEAD move was, once the repository has been consulted.
#[derive(Debug, Clone, Default)]
struct Moved {
    /// The new commit lists the old one as a parent — an ordinary commit, as
    /// opposed to a reset, rebase or amend.
    is_child: bool,
    /// The new commit's one-line summary, when it has one.
    summary: Option<String>,
}

/// Two observations in, events out. Pure.
///
/// `agent` is the name of an agent that was working in this repository when the
/// change was seen, if any. It turns a `system` event into an `agent` one — the
/// difference between "a commit appeared" and "the Refactorer committed", which
/// is the whole of "what did the agent do while I was asleep".
fn derive(
    repo_path: &str,
    previous: &RepoHead,
    next: &RepoHead,
    moved: Option<Moved>,
    agent: Option<&str>,
) -> Vec<NewEvent> {
    let mut events = Vec::new();
    let base = |kind: &str,
                subject: Option<String>,
                summary: String,
                data: serde_json::Value| {
        // Without an overlapping turn the watcher genuinely does not know who
        // moved the ref — it could be the user, another tool, or a script — and
        // guessing `user` would put a false attribution into every standup.
        // With one, the credit is a *heuristic over overlapping time*, never an
        // observation, so it says so in the record rather than in a comment.
        let mut data = data;
        if let (Some(name), serde_json::Value::Object(map)) = (agent, &mut data) {
            map.insert("attribution".into(), serde_json::json!("inferred"));
            map.insert("inferredFrom".into(), serde_json::json!("overlapping agent turn"));
            map.insert("agent".into(), serde_json::json!(name));
        }
        NewEvent {
            kind: kind.to_string(),
            actor: if agent.is_some() {
                Actor::Agent
            } else {
                Actor::System
            },
            actor_name: agent.map(String::from),
            repo: Some(repo_path.to_string()),
            // Left for `append` to resolve from the registry — see there.
            workspace: None,
            subject,
            summary,
            data,
        }
    };

    if previous.branch != next.branch {
        let to = next.branch.clone().unwrap_or_else(|| {
            next.oid
                .as_deref()
                .map(|o| format!("detached at {}", short(o)))
                .unwrap_or_else(|| "an unborn branch".to_string())
        });
        let summary = match &previous.branch {
            Some(from) => format!("Switched from {from} to {to}"),
            None => format!("Switched to {to}"),
        };
        events.push(base(
            "git.branch.switched",
            next.branch.clone(),
            summary,
            serde_json::json!({ "from": previous.branch, "to": next.branch }),
        ));
    } else if let (Some(from), Some(to), Some(moved)) = (&previous.oid, &next.oid, moved) {
        if moved.is_child {
            let summary = match &moved.summary {
                Some(s) => format!("Committed “{s}”"),
                None => format!("Committed {}", short(to)),
            };
            events.push(base(
                "git.commit",
                moved.summary.clone(),
                summary,
                serde_json::json!({ "oid": to, "parent": from, "branch": next.branch }),
            ));
        } else {
            // A reset, an amend, a rebase, or a branch that was force-moved.
            // Which of those it was is not knowable from the refs alone, so the
            // event says only what is true.
            events.push(base(
                "git.head.moved",
                next.branch.clone(),
                format!("HEAD moved from {} to {}", short(from), short(to)),
                serde_json::json!({ "from": from, "to": to, "branch": next.branch }),
            ));
        }
    }

    if previous.operation != next.operation {
        match &next.operation {
            Some(op) => events.push(base(
                "git.operation.started",
                Some(op.clone()),
                format!("Started a {op}"),
                serde_json::json!({ "operation": op }),
            )),
            None => {
                let op = previous.operation.clone().unwrap_or_default();
                events.push(base(
                    "git.operation.ended",
                    Some(op.clone()),
                    format!("Finished the {op}"),
                    serde_json::json!({ "operation": op }),
                ));
            }
        }
    }

    events
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Record events from a window. Batched because the frontend coalesces bursts
/// the same way `gitEvents.ts` coalesces refresh pulses.
#[tauri::command]
pub fn journal_append(app: AppHandle, events: Vec<NewEvent>) -> Vec<Event> {
    append(&app, events)
}

/// Publish the workspace/worktree map so Rust can stamp and group by it.
///
/// A full replacement rather than an upsert: the frontend holds the whole
/// truth, and a worktree that was removed has to *leave* the registry or
/// Mission Control keeps listing a directory nobody has. Idempotent, cheap, and
/// called from whichever window notices a change — last writer wins, and since
/// all three windows read the same `localStorage` they agree on the answer.
#[tauri::command]
pub fn journal_register_repos(state: tauri::State<'_, JournalState>, repos: Vec<RepoIdentity>) {
    let mut inner = state.lock();
    inner.repos = repos.into_iter().map(|r| (r.path.clone(), r)).collect();
}

/// Every checkout Rust currently knows about. Mission Control's row list.
#[tauri::command]
pub fn journal_repos(state: tauri::State<'_, JournalState>) -> Vec<RepoIdentity> {
    state.lock().repos.values().cloned().collect()
}

/// Turns running right now, per repository.
///
/// Live state, read from the same map that attributes git events — so Mission
/// Control and the attribution can never disagree about who is working where.
/// Turns inside their post-exit grace window are excluded: the grace exists to
/// catch a commit landing after the child died, and reporting those five
/// seconds as "still running" would show a spinner for a turn the user just
/// watched finish.
#[tauri::command]
pub fn journal_active_agents(state: tauri::State<'_, JournalState>) -> Vec<ActiveAgent> {
    state.lock().active_agents()
}

/// The whole of selection, as a pure function — so the tests exercise what the
/// command actually uses rather than a second copy of it that is free to
/// disagree, and so the ring and the disk path cannot filter differently.
fn select<'a>(events: impl Iterator<Item = &'a Event>, query: &Query) -> Vec<Event> {
    let matched: Vec<&Event> = events.filter(|e| query.matches(e)).collect();
    // `limit` means "the most recent N", so it is taken from the end and left in
    // ascending order — a caller asking for 20 wants the last 20, not the first.
    let start = match query.limit {
        Some(n) => matched.len().saturating_sub(n),
        None => 0,
    };
    matched[start..].iter().map(|e| (*e).clone()).collect()
}

/// Can the ring answer this query without opening a file?
///
/// Yes when it holds the whole log, and yes when the caller bounded the query
/// at or after the ring's oldest event — nothing on disk could then fall inside
/// the window they asked for. Any unbounded query against a partial ring has to
/// read, because "everything" includes what was evicted.
fn ring_suffices(inner: &Inner, query: &Query) -> bool {
    if inner.ring_is_whole || inner.path.is_none() {
        return true;
    }
    match (query.since, inner.recent.front()) {
        (Some(since), Some(oldest)) => oldest.at <= since,
        _ => false,
    }
}

/// Read matching events, oldest first.
///
/// Served from the in-memory ring when it can answer, and from both on-disk
/// generations when it cannot. The fallback is what makes the six-week
/// retention real: a hill chart asking for a cycle gets a cycle, not the last
/// 2000 events.
#[tauri::command]
pub fn journal_query(state: tauri::State<'_, JournalState>, query: Query) -> Vec<Event> {
    let inner = state.lock();
    if ring_suffices(&inner, &query) {
        return select(inner.recent.iter(), &query);
    }
    let Some(path) = inner.path.clone() else {
        return select(inner.recent.iter(), &query);
    };
    // The lock is released before the read: a deep query parses megabytes, and
    // holding the journal mutex across that would stall every `record()` in
    // every window behind a Mission Control refresh.
    drop(inner);
    select(read_from_disk(&path).iter(), &query)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, actor: Actor, repo: Option<&str>, at: i64) -> Event {
        Event {
            id: format!("{kind}-{at}"),
            at,
            kind: kind.to_string(),
            actor,
            actor_name: None,
            repo: repo.map(|r| r.to_string()),
            workspace: None,
            subject: None,
            summary: kind.to_string(),
            data: serde_json::Value::Null,
        }
    }

    /// The same event, tagged with a workspace.
    fn in_workspace(mut event: Event, workspace: &str) -> Event {
        event.workspace = Some(workspace.to_string());
        event
    }

    fn ring(events: Vec<Event>) -> VecDeque<Event> {
        events.into()
    }

    /// Kinds of the events `select` returns, in order.
    fn run(recent: &VecDeque<Event>, query: Query) -> Vec<String> {
        select(recent.iter(), &query)
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    #[test]
    fn kinds_match_as_prefixes_so_a_view_can_ask_for_a_subtree() {
        let recent = ring(vec![
            event("git.commit", Actor::System, None, 1),
            event("git.branch.switched", Actor::System, None, 2),
            event("agent.turn.finished", Actor::Agent, None, 3),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    kinds: Some(vec!["git.".into()]),
                    ..Default::default()
                }
            ),
            vec!["git.commit", "git.branch.switched"]
        );
        // An exact kind is just a prefix that happens to be the whole string.
        assert_eq!(
            run(
                &recent,
                Query {
                    kinds: Some(vec!["agent.turn.finished".into()]),
                    ..Default::default()
                }
            ),
            vec!["agent.turn.finished"]
        );
    }

    #[test]
    fn filters_intersect_rather_than_union() {
        let recent = ring(vec![
            event("git.commit", Actor::System, Some("/a"), 10),
            event("git.commit", Actor::System, Some("/b"), 20),
            event("agent.turn.finished", Actor::Agent, Some("/a"), 30),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    repo: Some("/a".into()),
                    actors: Some(vec![Actor::Agent]),
                    ..Default::default()
                }
            ),
            vec!["agent.turn.finished"]
        );
        assert!(run(
            &recent,
            Query {
                repo: Some("/b".into()),
                since: Some(21),
                ..Default::default()
            }
        )
        .is_empty());
    }

    /// Mission Control's query: six worktrees in one round trip.
    #[test]
    fn repos_selects_any_of_the_listed_checkouts() {
        let recent = ring(vec![
            event("a", Actor::User, Some("/a"), 10),
            event("b", Actor::User, Some("/b"), 20),
            event("c", Actor::User, Some("/c"), 30),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    repos: Some(vec!["/a".into(), "/c".into()]),
                    ..Default::default()
                }
            ),
            vec!["a", "c"]
        );
    }

    /// `repo` and `repos` are one predicate. Intersecting them would mean a
    /// query naming both returns nothing, which is a silent empty result rather
    /// than an error — the worst possible way to be wrong.
    #[test]
    fn repo_and_repos_union_rather_than_cancelling_each_other_out() {
        let recent = ring(vec![
            event("a", Actor::User, Some("/a"), 10),
            event("b", Actor::User, Some("/b"), 20),
            event("c", Actor::User, Some("/c"), 30),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    repo: Some("/a".into()),
                    repos: Some(vec!["/b".into()]),
                    ..Default::default()
                }
            ),
            vec!["a", "b"]
        );
    }

    /// The Basecamp-shaped question: one project, every checkout of it.
    #[test]
    fn a_workspace_filter_spans_every_checkout_in_it() {
        let recent = ring(vec![
            in_workspace(event("main", Actor::User, Some("/api"), 10), "api"),
            in_workspace(event("wt", Actor::User, Some("/api-hotfix"), 20), "api"),
            in_workspace(event("other", Actor::User, Some("/site"), 30), "site"),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    workspace: Some("api".into()),
                    ..Default::default()
                }
            ),
            vec!["main", "wt"]
        );
    }

    /// Events written before the registry knew about a repository carry no
    /// workspace, and must not silently join whichever workspace is asked for.
    #[test]
    fn an_unstamped_event_belongs_to_no_workspace() {
        let recent = ring(vec![event("orphan", Actor::User, Some("/x"), 10)]);
        assert!(run(
            &recent,
            Query {
                workspace: Some("api".into()),
                ..Default::default()
            }
        )
        .is_empty());
    }

    #[test]
    fn limit_takes_the_most_recent_and_keeps_them_ascending() {
        let recent = ring(vec![
            event("one", Actor::User, None, 1),
            event("two", Actor::User, None, 2),
            event("three", Actor::User, None, 3),
        ]);
        assert_eq!(
            run(
                &recent,
                Query {
                    limit: Some(2),
                    ..Default::default()
                }
            ),
            vec!["two", "three"]
        );
        // Asking for more than exists is not an error and does not panic.
        assert_eq!(
            run(
                &recent,
                Query {
                    limit: Some(99),
                    ..Default::default()
                }
            )
            .len(),
            3
        );
    }

    /// A caller may omit everything the log can stamp or default. The frontend
    /// relies on this: `record({ kind, summary })` is the common call.
    #[test]
    fn a_minimal_new_event_deserialises_and_defaults_to_the_user() {
        let parsed: NewEvent =
            serde_json::from_str(r#"{"kind":"note","summary":"hello"}"#).expect("should parse");
        assert_eq!(parsed.actor, Actor::User);
        assert!(parsed.repo.is_none());
        assert_eq!(parsed.data, serde_json::Value::Null);
    }

    /// The durability contract: an event written by this build must be readable
    /// as an `Event` after a round trip through the file format.
    #[test]
    fn an_event_round_trips_through_its_jsonl_line() {
        let original = Event {
            id: "abc".into(),
            at: 1234,
            kind: "git.commit".into(),
            actor: Actor::System,
            actor_name: None,
            repo: Some("/repo".into()),
            workspace: Some("voidlink".into()),
            subject: Some("Fix the thing".into()),
            summary: "Committed “Fix the thing”".into(),
            data: serde_json::json!({ "oid": "deadbeef" }),
        };
        let line = serde_json::to_string(&original).expect("should serialise");
        assert!(!line.contains('\n'), "a line must not contain a newline");
        let back: Event = serde_json::from_str(&line).expect("should parse");
        assert_eq!(back.kind, original.kind);
        assert_eq!(back.summary, original.summary);
        assert_eq!(back.actor, Actor::System);
        assert_eq!(back.workspace.as_deref(), Some("voidlink"));
        assert_eq!(back.data["oid"], "deadbeef");
    }

    /// The forward-compatibility half of the same contract, and the reason
    /// `workspace` could be added to a log that was already accumulating: a
    /// line written before the field existed must still parse.
    #[test]
    fn a_line_written_before_workspace_existed_still_parses() {
        let old = r#"{"id":"a","at":1,"kind":"git.commit","actor":"system","actorName":null,"repo":"/repo","subject":null,"summary":"Committed something","data":{}}"#;
        let back: Event = serde_json::from_str(old).expect("an older line must still parse");
        assert_eq!(back.workspace, None);
        assert_eq!(back.summary, "Committed something");
    }

    /// An older reader must not choke on a kind it has never heard of — the
    /// whole reason `kind` is a string. Guards against someone "tidying" it
    /// into an enum later.
    #[test]
    fn an_unknown_kind_still_parses_and_is_still_legible() {
        let line = r#"{"id":"x","at":1,"kind":"hill.position.moved","actor":"user",
            "actorName":null,"repo":null,"subject":null,"summary":"Moved uphill","data":{}}"#;
        let parsed: Event = serde_json::from_str(line).expect("an unknown kind must still parse");
        assert_eq!(parsed.summary, "Moved uphill");
    }

    // ── Retention, rotation and the ring/disk decision ───────────────────────

    fn write_log(path: &Path, events: &[Event]) {
        let text: String = events
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect();
        std::fs::write(path, text).unwrap();
    }

    fn at_days_ago(days: i64) -> i64 {
        now_millis() - days * 24 * 60 * 60 * 1000
    }

    /// A generation whose newest event is inside retention must survive, or a
    /// hill chart plotting a six-week cycle silently loses its early weeks.
    #[test]
    fn a_previous_generation_still_inside_retention_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        write_log(
            &previous_of(&path),
            &[event("old", Actor::User, None, at_days_ago(40))],
        );

        prune_previous(&path, horizon());
        assert!(previous_of(&path).exists());
    }

    #[test]
    fn a_previous_generation_entirely_past_retention_is_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        write_log(
            &previous_of(&path),
            &[
                event("ancient", Actor::User, None, at_days_ago(90)),
                event("still-old", Actor::User, None, at_days_ago(50)),
            ],
        );

        prune_previous(&path, horizon());
        assert!(!previous_of(&path).exists());
    }

    #[test]
    fn pruning_a_log_that_has_never_rotated_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        prune_previous(&dir.path().join("events.jsonl"), horizon());
    }

    /// Both generations, previous first, so the result is chronological.
    #[test]
    fn reading_from_disk_spans_both_generations_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        write_log(
            &previous_of(&path),
            &[event("older", Actor::User, None, at_days_ago(10))],
        );
        write_log(&path, &[event("newer", Actor::User, None, at_days_ago(1))]);

        let kinds: Vec<String> = read_from_disk(&path).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["older", "newer"]);
    }

    /// Retention is enforced on read as well as by deletion, because a file is
    /// only deleted once *every* event in it has aged out — until then it holds
    /// a mix, and the expired half must not surface.
    #[test]
    fn reading_drops_events_past_the_horizon_even_when_the_file_survives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        write_log(
            &path,
            &[
                event("expired", Actor::User, None, at_days_ago(60)),
                event("live", Actor::User, None, at_days_ago(3)),
            ],
        );

        let kinds: Vec<String> = read_from_disk(&path).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["live"]);
    }

    /// A torn final line from a process killed mid-append costs that line only.
    #[test]
    fn an_unparseable_line_costs_that_line_and_not_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let good = serde_json::to_string(&event("good", Actor::User, None, at_days_ago(1))).unwrap();
        std::fs::write(&path, format!("{good}\n{{\"kind\":\"trunc")).unwrap();

        let kinds: Vec<String> = read_from_disk(&path).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["good"]);
    }

    fn inner_with(ring_is_whole: bool, path: Option<PathBuf>, oldest_at: i64) -> Inner {
        Inner {
            path,
            bytes: 0,
            recent: vec![event("a", Actor::User, None, oldest_at)].into(),
            ring_is_whole,
            heads: HashMap::new(),
            repos: HashMap::new(),
            working: HashMap::new(),
            next_token: 0,
        }
    }

    #[test]
    fn a_whole_ring_answers_everything_without_touching_disk() {
        let inner = inner_with(true, Some(PathBuf::from("/x/events.jsonl")), 500);
        assert!(ring_suffices(&inner, &Query::default()));
    }

    /// The ring is partial, but the caller bounded the query inside what the
    /// ring already holds — nothing on disk could fall in that window.
    #[test]
    fn a_partial_ring_answers_a_query_bounded_inside_it() {
        let inner = inner_with(false, Some(PathBuf::from("/x/events.jsonl")), 500);
        assert!(ring_suffices(
            &inner,
            &Query {
                since: Some(500),
                ..Default::default()
            }
        ));
        assert!(ring_suffices(
            &inner,
            &Query {
                since: Some(900),
                ..Default::default()
            }
        ));
    }

    #[test]
    fn a_partial_ring_defers_to_disk_for_anything_reaching_past_it() {
        let inner = inner_with(false, Some(PathBuf::from("/x/events.jsonl")), 500);
        // Unbounded: "everything" includes what was evicted.
        assert!(!ring_suffices(&inner, &Query::default()));
        // Bounded before the ring starts.
        assert!(!ring_suffices(
            &inner,
            &Query {
                since: Some(100),
                ..Default::default()
            }
        ));
    }

    /// With no file there is nothing to fall back *to*, so the ring is the whole
    /// log by definition — otherwise a log running without durability would
    /// answer every query with nothing.
    #[test]
    fn without_a_file_the_ring_is_the_whole_log() {
        let inner = inner_with(false, None, 500);
        assert!(ring_suffices(&inner, &Query::default()));
    }

    /// Eviction is the event that makes the ring partial, and it must be
    /// recorded — a stale `ring_is_whole` means queries silently answer from an
    /// incomplete ring, which is the worst failure this module has.
    #[test]
    fn evicting_from_the_ring_marks_it_no_longer_whole() {
        let mut inner = Inner {
            ring_is_whole: true,
            ..Default::default()
        };
        for i in 0..RECENT_CAP {
            inner.remember(event("e", Actor::User, None, i as i64));
        }
        assert!(inner.ring_is_whole, "filling it exactly must not evict");
        assert_eq!(inner.recent.len(), RECENT_CAP);

        inner.remember(event("one-more", Actor::User, None, 9999));
        assert!(!inner.ring_is_whole);
        assert_eq!(inner.recent.len(), RECENT_CAP);
        assert_eq!(inner.recent.back().unwrap().kind, "one-more");
    }

    #[test]
    fn rotating_moves_the_current_file_aside_and_replaces_any_older_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        write_log(
            &previous_of(&path),
            &[event("gen2", Actor::User, None, at_days_ago(2))],
        );
        write_log(&path, &[event("gen1", Actor::User, None, at_days_ago(1))]);

        rotate(&path).unwrap();

        assert!(!path.exists(), "the current file is moved, not copied");
        let kinds: Vec<String> = read_from_disk(&path).into_iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec!["gen1"], "the oldest generation is dropped");
    }

    // ── Deriving git events from two observations ────────────────────────────

    fn head(oid: Option<&str>, branch: Option<&str>, operation: Option<&str>) -> RepoHead {
        RepoHead {
            oid: oid.map(String::from),
            branch: branch.map(String::from),
            operation: operation.map(String::from),
        }
    }

    /// `(kind, summary)` of each derived event, with nobody credited.
    fn derived(previous: &RepoHead, next: &RepoHead, moved: Option<Moved>) -> Vec<(String, String)> {
        derive("/repo", previous, next, moved, None)
            .into_iter()
            .map(|e| (e.kind, e.summary))
            .collect()
    }

    #[test]
    fn a_new_commit_on_the_same_branch_is_a_commit_not_a_head_move() {
        let events = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("main"), None),
            Some(Moved {
                is_child: true,
                summary: Some("Fix the thing".into()),
            }),
        );
        assert_eq!(
            events,
            vec![("git.commit".to_string(), "Committed “Fix the thing”".to_string())]
        );
    }

    /// A reset or a rebase moves HEAD to something that is *not* a child. The
    /// log must not call that a commit — a standup that reports a `git reset` as
    /// work done is worse than one that says nothing.
    #[test]
    fn a_head_move_that_is_not_a_child_is_reported_as_a_move() {
        let events = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("main"), None),
            Some(Moved {
                is_child: false,
                summary: Some("An older commit".into()),
            }),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "git.head.moved");
        assert_eq!(events[0].1, "HEAD moved from aaaaaaa to bbbbbbb");
    }

    /// Checking out a branch moves both the branch and the oid. That is one
    /// event, not two — the commit did not "change", the user moved.
    #[test]
    fn switching_branches_is_one_event_even_though_the_oid_also_moved() {
        let events = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("feature"), None),
            None,
        );
        assert_eq!(
            events,
            vec![(
                "git.branch.switched".to_string(),
                "Switched from main to feature".to_string()
            )]
        );
    }

    #[test]
    fn detaching_head_names_the_commit_rather_than_a_branch() {
        let events = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), None, None),
            None,
        );
        assert_eq!(events[0].0, "git.branch.switched");
        assert_eq!(events[0].1, "Switched from main to detached at bbbbbbb");
    }

    #[test]
    fn starting_and_finishing_an_operation_bracket_each_other() {
        let started = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("aaaaaaaaaaaa"), Some("main"), Some("rebase")),
            None,
        );
        assert_eq!(
            started,
            vec![("git.operation.started".to_string(), "Started a rebase".to_string())]
        );

        let ended = derived(
            &head(Some("aaaaaaaaaaaa"), Some("main"), Some("rebase")),
            &head(Some("cccccccccccc"), Some("main"), None),
            Some(Moved {
                is_child: false,
                summary: None,
            }),
        );
        // The move and the operation ending are both true and both recorded.
        assert_eq!(
            ended.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
            vec!["git.head.moved", "git.operation.ended"]
        );
        assert_eq!(ended[1].1, "Finished the rebase");
    }

    /// The watcher fires on any interesting write, most of which move nothing.
    #[test]
    fn an_observation_that_changed_nothing_derives_nothing() {
        let same = head(Some("aaaaaaaaaaaa"), Some("main"), None);
        assert!(derived(&same, &same, None).is_empty());
    }

    /// Everything the watcher derives is `System`: it saw a change, it does not
    /// know who made it, and inventing an actor would put a false attribution
    /// into every view that filters on one.
    #[test]
    fn derived_events_never_claim_an_actor() {
        let events = derive(
            "/repo",
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("feature"), None),
            None,
            None,
        );
        assert!(events.iter().all(|e| e.actor == Actor::System));
        assert!(events.iter().all(|e| e.repo.as_deref() == Some("/repo")));
    }

    // ── Attribution ──────────────────────────────────────────────────────────

    /// The whole point of the feature: a commit that appears while an agent is
    /// working is credited to that agent, so "what did it do while I was
    /// asleep" has an answer.
    #[test]
    fn a_commit_during_an_agent_turn_is_credited_to_that_agent() {
        let events = derive(
            "/repo",
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("main"), None),
            Some(Moved {
                is_child: true,
                summary: Some("Extract the parser".into()),
            }),
            Some("Refactorer"),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].actor, Actor::Agent);
        assert_eq!(events[0].actor_name.as_deref(), Some("Refactorer"));
    }

    /// Credit is a heuristic over overlapping time, never an observation, and
    /// the record has to say so — a reader that cannot tell the two apart will
    /// eventually present a guess as a fact.
    #[test]
    fn agent_credit_is_marked_inferred_in_the_record_itself() {
        let events = derive(
            "/repo",
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("feature"), None),
            None,
            Some("Refactorer"),
        );
        assert_eq!(events[0].data["attribution"], "inferred");
        assert_eq!(events[0].data["agent"], "Refactorer");
    }

    /// And without an overlapping turn nothing is claimed at all.
    #[test]
    fn without_an_overlapping_turn_nothing_is_credited() {
        let events = derive(
            "/repo",
            &head(Some("aaaaaaaaaaaa"), Some("main"), None),
            &head(Some("bbbbbbbbbbbb"), Some("feature"), None),
            None,
            None,
        );
        assert_eq!(events[0].actor, Actor::System);
        assert!(events[0].actor_name.is_none());
        assert!(events[0].data.get("attribution").is_none());
    }

    fn working_inner() -> Inner {
        Inner::default()
    }

    fn register(inner: &mut Inner, repo: &str, name: &str) -> u64 {
        inner.next_token += 1;
        let token = inner.next_token;
        inner
            .working
            .entry(repo.to_string())
            .or_default()
            .push(Working {
                token,
                name: name.to_string(),
                since: now_millis(),
                until: None,
            });
        token
    }

    #[test]
    fn a_running_turn_is_found_and_an_unrelated_repo_is_not() {
        let mut inner = working_inner();
        register(&mut inner, "/a", "Refactorer");
        assert_eq!(inner.agent_in("/a", 1000).as_deref(), Some("Refactorer"));
        assert!(inner.agent_in("/b", 1000).is_none());
    }

    /// The grace window is the load-bearing part: a turn whose last act is a
    /// commit exits *before* the watcher's debounce elapses, so closing the
    /// window on exit would miss exactly the events worth attributing.
    #[test]
    fn a_turn_that_just_ended_still_covers_events_inside_the_grace_window() {
        let mut inner = working_inner();
        let token = register(&mut inner, "/a", "Refactorer");
        let ended = 10_000;
        for turn in inner.working.get_mut("/a").unwrap() {
            if turn.token == token {
                turn.until = Some(ended + GRACE_MS);
            }
        }
        assert_eq!(
            inner.agent_in("/a", ended + GRACE_MS - 1).as_deref(),
            Some("Refactorer"),
            "inside the window"
        );
        assert!(
            inner.agent_in("/a", ended + GRACE_MS + 1).is_none(),
            "past the window"
        );
    }

    /// An expired window must not merely stop matching — it must be forgotten,
    /// or the map grows for the life of the process.
    #[test]
    fn expired_windows_are_pruned_rather_than_accumulated() {
        let mut inner = working_inner();
        let token = register(&mut inner, "/a", "Refactorer");
        for turn in inner.working.get_mut("/a").unwrap() {
            if turn.token == token {
                turn.until = Some(500);
            }
        }
        assert!(inner.agent_in("/a", 9_000).is_none());
        assert!(
            !inner.working.contains_key("/a"),
            "the repo entry must be dropped once empty"
        );
    }

    /// Mission Control asks "what is running right now", which is a different
    /// question from "who should be credited for this" — the grace window
    /// answers yes to the second and must answer no to the first.
    #[test]
    fn a_turn_in_its_grace_window_is_credited_but_is_not_reported_as_running() {
        let mut inner = working_inner();
        let token = register(&mut inner, "/a", "Refactorer");
        let now = now_millis();
        for turn in inner.working.get_mut("/a").unwrap() {
            if turn.token == token {
                turn.until = Some(now + GRACE_MS);
            }
        }
        assert_eq!(
            inner.agent_in("/a", now).as_deref(),
            Some("Refactorer"),
            "still attributable"
        );
        assert!(inner.active_agents().is_empty(), "but no longer running");
    }

    #[test]
    fn active_agents_reports_every_live_turn_in_a_stable_order() {
        let mut inner = working_inner();
        register(&mut inner, "/b", "Second");
        register(&mut inner, "/a", "First");
        let active = inner.active_agents();
        assert_eq!(
            active.iter().map(|a| a.repo.as_str()).collect::<Vec<_>>(),
            vec!["/a", "/b"]
        );
        assert_eq!(active[0].name, "First");
    }

    /// Two agents in one repository: neither answer is knowable, and the more
    /// recently started turn is the better guess.
    #[test]
    fn the_most_recently_started_turn_wins_when_two_overlap() {
        let mut inner = working_inner();
        register(&mut inner, "/a", "First");
        register(&mut inner, "/a", "Second");
        assert_eq!(inner.agent_in("/a", 1000).as_deref(), Some("Second"));
    }

    /// Outside a running app there is no handle, so registering is a no-op that
    /// must not panic — every unit test in this crate takes that path.
    #[test]
    fn registering_without_an_app_handle_is_harmless() {
        let work = agent_working("/repo", "Refactorer");
        drop(work);
    }

    #[test]
    fn short_oids_do_not_panic_on_a_string_shorter_than_seven() {
        assert_eq!(short("deadbeefcafe"), "deadbee");
        assert_eq!(short("abc"), "abc");
        assert_eq!(short(""), "");
    }
}
