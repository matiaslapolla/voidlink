//! OS notifications and sound cues — a **policy over the event log**, not a
//! call site.
//!
//! ## Why Rust dispatches, and not the webviews
//!
//! The same argument that put the journal here, only more visible. Three
//! windows share one origin, so three webviews reacting to one
//! `journal-appended` broadcast produce three OS notifications for one commit.
//! Rust holds the log, Rust knows which windows have focus, and Rust is the only
//! place where "notify once" is even expressible.
//!
//! The consequence worth stating: **no feature calls `notify()`**. The notifier
//! subscribes to `journal::append`, matches event kinds against the user's
//! rules, and decides. That is what keeps the forty-first call site from being
//! the one that forgets — there is no call site.
//!
//! It also means the capability files grant **no** `notification:*` permission
//! to any webview, and that absence is the enforcement of this decision rather
//! than an oversight. Each file says so in its `description`.
//!
//! ## The four rules
//!
//! Every one of them is a pure function of `(event, state, config)`, tested in
//! this module. That shape is deliberate and is the same one `journal::select`
//! has, for the same reason: the interesting failures here are all "it notified
//! when it shouldn't have", which is only cheap to test when the decision does
//! not require a windowing system.
//!
//! 1. **Match.** By `kind` *prefix*, never by enumeration. Track B keeps adding
//!    event families (`run.`, `review.`, `hill.`) and a matrix that switched on
//!    a closed set would silently stop covering them — the same
//!    forward-compatibility argument that makes the timeline render `summary`
//!    and never switch on `kind`.
//! 2. **Suppress what the user is already watching.** If a window has focus and
//!    the surface the event belongs to is on screen, a banner is noise. The
//!    frontend already computes "what is visible" for activity escalation, so
//!    it publishes that set here rather than growing a second notion of it.
//! 3. **Coalesce.** Five events in two seconds is one notification with a
//!    summary body. Per (kind-family, repo), because that is the grain at which
//!    a burst is one piece of news.
//! 4. **Quiet hours and mute.** Both plain config.
//!
//! ## Permission
//!
//! Requested **lazily**, the first time a rule would actually fire — never at
//! launch. A permission prompt during startup, before the user has done
//! anything that could produce a notification, is a prompt with no context, and
//! the honest answer to it is "no". If it is denied we degrade to the in-app
//! activity LED and never ask again this session.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::journal::Event;

pub mod sound;

/// How loudly one event family may interrupt.
///
/// Ordered: a rule may be raised to a louder level by a more specific match but
/// never lowered below `Silent`, so "off" always wins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Nothing. The in-app activity mark still renders — this governs the OS
    /// channel only.
    Silent,
    /// A sound cue, no banner. For "you are at the machine and something
    /// finished".
    Sound,
    /// An OS banner, whose own sound the platform decides. See `sound.rs` for
    /// why a banner's sound is never played by us.
    Banner,
    /// Banner and a cue. Reserved for failures.
    Both,
}

impl Level {
    pub fn wants_banner(self) -> bool {
        matches!(self, Level::Banner | Level::Both)
    }
    pub fn wants_sound(self) -> bool {
        matches!(self, Level::Sound | Level::Both)
    }
}

/// One row of the matrix: an event-kind **prefix**, and how loud it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// Matched with `starts_with`. `"agent."` catches every agent event;
    /// `"agent.turn.failed"` catches exactly one. Longest match wins, so a
    /// specific row can override a family row without ordering rules.
    pub prefix: String,
    pub level: Level,
}

/// The user's notification settings. Serialised into the settings blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Off entirely. The switch that has to be reachable without the palette.
    pub muted: bool,
    /// Local hours \[start, end) during which nothing is dispatched. `(22, 8)`
    /// wraps midnight, which is the common case and therefore the one that has
    /// to work.
    pub quiet_hours: Option<(u32, u32)>,
    pub rules: Vec<Rule>,
    /// Coalescing window.
    pub coalesce_ms: u64,
    pub volume: f32,
    /// Which sound pack. See `sound::Pack`.
    pub pack: String,
}

impl Default for Config {
    /// Small and defensible.
    ///
    /// The load-bearing omission is **commits**. A notification per commit is
    /// how someone turns notifications off entirely, and then loses the one for
    /// the agent that failed at 3am — which is the whole reason this exists.
    /// Everything here is either an unattended outcome or a state the user has
    /// to resolve before work can continue.
    fn default() -> Self {
        Self {
            muted: false,
            quiet_hours: None,
            rules: vec![
                Rule { prefix: "agent.turn.failed".into(), level: Level::Both },
                Rule { prefix: "agent.turn.finished".into(), level: Level::Banner },
                Rule { prefix: "run.leg.failed".into(), level: Level::Both },
                Rule { prefix: "run.finished".into(), level: Level::Banner },
                Rule { prefix: "trigger.fired".into(), level: Level::Sound },
                Rule { prefix: "git.conflict".into(), level: Level::Both },
                Rule { prefix: "git.operation".into(), level: Level::Banner },
                Rule { prefix: "terminal.command.failed".into(), level: Level::Both },
            ],
            coalesce_ms: 2_000,
            volume: 0.6,
            pack: sound::DEFAULT_PACK.into(),
        }
    }
}

/// What the notifier knows about the moment an event arrives, so every rule can
/// stay a pure function.
#[derive(Debug, Clone, Default)]
pub struct Watching {
    /// Any OS window of ours has focus.
    pub window_focused: bool,
    /// The repositories on screen in the focused window.
    ///
    /// Derived by the frontend from the same visible-tab set that drives
    /// activity escalation (`setVisibleTabs`), so "the user is looking at this"
    /// means one thing in this app rather than two. Repositories rather than tab
    /// ids because an event carries a repo, and doing the join here would mean
    /// Rust holding a second copy of the tab→repo mapping that the layout store
    /// already owns.
    pub visible_repos: Vec<String>,
}

/// What the dispatcher should do about one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Say nothing, and why — kept rather than collapsed to a bool because
    /// "muted" and "you are looking at it" are different answers, and the one
    /// support question this feature will generate is "why didn't it tell me".
    Skip(Skip),
    /// Notify, at this level.
    Notify(Level),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Muted,
    QuietHours,
    NoRule,
    RuleSilent,
    AlreadyWatching,
    Coalesced,
}

/// Longest-prefix match. `None` when no rule covers the kind.
///
/// Longest rather than first so a specific override does not depend on where
/// the user happened to add it in the list — a matrix whose behaviour changes
/// when you reorder rows is a matrix nobody can reason about.
pub fn match_rule<'a>(rules: &'a [Rule], kind: &str) -> Option<&'a Rule> {
    rules
        .iter()
        .filter(|r| kind.starts_with(&r.prefix))
        .max_by_key(|r| r.prefix.len())
}

/// Is `hour` inside the quiet window? Handles the wrapping case.
pub fn in_quiet_hours(quiet: Option<(u32, u32)>, hour: u32) -> bool {
    match quiet {
        None => false,
        Some((start, end)) if start == end => false,
        Some((start, end)) if start < end => hour >= start && hour < end,
        // Wraps midnight: 22..8 is "at or after 22, or before 8".
        Some((start, end)) => hour >= start || hour < end,
    }
}

/// Is the user already looking at what this event is about?
///
/// Requires **both** window focus and the event's repository being on screen. On
/// screen in a window you have alt-tabbed away from is not being watched — the
/// exact case §7.5.3 exists for, and the same distinction `activity.ts` draws
/// between `visible` and `windowFocused`.
///
/// An event with no repository (a run, a trigger) is never suppressed this way:
/// there is no surface it can be said to be "on".
pub fn already_watching(event: &Event, watching: &Watching) -> bool {
    if !watching.window_focused {
        return false;
    }
    match event.repo.as_deref() {
        None => false,
        Some(repo) => watching.visible_repos.iter().any(|r| r == repo),
    }
}

/// The coalescing key: the event's kind **family** plus its repository.
///
/// The family rather than the full kind, because a burst is usually one
/// operation producing several neighbouring kinds — `run.leg.finished` four
/// times then `run.finished` is one piece of news, not two.
pub fn coalesce_key(event: &Event) -> String {
    let family = event.kind.split('.').next().unwrap_or(&event.kind);
    format!("{family}|{}", event.repo.as_deref().unwrap_or(""))
}

/// The whole decision, pure.
///
/// `last_at` is when this coalescing key last produced a notification, and
/// `now` / `hour` are supplied rather than read so the tests do not need a
/// clock.
pub fn decide(
    event: &Event,
    config: &Config,
    watching: &Watching,
    last_at: Option<u64>,
    now: u64,
    hour: u32,
) -> Decision {
    if config.muted {
        return Decision::Skip(Skip::Muted);
    }
    if in_quiet_hours(config.quiet_hours, hour) {
        return Decision::Skip(Skip::QuietHours);
    }
    let Some(rule) = match_rule(&config.rules, &event.kind) else {
        return Decision::Skip(Skip::NoRule);
    };
    if rule.level == Level::Silent {
        return Decision::Skip(Skip::RuleSilent);
    }
    if already_watching(event, watching) {
        return Decision::Skip(Skip::AlreadyWatching);
    }
    if let Some(last) = last_at {
        if now.saturating_sub(last) < config.coalesce_ms {
            return Decision::Skip(Skip::Coalesced);
        }
    }
    Decision::Notify(rule.level)
}

// ── The stateful half ────────────────────────────────────────────────────────

/// Everything mutable the notifier owns. One `Mutex`, held only across map
/// lookups — never across a `show()`, which can block on the platform.
#[derive(Default)]
struct Inner {
    config: Config,
    watching: Watching,
    /// Coalescing key → when it last fired.
    last: HashMap<String, u64>,
    /// How many events a still-open coalescing window has swallowed, so the
    /// body can say "and 4 more" rather than dropping them silently.
    pending: HashMap<String, u32>,
    /// `None` until we have asked. `Some(false)` means denied — we degrade to
    /// the in-app mark and never ask again this session.
    permission: Option<bool>,
}

pub struct NotifyState(Mutex<Inner>);

impl NotifyState {
    pub fn new() -> Self {
        Self(Mutex::new(Inner {
            config: Config::default(),
            ..Default::default()
        }))
    }
}

impl Default for NotifyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Install. Called from the builder's `setup`.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(NotifyState::new());
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn local_hour() -> u32 {
    // Deliberately crude: hours since the epoch, modulo 24, offset by nothing.
    // Replacing this with a real timezone conversion means a `chrono`/`time`
    // dependency for one integer. Recorded rather than papered over — quiet
    // hours are UTC until that trade looks worth making, and the setting is
    // labelled as such in the UI.
    ((now_millis() / 3_600_000) % 24) as u32
}

/// Publish what the user can see. Called by the frontend from the same effect
/// that feeds `setVisibleTabs`.
#[tauri::command]
pub fn notify_visible<R: Runtime>(app: AppHandle<R>, repos: Vec<String>, focused: bool) {
    let state = app.state::<NotifyState>();
    let mut inner = state.0.lock().unwrap();
    inner.watching = Watching {
        window_focused: focused,
        visible_repos: repos,
    };
}

#[tauri::command]
pub fn notify_config<R: Runtime>(app: AppHandle<R>) -> Config {
    app.state::<NotifyState>().0.lock().unwrap().config.clone()
}

/// Play one cue at the current settings, for the Test button.
///
/// Goes through `sound::play` rather than a preview path, so what the user hears
/// is the thing itself — a volume slider whose preview is louder or quieter than
/// the real cue is worse than no preview.
#[tauri::command]
pub fn notify_test_cue<R: Runtime>(app: AppHandle<R>) {
    let (volume, pack) = {
        let state = app.state::<NotifyState>();
        let inner = state.0.lock().unwrap();
        (inner.config.volume, inner.config.pack.clone())
    };
    sound::play(&pack, sound::Cue::Attention, volume);
}

#[tauri::command]
pub fn notify_set_config<R: Runtime>(app: AppHandle<R>, config: Config) {
    app.state::<NotifyState>().0.lock().unwrap().config = config;
}

/// The entry point `journal::append` calls with every batch it writes.
///
/// Takes the whole batch rather than one event so coalescing sees a burst as a
/// burst: five events written in one `append` share a timestamp, and deciding
/// them one at a time against a `last` map would let all five through before
/// any of them recorded a firing.
pub fn note(app: &AppHandle, events: &[Event]) {
    if events.is_empty() {
        return;
    }
    let now = now_millis();
    let hour = local_hour();

    // Decisions first, lock released before anything blocks.
    let mut to_show: Vec<(String, String, Level, u32, sound::Cue)> = Vec::new();
    {
        let state = app.state::<NotifyState>();
        let mut inner = state.0.lock().unwrap();
        let config = inner.config.clone();
        let watching = inner.watching.clone();

        for event in events {
            let key = coalesce_key(event);
            let last = inner.last.get(&key).copied();
            match decide(event, &config, &watching, last, now, hour) {
                Decision::Notify(level) => {
                    inner.last.insert(key.clone(), now);
                    let swallowed = inner.pending.remove(&key).unwrap_or(0);
                    to_show.push((
                        notification_title(event),
                        event.summary.clone(),
                        level,
                        swallowed,
                        cue_for(&event.kind),
                    ));
                }
                Decision::Skip(Skip::Coalesced) => {
                    // Counted, not dropped. The next notification for this key
                    // says how many it stands for.
                    *inner.pending.entry(key).or_insert(0) += 1;
                }
                Decision::Skip(_) => {}
            }
        }
    }

    for (title, body, level, swallowed, cue) in to_show {
        let body = if swallowed > 0 {
            format!("{body} (and {swallowed} more)")
        } else {
            body
        };
        dispatch(app, &title, &body, level, cue);
    }
}

/// Which cue an event kind sounds like.
///
/// By prefix, like the rules, and with `Attention` as the floor — a kind this
/// build has never heard of still makes the generic noise rather than being
/// silent. The alternative, matching a closed set, means a new event family
/// added in the frontend silently loses its sound and nobody finds out, which is
/// exactly the failure the whole prefix convention exists to avoid.
pub fn cue_for(kind: &str) -> sound::Cue {
    if kind.starts_with("run.adopted") {
        sound::Cue::RunAdopted
    } else if kind.contains("conflict") {
        sound::Cue::Conflict
    } else if kind.ends_with(".failed") {
        sound::Cue::TurnFailed
    } else if kind.ends_with(".finished") {
        sound::Cue::TurnFinished
    } else {
        sound::Cue::Attention
    }
}

/// A banner's title. The actor if there is one, else the repository's folder
/// name, else the app — never the raw `kind`, which is an internal string that
/// happens to be readable.
fn notification_title(event: &Event) -> String {
    if let Some(name) = event.actor_name.as_deref() {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    if let Some(repo) = event.repo.as_deref() {
        if let Some(folder) = repo.rsplit(['/', '\\']).next() {
            if !folder.is_empty() {
                return folder.to_string();
            }
        }
    }
    "VoidLink".into()
}

/// Show one notification, at one level.
fn dispatch(app: &AppHandle, title: &str, body: &str, level: Level, cue: sound::Cue) {
    let (volume, pack) = {
        let state = app.state::<NotifyState>();
        let inner = state.0.lock().unwrap();
        (inner.config.volume, inner.config.pack.clone())
    };

    if level.wants_banner() && ensure_permission(app) {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            log::warn!("could not show a notification: {e}");
        }
    }
    if level.wants_sound() {
        // Only when there is no banner. A banner brings the platform's own
        // sound, which respects Focus modes and Do Not Disturb; playing ours on
        // top would double it and would ignore both.
        if !level.wants_banner() {
            sound::play(&pack, cue, volume);
        }
    }
}

/// Ask for permission the first time we actually need it, and remember the
/// answer for the session.
fn ensure_permission(app: &AppHandle) -> bool {
    use tauri::plugin::PermissionState;
    use tauri_plugin_notification::NotificationExt;

    let state = app.state::<NotifyState>();
    if let Some(known) = state.0.lock().unwrap().permission {
        return known;
    }

    let granted = match app.notification().permission_state() {
        Ok(PermissionState::Granted) => true,
        // `Prompt` is Tauri 2's name for "we have never asked". This is the one
        // place we ask, and it is reached only because a rule was about to
        // fire — so the prompt arrives with a reason the user can see.
        Ok(PermissionState::Prompt | PermissionState::PromptWithRationale) => matches!(
            app.notification().request_permission(),
            Ok(PermissionState::Granted)
        ),
        _ => false,
    };
    if !granted {
        log::info!("notifications are not permitted; falling back to the in-app activity mark");
    }
    state.0.lock().unwrap().permission = Some(granted);
    granted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::journal::Actor;

    fn event(kind: &str) -> Event {
        Event {
            id: "e1".into(),
            at: 0,
            kind: kind.into(),
            actor: Actor::Agent,
            actor_name: Some("Refactorer".into()),
            repo: Some("/repos/voidlink".into()),
            workspace: None,
            subject: None,
            summary: "something happened".into(),
            data: serde_json::Value::Null,
        }
    }

    fn watching(focused: bool, repos: &[&str]) -> Watching {
        Watching {
            window_focused: focused,
            visible_repos: repos.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn matches_by_prefix_not_by_enumeration() {
        let rules = vec![Rule { prefix: "agent.".into(), level: Level::Banner }];
        // A kind this build has never heard of, in a family it has.
        assert!(match_rule(&rules, "agent.turn.somethingNew").is_some());
        assert!(match_rule(&rules, "git.commit").is_none());
    }

    /// A matrix whose behaviour changes when you reorder rows is one nobody can
    /// reason about.
    #[test]
    fn longest_prefix_wins_regardless_of_order() {
        let rules = vec![
            Rule { prefix: "agent.".into(), level: Level::Banner },
            Rule { prefix: "agent.turn.failed".into(), level: Level::Both },
        ];
        let reversed: Vec<Rule> = rules.iter().rev().cloned().collect();
        assert_eq!(match_rule(&rules, "agent.turn.failed").unwrap().level, Level::Both);
        assert_eq!(match_rule(&reversed, "agent.turn.failed").unwrap().level, Level::Both);
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        assert!(in_quiet_hours(Some((22, 8)), 23));
        assert!(in_quiet_hours(Some((22, 8)), 3));
        assert!(!in_quiet_hours(Some((22, 8)), 12));
        assert!(in_quiet_hours(Some((9, 17)), 12));
        assert!(!in_quiet_hours(Some((9, 17)), 20));
        assert!(!in_quiet_hours(None, 3));
        // A zero-width window is off, not always-on.
        assert!(!in_quiet_hours(Some((5, 5)), 5));
    }

    /// The rule that decides whether this feature is welcome or infuriating.
    #[test]
    fn suppresses_what_the_user_is_looking_at() {
        let e = event("agent.turn.finished");
        assert!(already_watching(&e, &watching(true, &["/repos/voidlink"])));
    }

    /// On screen in a window you have alt-tabbed away from is not being
    /// watched. This is the case the whole escalation model exists for.
    #[test]
    fn an_unfocused_window_is_not_watching() {
        let e = event("agent.turn.finished");
        assert!(!already_watching(&e, &watching(false, &["/repos/voidlink"])));
    }

    #[test]
    fn another_repo_on_screen_does_not_suppress() {
        let e = event("agent.turn.finished");
        assert!(!already_watching(&e, &watching(true, &["/repos/other"])));
    }

    /// A run or a trigger has no repository and therefore no surface it can be
    /// said to be "on" — suppressing it would mean suppressing it always.
    #[test]
    fn an_event_with_no_repo_is_never_suppressed_as_watched() {
        let mut e = event("run.finished");
        e.repo = None;
        assert!(!already_watching(&e, &watching(true, &["/repos/voidlink"])));
    }

    #[test]
    fn coalesces_on_family_and_repo() {
        assert_eq!(coalesce_key(&event("run.leg.finished")), coalesce_key(&event("run.finished")));
        assert_ne!(coalesce_key(&event("run.finished")), coalesce_key(&event("agent.turn.finished")));
    }

    #[test]
    fn mute_beats_everything() {
        let config = Config { muted: true, ..Default::default() };
        let d = decide(&event("agent.turn.failed"), &config, &watching(false, &[]), None, 0, 12);
        assert_eq!(d, Decision::Skip(Skip::Muted));
    }

    #[test]
    fn an_unmatched_kind_says_nothing() {
        let config = Config::default();
        let d = decide(&event("hill.position.moved"), &config, &watching(false, &[]), None, 0, 12);
        assert_eq!(d, Decision::Skip(Skip::NoRule));
    }

    /// The load-bearing omission in the default set. A notification per commit
    /// is how someone turns notifications off entirely — and then loses the one
    /// for the agent that failed at 3am.
    #[test]
    fn commits_do_not_notify_by_default() {
        let config = Config::default();
        let d = decide(&event("git.commit"), &config, &watching(false, &[]), None, 0, 12);
        assert_eq!(d, Decision::Skip(Skip::NoRule));
    }

    #[test]
    fn a_failure_notifies_at_the_loudest_level() {
        let config = Config::default();
        let d = decide(&event("agent.turn.failed"), &config, &watching(false, &[]), None, 0, 12);
        assert_eq!(d, Decision::Notify(Level::Both));
    }

    #[test]
    fn a_second_event_inside_the_window_is_coalesced() {
        let config = Config::default();
        let e = event("agent.turn.failed");
        let d = decide(&e, &config, &watching(false, &[]), Some(1_000), 1_500, 12);
        assert_eq!(d, Decision::Skip(Skip::Coalesced));
    }

    #[test]
    fn the_window_expires() {
        let config = Config::default();
        let e = event("agent.turn.failed");
        let d = decide(&e, &config, &watching(false, &[]), Some(1_000), 9_000, 12);
        assert_eq!(d, Decision::Notify(Level::Both));
    }

    #[test]
    fn a_silent_rule_is_honoured_over_a_family_default() {
        let mut config = Config::default();
        config.rules.push(Rule { prefix: "agent.turn.failed".into(), level: Level::Silent });
        // Two rules of equal length; `max_by_key` keeps the later one, which is
        // the user's override — the default set is seeded first.
        let d = decide(&event("agent.turn.failed"), &config, &watching(false, &[]), None, 0, 12);
        assert_eq!(d, Decision::Skip(Skip::RuleSilent));
    }

    #[test]
    fn titles_prefer_the_actor_then_the_folder() {
        assert_eq!(notification_title(&event("agent.turn.failed")), "Refactorer");
        let mut e = event("git.conflict");
        e.actor_name = None;
        assert_eq!(notification_title(&e), "voidlink");
        e.repo = None;
        assert_eq!(notification_title(&e), "VoidLink");
    }

    /// A kind this build has never heard of still makes a noise. Silence for an
    /// unknown kind is the failure the prefix convention exists to avoid.
    #[test]
    fn every_kind_maps_to_some_cue() {
        assert_eq!(cue_for("run.adopted"), sound::Cue::RunAdopted);
        assert_eq!(cue_for("git.conflict.entered"), sound::Cue::Conflict);
        assert_eq!(cue_for("agent.turn.failed"), sound::Cue::TurnFailed);
        assert_eq!(cue_for("agent.turn.finished"), sound::Cue::TurnFinished);
        assert_eq!(cue_for("trigger.fired"), sound::Cue::Attention);
        assert_eq!(cue_for("something.nobody.has.written.yet"), sound::Cue::Attention);
    }

    /// A conflict outranks the generic failure sound: it is the one state the
    /// user has to resolve before work continues, and it should not be
    /// indistinguishable from a turn that died.
    #[test]
    fn a_conflict_sounds_like_a_conflict_not_a_failure() {
        assert_eq!(cue_for("git.conflict.failed"), sound::Cue::Conflict);
    }

    #[test]
    fn levels_decompose() {
        assert!(Level::Both.wants_banner() && Level::Both.wants_sound());
        assert!(Level::Banner.wants_banner() && !Level::Banner.wants_sound());
        assert!(!Level::Sound.wants_banner() && Level::Sound.wants_sound());
        assert!(!Level::Silent.wants_banner() && !Level::Silent.wants_sound());
    }
}
