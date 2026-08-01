//! The fan-out supervisor — legs that outlive the window that started them.
//!
//! ## The failure mode this exists to fix
//!
//! Before this module, a fan-out leg was a child process spawned by the
//! *frontend* calling [`crate::agent::agent_stream_query`] straight from a
//! webview: the future driving it lived in that webview's JS heap, and the
//! `Channel` carrying its output was owned by that webview's IPC transport.
//! Close the window — or reload it — and both die with it, even though the
//! child process and the `agent::turns()` registry entry are Rust state that
//! never needed the window at all. What survived was a *record*, in
//! `localStorage`, with the leg's last known status frozen and no way to learn
//! anything more. `frontend/src/store/fanout.ts`'s header called this "not
//! here" and said what fixing it would take: moving the orchestration into
//! Rust so a run's lifetime is the **app's**, not the **webview's**.
//!
//! This module is that move. `fanout_start_run` spawns and drives every leg
//! from here — no frontend `await` is on the critical path of a single byte
//! this produces. The frontend becomes what the module comment promised: a
//! *view* over state that exists independently of it, reached through
//! [`fanout_run_state`] (what is running right now) and [`fanout_subscribe`]
//! (attach to one run's live output, from any window, at any time after it
//! started).
//!
//! ## Buffered and replayed, not dropped
//!
//! A leg's whole answer is held in memory (`Leg::answer`) for the run's
//! lifetime, and [`fanout_subscribe`] sends it in full — as a
//! [`FanoutEvent::Snapshot`] — before a single live chunk. This is a
//! deliberate choice against the alternative (drop output produced while
//! nobody was listening, keep only the record): a fan-out is *for* being left
//! unattended, so "come back later and the answer picks up wherever you left
//! the tab" is the point, not an edge case. The cost is bounded — these are
//! CLI answers, not video — and paid once per subscribe, not per chunk.
//!
//! The corollary is the thing the task this module implements warns against by
//! name: a webview must never render a leg's answer as complete when it is
//! actually a replay of a partial buffer plus a live tail that could still be
//! interrupted by the *app* going away (not just the window). This module does
//! not paper over that — [`LegSnapshot::status`] is always the true status
//! this process knows, and a status the app cannot vouch for (because it has
//! no record of the run at all — a different process, an app restart) is
//! [`fanout_run_state`] and [`fanout_subscribe`] returning nothing / an error
//! for that run id, which the frontend reads exactly like a leg whose window
//! closed under the *old* model: `interrupted`. See `store/fanout.ts` for
//! that reconciliation. **The app quitting is still a horizon.** A run's
//! lifetime is the app's, and an app that is not running supervises nothing —
//! that was always the honest boundary this feature can move to, not "survive
//! anything".
//!
//! ## What still lives in the frontend, on purpose
//!
//! - **Branch and worktree-path naming** (`legBranchName`, `legWorktreePath`
//!   in `store/fanout.ts`) — pure functions, already tested, no reason to
//!   duplicate.
//! - **The diff stat** (`legStat`) — computed by the frontend once a leg goes
//!   terminal, using the same `gitApi.diffRefs`/`diffWorking` calls the rest
//!   of the app already has. It is idempotent over on-disk state, so it does
//!   not care which window asks or when — unlike the streamed answer, there
//!   is nothing here that only the original window could have seen.
//! - **Adopt and discard** — `git merge` and `git worktree remove` against a
//!   branch name that is durable on disk. Neither depends on any process this
//!   module owns, so neither gained anything from moving.
//!
//! ## Why legs reuse `agent::agent_stream_query` rather than a second spawn path
//!
//! Process-group ownership, the login-shell PATH fix, UTF-8-safe incremental
//! decoding, and the `SIGTERM`-then-`SIGKILL` cancel sequence are all in
//! `agent::run_turn` and are exactly as tricky for a fan-out leg as for a
//! chat turn — a leg *is* a turn, with its `turn_id` fixed to the leg's own
//! id. Re-implementing any of that here would be a second copy of code that
//! is already fuzz-shaped (raw pipes, signals, partial UTF-8) drifting from
//! the first the moment either one is touched. Calling the existing `pub`
//! command function directly — it is a plain `async fn` underneath the
//! `#[tauri::command]` attribute, and takes no `AppHandle` or `State` at all —
//! costs nothing and buys back every test in `agent::tests` for free: a leg's
//! cancel semantics are proven there, not re-proven here.
//!
//! ## Why journalling goes through a closure, not `AppHandle` directly
//!
//! Every state change this module makes must reach the journal (task
//! requirement: "the event log is the source of truth for what happened, do
//! not build a second history"). The obvious way is `journal::append(&app,
//! ...)`, but threading a live `AppHandle` through `run_leg` would mean this
//! module's tests need one too — and `tauri::test`'s `MockRuntime` produces an
//! `AppHandle<MockRuntime>`, a different type from the `AppHandle` (= `AppHandle<Wry>`)
//! every non-generic Rust function in this crate expects, so a mock app cannot
//! stand in for a real one without making `journal::append` generic over the
//! runtime — a change with a much bigger blast radius than this module
//! deserves. A `Recorder` closure sidesteps the mismatch entirely: the
//! `#[tauri::command]` entry points build one that calls the real
//! `journal::append`, and tests build one that pushes into a `Vec` they can
//! assert on — which is a *better* test than a mock app would have given
//! (asserting the exact events, not merely that some IPC did not panic).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::agent::{self, AgentStreamEvent};
use crate::git::GitState;
use crate::journal::{self, Actor, NewEvent};
use crate::secrets::SecretBinding;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Records one journal event. See the module header for why this is a
/// closure and not a bare `AppHandle`.
type Recorder = Arc<dyn Fn(NewEvent) + Send + Sync>;

fn real_recorder(app: AppHandle) -> Recorder {
    Arc::new(move |event| {
        journal::append(&app, vec![event]);
    })
}

// ── The record ───────────────────────────────────────────────────────────────

/// A leg's status, as the supervisor sees it.
///
/// Deliberately has **no `interrupted` variant**. That status is a frontend
/// concept for a leg with no live supervisor behind it — an old localStorage
/// record, or a run this process restarted out from under — and never
/// something this module assigns, because this module always knows the true
/// terminal state of anything it is still tracking: it owns the `wait()`
/// call. See the module header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LegStatus {
    Pending,
    Preparing,
    Running,
    Finished,
    Failed,
    Cancelled,
}

impl LegStatus {
    /// Whether nothing further will happen to a leg in this status on its
    /// own. `#[cfg(test)]` because the only caller today is a test polling
    /// for "both legs are done, whichever way" — production code always
    /// checks a *specific* terminal status instead, since which one it is is
    /// exactly the information that matters.
    #[cfg(test)]
    fn is_done(self) -> bool {
        !matches!(self, LegStatus::Pending | LegStatus::Preparing | LegStatus::Running)
    }
}

/// One leg, as given by the frontend at launch. Ids, branch and worktree path
/// are minted in TS (see `legBranchName`/`legWorktreePath`) and passed in
/// whole, so this module never has to be the thing two processes disagree
/// about a naming scheme through.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegInput {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub command_template: String,
    pub branch: String,
    pub worktree_path: String,
    /// The fully assembled instruction for this leg — the raw run prompt
    /// wrapped in the "make the change, do not describe it" framing. Composed
    /// by the frontend (`legPrompt`) because that framing is product text,
    /// not orchestration.
    pub prompt: String,
}

/// One leg, as this module tracks it.
struct Leg {
    id: String,
    agent_id: String,
    agent_name: String,
    command_template: String,
    worktree_path: String,
    branch: String,
    status: LegStatus,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    /// The full answer streamed so far. Never truncated — see "Buffered and
    /// replayed" above.
    answer: String,
    error: Option<String>,
}

impl Leg {
    fn snapshot(&self) -> LegSnapshot {
        LegSnapshot {
            id: self.id.clone(),
            agent_id: self.agent_id.clone(),
            agent_name: self.agent_name.clone(),
            command_template: self.command_template.clone(),
            worktree_path: self.worktree_path.clone(),
            branch: self.branch.clone(),
            status: self.status,
            started_at: self.started_at,
            ended_at: self.ended_at,
            answer: self.answer.clone(),
            error: self.error.clone(),
        }
    }
}

/// A run, as this module tracks it. Behind an `Arc<Mutex<_>>` because every
/// leg's task, plus the subscribe/query commands, all touch it concurrently,
/// and none of them may hold the lock across a blocking operation — the
/// worktree creation and the child process both run on their own blocking
/// threads precisely so they never do.
struct Run {
    id: String,
    repo: String,
    legs: HashMap<String, Leg>,
    /// Insertion order, so a snapshot's leg list matches the order the
    /// frontend launched them in rather than a hashmap's.
    leg_order: Vec<String>,
}

impl Run {
    fn snapshot(&self) -> RunSnapshot {
        RunSnapshot {
            id: self.id.clone(),
            repo: self.repo.clone(),
            legs: self
                .leg_order
                .iter()
                .filter_map(|id| self.legs.get(id))
                .map(Leg::snapshot)
                .collect(),
        }
    }
}

/// What a command hands back: the run's current state, in the shape the
/// frontend's `RunLeg`/`FanoutRun` already expect (minus `stat` and
/// `adoptedLegId`, which are frontend-only — see the module header).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub repo: String,
    pub legs: Vec<LegSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegSnapshot {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub command_template: String,
    pub worktree_path: String,
    pub branch: String,
    pub status: LegStatus,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub answer: String,
    pub error: Option<String>,
}

/// One message on a run's subscription channel.
///
/// `Snapshot` is sent exactly once, immediately on subscribe, and carries
/// every leg's full state including its buffered answer — the replay. Every
/// message after it is incremental and only meaningful layered on top of that
/// snapshot, which is why a subscriber that missed the snapshot (there is no
/// public way to do that — see `fanout_subscribe`) must not render partial
/// `Chunk`s as if they were the whole answer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "event", content = "data")]
pub enum FanoutEvent {
    Snapshot { run: RunSnapshot },
    Chunk { leg_id: String, text: String },
    LegStatus { leg: LegSnapshot },
}

// ── State ────────────────────────────────────────────────────────────────────

struct Subscribers {
    channels: Mutex<Vec<Channel<FanoutEvent>>>,
}

impl Default for Subscribers {
    fn default() -> Self {
        Self { channels: Mutex::new(Vec::new()) }
    }
}

impl Subscribers {
    /// Broadcast to every live subscriber, dropping any whose send failed —
    /// that is a webview that is gone, and a dead channel kept around would
    /// grow this list forever across a long session of reconnects.
    fn broadcast(&self, event: &FanoutEvent) {
        let mut channels = self.channels.lock().unwrap_or_else(PoisonError::into_inner);
        channels.retain(|ch| ch.send(event.clone()).is_ok());
    }
}

struct Inner {
    runs: DashMap<String, Arc<Mutex<Run>>>,
    subscribers: DashMap<String, Subscribers>,
}

/// Managed Tauri state. Cheap to clone (one `Arc`), which is what lets a
/// per-leg background task carry its own handle into a `'static` future
/// without borrowing from a command's `State<'_, _>`.
#[derive(Clone)]
pub struct FanoutState(Arc<Inner>);

impl Default for FanoutState {
    fn default() -> Self {
        Self(Arc::new(Inner {
            runs: DashMap::new(),
            subscribers: DashMap::new(),
        }))
    }
}

impl FanoutState {
    fn run(&self, run_id: &str) -> Option<Arc<Mutex<Run>>> {
        self.0.runs.get(run_id).map(|e| e.clone())
    }

    fn broadcast(&self, run_id: &str, event: FanoutEvent) {
        if let Some(subs) = self.0.subscribers.get(run_id) {
            subs.broadcast(&event);
        }
    }
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() > max {
        let truncated: String = line.chars().take(max.saturating_sub(1)).collect();
        format!("{truncated}…")
    } else {
        line.to_string()
    }
}

// ── Running a leg ────────────────────────────────────────────────────────────

/// Update one leg's status/timestamps/error under the run's lock and
/// broadcast the resulting snapshot. The lock is never held across the
/// broadcast — `Subscribers::broadcast` calls into a channel's send, which
/// must not be inside the same critical section every other leg of this run
/// needs to update its own status.
fn set_leg_status(
    state: &FanoutState,
    run: &Arc<Mutex<Run>>,
    run_id: &str,
    leg_id: &str,
    status: LegStatus,
    started_at: Option<i64>,
    ended_at: Option<i64>,
    error: Option<String>,
) {
    let snapshot = {
        let mut run = run.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(leg) = run.legs.get_mut(leg_id) else { return };
        leg.status = status;
        if started_at.is_some() {
            leg.started_at = started_at;
        }
        if ended_at.is_some() {
            leg.ended_at = ended_at;
        }
        if error.is_some() {
            leg.error = error;
        }
        leg.snapshot()
    };
    state.broadcast(run_id, FanoutEvent::LegStatus { leg: snapshot });
}

fn leg_event(kind: &str, run_id: &str, input: &LegInput, summary: String) -> NewEvent {
    NewEvent {
        kind: kind.to_string(),
        actor: Actor::Agent,
        actor_name: Some(input.agent_name.clone()),
        repo: None,
        workspace: None,
        subject: Some(input.branch.clone()),
        summary,
        data: serde_json::json!({
            "runId": run_id, "legId": input.id, "branch": input.branch, "worktree": input.worktree_path,
        }),
    }
}

/// Create the leg's worktree, run its turn, and drive it to a terminal
/// status. Spawned once per leg by `fanout_start_run` and never awaited by
/// it — this is the whole point: the future driving a leg is anchored to the
/// Tauri async runtime (the app), not to any command invocation (the
/// webview).
async fn run_leg(
    recorder: Recorder,
    state: FanoutState,
    git_state: GitState,
    run_id: String,
    input: LegInput,
    secret_bindings: Vec<SecretBinding>,
) {
    let Some(run) = state.run(&run_id) else { return };
    let repo = { run.lock().unwrap_or_else(PoisonError::into_inner).repo.clone() };

    set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Preparing, Some(now_millis()), None, None);

    // Worktree creation touches the object store, so it takes the same
    // per-repo lock every other git command does — a leg racing a manual
    // `git worktree add` in the same repository is exactly the corruption
    // `blocking_git!` exists to prevent, and this module is not exempt from
    // that just because it is not itself a `#[tauri::command]` body.
    let repo_lock = git_state.repo_lock(&repo);
    let worktree_repo = repo.clone();
    let branch = input.branch.clone();
    let worktree_path = input.worktree_path.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        let _guard = repo_lock.lock().unwrap_or_else(PoisonError::into_inner);
        crate::git::worktree::git_add_worktree_impl(worktree_repo, worktree_path, Some(branch), true)
    })
    .await;

    let created = match created {
        Ok(inner) => inner,
        Err(e) => Err(e.to_string()),
    };

    if let Err(error) = created {
        let ended_at = now_millis();
        set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Failed, None, Some(ended_at), Some(error.clone()));
        recorder(leg_event(
            "run.leg.failed",
            &run_id,
            &input,
            format!(
                "{} failed on “{}” — could not create a worktree: {}",
                input.agent_name,
                first_line(&input.prompt, 60),
                error
            ),
        ));
        return;
    }

    set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Running, None, None, None);

    // The buffering channel. Every chunk lands in `Leg::answer` (the replay
    // buffer) *and* goes out to any live subscriber, in that order, so a
    // subscriber that attaches between two chunks never sees a gap — the
    // snapshot it would have gotten on `fanout_subscribe` already has
    // everything up to the chunk it then starts receiving live.
    let chunk_state = state.clone();
    let chunk_run = run.clone();
    let chunk_run_id = run_id.clone();
    let chunk_leg_id = input.id.clone();
    let on_event: Channel<AgentStreamEvent> = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(json) = &body {
            if let Ok(AgentStreamEvent::Chunk { text }) = serde_json::from_str::<AgentStreamEvent>(json) {
                {
                    let mut r = chunk_run.lock().unwrap_or_else(PoisonError::into_inner);
                    if let Some(leg) = r.legs.get_mut(&chunk_leg_id) {
                        leg.answer.push_str(&text);
                    }
                }
                chunk_state.broadcast(&chunk_run_id, FanoutEvent::Chunk { leg_id: chunk_leg_id.clone(), text });
            }
            // Stderr is deliberately dropped here, matching the pre-move
            // behaviour: the old TS `runLeg` never wired `onStderr` either.
            // The stderr tail still populates a failed leg's `error` —
            // `agent::run_turn` folds it into the `Err` this function's
            // caller sees below.
        }
        Ok(())
    });

    let turn_result = agent::agent_stream_query(
        input.worktree_path.clone(),
        input.command_template.clone(),
        input.prompt.clone(),
        secret_bindings,
        // The leg id *is* the turn id: legs and turns are the same concept
        // here, and giving them one id is what lets `fanout_cancel_leg` reuse
        // `agent::agent_cancel_turn` verbatim.
        input.id.clone(),
        Some(input.agent_name.clone()),
        on_event,
    )
    .await;

    let ended_at = now_millis();
    match turn_result {
        Ok(result) if result.cancelled => {
            set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Cancelled, None, Some(ended_at), None);
            recorder(leg_event(
                "run.leg.cancelled",
                &run_id,
                &input,
                format!("{} cancelled on “{}” — was stopped", input.agent_name, first_line(&input.prompt, 60)),
            ));
        }
        Ok(_) => {
            set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Finished, None, Some(ended_at), None);
            recorder(leg_event(
                "run.leg.finished",
                &run_id,
                &input,
                format!("{} finished on “{}”", input.agent_name, first_line(&input.prompt, 60)),
            ));
        }
        Err(error) => {
            set_leg_status(&state, &run, &run_id, &input.id, LegStatus::Failed, None, Some(ended_at), Some(error.clone()));
            recorder(leg_event(
                "run.leg.failed",
                &run_id,
                &input,
                format!("{} failed on “{}” — {}", input.agent_name, first_line(&input.prompt, 60), first_line(&error, 120)),
            ));
        }
    }
}

/// Register a run and spawn every leg. Shared by the `#[tauri::command]`
/// entry point and the unit tests below, which supply a `Recorder` that does
/// not need a live `AppHandle` — see the module header.
async fn start_run(
    recorder: Recorder,
    state: FanoutState,
    git_state: GitState,
    run_id: String,
    repo: String,
    prompt: String,
    legs: Vec<LegInput>,
    secret_bindings: Vec<SecretBinding>,
) -> Result<RunSnapshot, String> {
    if legs.is_empty() {
        return Err("A run needs at least one leg.".to_string());
    }

    let run = Run {
        id: run_id.clone(),
        repo: repo.clone(),
        legs: legs
            .iter()
            .map(|l| {
                (
                    l.id.clone(),
                    Leg {
                        id: l.id.clone(),
                        agent_id: l.agent_id.clone(),
                        agent_name: l.agent_name.clone(),
                        command_template: l.command_template.clone(),
                        worktree_path: l.worktree_path.clone(),
                        branch: l.branch.clone(),
                        status: LegStatus::Pending,
                        started_at: None,
                        ended_at: None,
                        answer: String::new(),
                        error: None,
                    },
                )
            })
            .collect(),
        leg_order: legs.iter().map(|l| l.id.clone()).collect(),
    };
    let snapshot = run.snapshot();

    // Reserve the id atomically, before any leg is touched — a duplicate
    // `run_id` (a double-fired call) must not register two supervisors for
    // one run, the same discipline `agent_stream_query` applies to `turn_id`.
    match state.0.runs.entry(run_id.clone()) {
        Entry::Occupied(_) => return Err("A run with this id is already registered.".to_string()),
        Entry::Vacant(slot) => {
            slot.insert(Arc::new(Mutex::new(run)));
        }
    }
    state.0.subscribers.entry(run_id.clone()).or_default();

    recorder(NewEvent {
        kind: "run.started".to_string(),
        actor: Actor::User,
        actor_name: None,
        repo: Some(repo.clone()),
        workspace: None,
        subject: Some(prompt.clone()),
        summary: format!(
            "Fanned “{}” out to {} agent{}",
            first_line(&prompt, 60),
            legs.len(),
            if legs.len() == 1 { "" } else { "s" }
        ),
        data: serde_json::json!({
            "runId": run_id,
            "legs": legs.iter().map(|l| serde_json::json!({"agent": l.agent_name, "branch": l.branch})).collect::<Vec<_>>(),
        }),
    });

    for input in legs {
        let recorder = recorder.clone();
        let state_inner = state.clone();
        let git_state_inner = git_state.clone();
        let run_id = run_id.clone();
        let secret_bindings = secret_bindings.clone();
        tauri::async_runtime::spawn(async move {
            run_leg(recorder, state_inner, git_state_inner, run_id, input, secret_bindings).await;
        });
    }

    Ok(snapshot)
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// Start a run: register it, record `run.started`, and spawn every leg as an
/// independent background task. Returns as soon as the run is registered —
/// **not** when every leg finishes, unlike the TS orchestration this
/// replaces. That is not a smaller guarantee, it is the fix: a caller that
/// awaited "every leg done" was a caller that could not return control to the
/// user (or close its window) until the slowest agent finished, which is
/// backwards for a feature whose entire premise is "leave this running and
/// come back".
#[tauri::command]
pub async fn fanout_start_run(
    app: AppHandle,
    state: State<'_, FanoutState>,
    git_state: State<'_, GitState>,
    run_id: String,
    repo: String,
    prompt: String,
    legs: Vec<LegInput>,
    secret_bindings: Vec<SecretBinding>,
) -> Result<RunSnapshot, String> {
    start_run(
        real_recorder(app),
        state.inner().clone(),
        git_state.inner().clone(),
        run_id,
        repo,
        prompt,
        legs,
        secret_bindings,
    )
    .await
}

/// Cancel one leg. Reuses `agent::agent_cancel_turn` — see the module header
/// for why a leg's turn id is its own id. `Ok(false)` for a leg that already
/// ended is not an error, matching the turn-level command: the race between a
/// user's click and a leg finishing on its own is the ordinary case.
#[tauri::command]
pub async fn fanout_cancel_leg(leg_id: String) -> Result<bool, String> {
    agent::agent_cancel_turn(leg_id).await
}

/// What is running right now, in this repository. The reconnect entry point:
/// a webview that (re)appears calls this before anything else to learn
/// whether any of the runs it has in `localStorage` are still supervised —
/// and for the ones that are, follows up with `fanout_subscribe`. A run
/// absent from this list has no supervisor behind it (this process never
/// started it, or started it before an app restart), and the frontend's
/// answer to "what happened to it" is exactly what it was before this module
/// existed: `interrupted`.
#[tauri::command]
pub fn fanout_run_state(state: State<'_, FanoutState>, repo: String) -> Vec<RunSnapshot> {
    run_state(state.inner().clone(), repo)
}

fn run_state(state: FanoutState, repo: String) -> Vec<RunSnapshot> {
    state
        .0
        .runs
        .iter()
        .map(|e| e.value().lock().unwrap_or_else(PoisonError::into_inner).snapshot())
        .filter(|s| s.repo == repo)
        .collect()
}

/// Attach to a run's live output. Sends the full current state once, as
/// `FanoutEvent::Snapshot` — the replay of everything produced so far,
/// including while no window was listening — then registers the channel for
/// every event from here on. See the module header for why this is a replay
/// and not a drop.
///
/// Errs for a run id this process has no record of, which the frontend must
/// read the same way as an absence from `fanout_run_state`: not supervised,
/// not "still catching up".
#[tauri::command]
pub fn fanout_subscribe(
    state: State<'_, FanoutState>,
    run_id: String,
    on_event: Channel<FanoutEvent>,
) -> Result<(), String> {
    subscribe(state.inner().clone(), run_id, on_event)
}

fn subscribe(state: FanoutState, run_id: String, on_event: Channel<FanoutEvent>) -> Result<(), String> {
    let Some(run) = state.run(&run_id) else {
        return Err("No supervised run with this id.".to_string());
    };
    let snapshot = run.lock().unwrap_or_else(PoisonError::into_inner).snapshot();
    on_event
        .send(FanoutEvent::Snapshot { run: snapshot })
        .map_err(|e| e.to_string())?;
    state
        .0
        .subscribers
        .entry(run_id)
        .or_default()
        .channels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(on_event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn leg_input(id: &str, worktree: &str) -> LegInput {
        LegInput {
            id: id.to_string(),
            agent_id: "a".to_string(),
            agent_name: "Agent".to_string(),
            command_template: "cat".to_string(),
            branch: format!("fanout/test/{id}"),
            worktree_path: worktree.to_string(),
            prompt: "do the thing".to_string(),
        }
    }

    /// A recorder that pushes into a shared `Vec` instead of touching a live
    /// `AppHandle`, so the journal-integration property — every terminal
    /// transition reaches the log — is checkable without `tauri::test`.
    fn recording_recorder() -> (Recorder, Arc<Mutex<Vec<NewEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let recorder: Recorder = Arc::new(move |e| sink.lock().unwrap().push(e));
        (recorder, events)
    }

    fn null_recorder() -> Recorder {
        Arc::new(|_| {})
    }

    fn snapshot_of(state: &FanoutState, run_id: &str) -> RunSnapshot {
        state.run(run_id).unwrap().lock().unwrap().snapshot()
    }

    /// Confirms `LegStatus` never assigns itself the frontend's `interrupted`
    /// concept — the supervisor either knows the true terminal state or has
    /// no record of the run at all, with nothing in between.
    #[test]
    fn leg_status_has_no_interrupted_variant() {
        let s = serde_json::to_string(&LegStatus::Finished).unwrap();
        assert_eq!(s, "\"finished\"");
        // Compile-time: this match has no `Interrupted` arm to omit, so
        // adding one anywhere in this module would fail to build until every
        // match here is updated too.
        let _: &str = match LegStatus::Pending {
            LegStatus::Pending => "pending",
            LegStatus::Preparing => "preparing",
            LegStatus::Running => "running",
            LegStatus::Finished => "finished",
            LegStatus::Failed => "failed",
            LegStatus::Cancelled => "cancelled",
        };
    }

    #[test]
    fn a_run_absent_from_state_cannot_be_subscribed_to() {
        let state = FanoutState::default();
        let ch = Channel::new(|_| Ok(()));
        let err = subscribe(state, "no-such-run".to_string(), ch)
            .expect_err("subscribing to an unknown run must fail, not fake a snapshot");
        assert!(err.contains("No supervised run"));
    }

    #[test]
    fn starting_a_run_with_no_legs_is_rejected() {
        let state = FanoutState::default();
        let git_state = GitState::new();
        let err = tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state,
            git_state,
            "r".to_string(),
            "/repo".to_string(),
            "x".to_string(),
            Vec::new(),
            Vec::new(),
        ))
        .expect_err("a run with no legs must be rejected before anything is registered");
        assert!(err.contains("at least one leg"));
    }

    #[test]
    fn a_duplicate_run_id_is_rejected() {
        let state = FanoutState::default();
        let git_state = GitState::new();
        let input = leg_input("leg", "/does/not/matter/for/this/check");
        tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state.clone(),
            git_state.clone(),
            "dup".to_string(),
            "/repo".to_string(),
            "x".to_string(),
            vec![input.clone()],
            Vec::new(),
        ))
        .expect("first registration must succeed");

        let err = tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state,
            git_state,
            "dup".to_string(),
            "/repo".to_string(),
            "x".to_string(),
            vec![input],
            Vec::new(),
        ))
        .expect_err("a second run under the same id must be rejected");
        assert!(err.contains("already registered"));
    }

    #[test]
    fn fanout_run_state_only_lists_runs_for_the_requested_repo() {
        let state = FanoutState::default();
        state.0.runs.insert(
            "a".to_string(),
            Arc::new(Mutex::new(Run { id: "a".to_string(), repo: "/repos/one".to_string(), legs: HashMap::new(), leg_order: Vec::new() })),
        );
        state.0.runs.insert(
            "b".to_string(),
            Arc::new(Mutex::new(Run { id: "b".to_string(), repo: "/repos/two".to_string(), legs: HashMap::new(), leg_order: Vec::new() })),
        );

        let listed = run_state(state, "/repos/one".to_string());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "a");
    }

    /// The end-to-end path: start a run with a real (fast) process, watch it
    /// go pending → preparing → running → finished, see the worktree actually
    /// appear on disk, and see both journal events land — `run.started` and
    /// `run.leg.finished`.
    #[cfg(unix)]
    #[test]
    fn a_leg_creates_its_worktree_streams_to_completion_and_journals_both_ends() {
        let tmp = tempfile_dir();
        let repo = init_repo(&tmp);
        let worktree_path = format!("{}/leg-a", tmp.to_string_lossy());

        let state = FanoutState::default();
        let git_state = GitState::new();
        let (recorder, events) = recording_recorder();
        let run_id = "run-1".to_string();

        tauri::async_runtime::block_on(start_run(
            recorder,
            state.clone(),
            git_state,
            run_id.clone(),
            repo,
            "do the thing".to_string(),
            vec![leg_input("leg-1", &worktree_path)],
            Vec::new(),
        ))
        .expect("run must start");

        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs[0].status == LegStatus::Finished),
            "leg never reached finished"
        );

        let leg = &snapshot_of(&state, &run_id).legs[0];
        assert_eq!(leg.answer, "do the thing");
        assert!(std::path::Path::new(&worktree_path).exists());

        let kinds: Vec<String> = events.lock().unwrap().iter().map(|e| e.kind.clone()).collect();
        assert_eq!(kinds, vec!["run.started", "run.leg.finished"]);
    }

    /// A worktree failure fails only that leg — the whole reason legs are
    /// independent tasks rather than a sequential loop.
    #[cfg(unix)]
    #[test]
    fn a_worktree_failure_fails_only_that_leg() {
        let tmp = tempfile_dir();
        let repo = init_repo(&tmp);
        // Pre-create the target path so `git worktree add` refuses it.
        let blocked_path = format!("{}/blocked", tmp.to_string_lossy());
        std::fs::create_dir_all(&blocked_path).unwrap();
        let ok_path = format!("{}/ok", tmp.to_string_lossy());

        let state = FanoutState::default();
        let git_state = GitState::new();
        let run_id = "run-2".to_string();

        tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state.clone(),
            git_state,
            run_id.clone(),
            repo,
            "x".to_string(),
            vec![leg_input("blocked-leg", &blocked_path), leg_input("ok-leg", &ok_path)],
            Vec::new(),
        ))
        .unwrap();

        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs.iter().all(|l| l.status.is_done())),
            "both legs never reached a terminal status"
        );

        let snap = snapshot_of(&state, &run_id);
        let blocked = snap.legs.iter().find(|l| l.id == "blocked-leg").unwrap();
        let ok = snap.legs.iter().find(|l| l.id == "ok-leg").unwrap();
        assert_eq!(blocked.status, LegStatus::Failed);
        assert!(blocked.error.as_deref().unwrap_or_default().contains("already exists"));
        assert_eq!(ok.status, LegStatus::Finished);
    }

    /// `fanout_cancel_leg` reuses `agent::agent_cancel_turn`, so cancelling a
    /// leg mid-stream must stop it — and only it, matching the fan-out
    /// premise that one leg's fate does not touch the others.
    #[cfg(unix)]
    #[test]
    fn cancelling_a_leg_stops_only_that_leg() {
        let tmp = tempfile_dir();
        let repo = init_repo(&tmp);
        let cancelled_path = format!("{}/cancelled", tmp.to_string_lossy());
        let finishes_path = format!("{}/finishes", tmp.to_string_lossy());

        let state = FanoutState::default();
        let git_state = GitState::new();
        let run_id = "run-4".to_string();

        let mut sleepy = leg_input("cancelled-leg", &cancelled_path);
        sleepy.command_template = "sleep 30".to_string();

        tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state.clone(),
            git_state,
            run_id.clone(),
            repo,
            "x".to_string(),
            vec![sleepy, leg_input("finishing-leg", &finishes_path)],
            Vec::new(),
        ))
        .unwrap();

        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs.iter().find(|l| l.id == "cancelled-leg").is_some_and(|l| l.status == LegStatus::Running)),
            "the sleeping leg never reached running"
        );
        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs.iter().find(|l| l.id == "finishing-leg").is_some_and(|l| l.status == LegStatus::Finished)),
            "the fast leg never finished on its own"
        );

        assert!(tauri::async_runtime::block_on(fanout_cancel_leg("cancelled-leg".to_string())).unwrap());

        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs.iter().find(|l| l.id == "cancelled-leg").is_some_and(|l| l.status == LegStatus::Cancelled)),
            "the sleeping leg never reached cancelled"
        );
    }

    /// `fanout_subscribe` replays the full buffered answer before anything
    /// live — the property the whole "buffered and replayed" design rests on,
    /// and the case that matters most: a window opening *after* the one that
    /// started the run is long gone.
    #[cfg(unix)]
    #[test]
    fn subscribing_after_the_fact_replays_the_full_answer_in_one_message() {
        let tmp = tempfile_dir();
        let repo = init_repo(&tmp);
        let worktree_path = format!("{}/leg-replay", tmp.to_string_lossy());

        let state = FanoutState::default();
        let git_state = GitState::new();
        let run_id = "run-3".to_string();

        tauri::async_runtime::block_on(start_run(
            null_recorder(),
            state.clone(),
            git_state,
            run_id.clone(),
            repo,
            "x".to_string(),
            vec![leg_input("leg-replay", &worktree_path)],
            Vec::new(),
        ))
        .unwrap();

        assert!(
            wait_until(|| snapshot_of(&state, &run_id).legs[0].status == LegStatus::Finished),
            "leg never finished before the subscribe test could run"
        );

        // Subscribe only *after* the leg is already done — simulating a
        // window that opens long after the one that started the run is gone.
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = received.clone();
        let ch = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = &body {
                sink.lock().unwrap().push(json.clone());
            }
            Ok(())
        });
        subscribe(state, run_id, ch).unwrap();

        let bodies = received.lock().unwrap();
        assert_eq!(bodies.len(), 1, "exactly one message: the snapshot, nothing live after it");
        let value: serde_json::Value = serde_json::from_str(&bodies[0]).unwrap();
        assert_eq!(value["event"], "snapshot");
        assert_eq!(value["data"]["run"]["legs"][0]["answer"], "do the thing");
        assert_eq!(value["data"]["run"]["legs"][0]["status"], "finished");
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("voidlink-fanout-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A minimal git repo with one commit, so `git worktree add` has a HEAD
    /// to branch from.
    fn init_repo(dir: &std::path::Path) -> String {
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t.co")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t.co")
                .status()
                .expect("git must be on PATH for this test");
            assert!(status.success(), "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        std::fs::write(repo.join("README.md"), "x").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        repo.to_string_lossy().to_string()
    }
}
