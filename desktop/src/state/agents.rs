//! Agent system runtime state.
//!
//! Phase 7A landed the channel/dispatcher skeleton. 7B fleshes out
//! `ChatTabState`, wires real handlers for `StartTask`/`CancelTask`, and routes
//! `PipelineMsg::Event` frames into per-chat message lists so the UI can render
//! them as chat bubbles.
//!
//! Thread model (per plan §3.2):
//!   ┌─────────────────┐                    ┌───────────────────────┐
//!   │  UI thread      │ ── AgentAction ──▶ │  dispatcher thread    │
//!   │  (egui update)  │ ◀── PipelineMsg ── │  (core ops / pipeline)│
//!   └─────────────────┘                    └───────────────────────┘

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crossbeam_channel::{Receiver, Sender};
use eframe::egui;
use serde::{Deserialize, Serialize};

use voidlink_core::agent_runner::{AgentRunnerState, AgentSessionInfo, AgentTool, StartSessionInput};
use voidlink_core::events::EventEmitter;
use voidlink_core::git::DiffResult;
use voidlink_core::git_agent::{AgentEvent, AgentTaskInput, AgentTaskState, GitAgentState, PrDescription};
use voidlink_core::migration::MigrationState;

/// Max messages retained per chat before we start dropping the oldest (§10.1 #6).
pub const MESSAGE_CAP: usize = 1000;

/// Wall-clock milliseconds since the epoch; small re-export of
/// `voidlink_core::git_agent::pipeline::now_ms` so UI code doesn't need the
/// import noise.
pub fn pipeline_now_ms() -> i64 {
    voidlink_core::git_agent::pipeline::now_ms()
}

/// Watchdog cadence for the attention-badge scanner (§10.1 #1).
pub const WATCHDOG_TICK_MS: u64 = 5_000;
/// A running chat with no new events for this long is flagged `attention=true`.
pub const ATTENTION_IDLE_THRESHOLD_MS: i64 = 30_000;

/// Canonical pipeline step ordering from `voidlink_core::git_agent::pipeline`.
/// Events are grouped under the **latest** step marker that has been reached
/// by the pipeline at the time the event arrives.
pub const PIPELINE_STEPS: &[(&str, &str)] = &[
    ("branch", "Branch"),
    ("worktree", "Worktree"),
    ("implement", "Implement"),
    ("commit", "Commit"),
    ("push", "Push"),
    ("pr", "PR"),
];

/// Map an `AgentTaskState.current_step` raw string (whatever the pipeline emits
/// via `set_step!`) into one of the canonical step ids in `PIPELINE_STEPS`.
pub fn classify_step(raw: &str) -> Option<&'static str> {
    // Order matters: more specific phrases first so "pushing branch" doesn't
    // get swallowed by the looser "branch" match.
    let raw = raw.to_ascii_lowercase();
    if raw.contains("pushing") || raw.starts_with("push") {
        Some("push")
    } else if raw.contains("pull request") || raw.contains(" pr ") || raw == "pr" {
        Some("pr")
    } else if raw.contains("committing") || raw.contains("commit") {
        Some("commit")
    } else if raw.contains("worktree") {
        Some("worktree")
    } else if raw.contains("implement") {
        Some("implement")
    } else if raw.contains("branch") {
        Some("branch")
    } else {
        None
    }
}

/// Map an entry from `AgentTaskState.steps_completed` into a canonical step id.
pub fn classify_completed(raw: &str) -> Option<&'static str> {
    let raw = raw.to_ascii_lowercase();
    if raw.contains("branch") {
        Some("branch")
    } else if raw.contains("worktree") {
        Some("worktree")
    } else if raw.contains("impl") {
        Some("implement")
    } else if raw.contains("commit") {
        Some("commit")
    } else if raw.contains("push") {
        Some("push")
    } else if raw.contains("pr") {
        Some("pr")
    } else {
        None
    }
}

// ─── Channel message types ───────────────────────────────────────────────────

/// Messages flowing from background work (pipeline / PTY / emitter) into the
/// UI thread. Drained once per frame by `AgentsRuntime::drain_pipeline_messages`.
#[derive(Debug, Clone)]
pub enum PipelineMsg {
    /// A `voidlink_core` agent pipeline emitted a free-form event.
    Event { task_id: String, event: AgentEvent },
    /// Task status changed (e.g. pending → running → success).
    StatusChanged { task_id: String, status: String },
    /// Task finished successfully. Carries a snapshot of the final task state.
    Completed { task_id: String, task: AgentTaskState },
    /// Task failed. Carries an error message.
    Failed { task_id: String, error: String },
    /// Task was cancelled by the user.
    Cancelled { task_id: String },
    /// A diff refresh for this worktree is now available.
    DiffUpdated { task_id: String },
    /// Result of a one-shot `git_diff_working_impl` call, ready for the chat
    /// tab to display. Posted by the worker thread spawned when
    /// `diff_needs_refresh` transitions true.
    DiffResult {
        task_id: String,
        result: Result<DiffResult, String>,
    },
    /// PTY bytes for a CLI session (7D).
    PtyBytes { pty_id: String, chunk: Vec<u8> },
    /// PTY child process exited (7D).
    PtyExit { pty_id: String },
    /// A CLI session has been idle for N seconds — flag in sidebar (7E).
    NeedsAttention { session_id: String },
    /// Opposite of `NeedsAttention` — activity detected.
    Active { session_id: String },
    /// Watchdog flipped the attention flag on a chat (running + idle).
    AttentionChanged { task_id: String, attention: bool },
    /// A PR description has been generated for an autonomous task whose
    /// `auto_pr=false` — surfaced in `PrDraftCard`.
    PrDraft {
        task_id: String,
        description: PrDescription,
    },
    /// A PR has been opened on GitHub for this task.
    PrCreated { task_id: String, pr_url: String },
    /// A user-triggered PR creation attempt failed.
    PrCreateFailed { task_id: String, error: String },
}

/// Actions sent from the UI thread to the dispatcher thread.
pub enum AgentAction {
    /// Start a new autonomous `git_agent` task.
    StartTask {
        task_id: String,
        input: AgentTaskInput,
        tasks_store: Arc<Mutex<HashMap<String, AgentTaskState>>>,
        migration: MigrationState,
        emitter: Arc<dyn EventEmitter>,
    },
    /// Cancel a running task (best-effort per plan §10.1 risk #2).
    CancelTask {
        task_id: String,
        tasks_store: Arc<Mutex<HashMap<String, AgentTaskState>>>,
    },
    /// Spawn an external CLI agent session (claude/codex/opencode).
    StartCliSession { input: StartSessionInput },
    /// Signal the child process of a CLI session.
    KillCliSession { session_id: String },
    /// Remove worktree + metadata for a CLI session.
    CleanupCliSession { session_id: String },
    /// Recompute the working-tree diff for a task or session's worktree.
    RefreshDiff { worktree_path: String, target: DiffTarget },
    /// Rescan `$PATH` for installed CLI tools.
    DetectTools,
    /// Ask core to generate a `PrDescription` for the given task. Posted once
    /// the task terminates successfully with `auto_pr=false`.
    ProposePr {
        task_id: String,
        repo_path: String,
        objective: String,
        constraints: Vec<String>,
        branch_name: Option<String>,
        base_branch: String,
        migration: voidlink_core::migration::MigrationState,
    },
    /// Submit the displayed `PrDescription` as a draft PR on GitHub.
    CreatePr {
        task_id: String,
        repo_path: String,
        head_branch: String,
        base_branch: String,
        description: PrDescription,
    },
    /// Remove an orphaned worktree left behind across a restart.
    CleanupOrphan {
        task_id: String,
        repo_path: String,
        branch_name: String,
        worktree_path: String,
    },
}

impl std::fmt::Debug for AgentAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentAction::StartTask { task_id, .. } => write!(f, "StartTask({})", task_id),
            AgentAction::CancelTask { task_id, .. } => write!(f, "CancelTask({})", task_id),
            AgentAction::StartCliSession { .. } => write!(f, "StartCliSession"),
            AgentAction::KillCliSession { session_id } => {
                write!(f, "KillCliSession({})", session_id)
            }
            AgentAction::CleanupCliSession { session_id } => {
                write!(f, "CleanupCliSession({})", session_id)
            }
            AgentAction::RefreshDiff { worktree_path, .. } => {
                write!(f, "RefreshDiff({})", worktree_path)
            }
            AgentAction::DetectTools => write!(f, "DetectTools"),
            AgentAction::ProposePr { task_id, .. } => write!(f, "ProposePr({})", task_id),
            AgentAction::CreatePr { task_id, .. } => write!(f, "CreatePr({})", task_id),
            AgentAction::CleanupOrphan { task_id, .. } => {
                write!(f, "CleanupOrphan({})", task_id)
            }
        }
    }
}

#[derive(Debug, Clone)]
pub enum DiffTarget {
    Task(String),
    Session(String),
}

// ─── EguiEmitter ─────────────────────────────────────────────────────────────

/// Adapter that implements `voidlink_core::events::EventEmitter` onto a
/// crossbeam channel destined for the UI thread. Each emit also requests an
/// egui repaint so the next frame can drain pending events.
pub struct EguiEmitter {
    pub ctx: egui::Context,
    pub tx: Sender<PipelineMsg>,
}

impl EguiEmitter {
    pub fn new(ctx: egui::Context, tx: Sender<PipelineMsg>) -> Self {
        Self { ctx, tx }
    }
}

impl EventEmitter for EguiEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        if let Some(task_id) = event.strip_prefix("git-agent-event:") {
            if let Ok(ev) = serde_json::from_value::<AgentEvent>(payload.clone()) {
                // Split diff-update events out — the UI doesn't want them as
                // chat bubbles but does want them for live-diff refresh.
                if ev.level == "diff-update" {
                    let _ = self.tx.send(PipelineMsg::DiffUpdated {
                        task_id: task_id.to_string(),
                    });
                } else {
                    let _ = self.tx.send(PipelineMsg::Event {
                        task_id: task_id.to_string(),
                        event: ev,
                    });
                }
                self.ctx.request_repaint();
                return Ok(());
            }
        }
        let _ = payload;
        Ok(())
    }

    fn emit_bytes(&self, event: &str, data: Vec<u8>) -> Result<(), String> {
        if let Some(pty_id) = event.strip_prefix("pty-output:") {
            let _ = self.tx.send(PipelineMsg::PtyBytes {
                pty_id: pty_id.to_string(),
                chunk: data,
            });
            self.ctx.request_repaint();
        }
        Ok(())
    }
}

// ─── Chat messages ───────────────────────────────────────────────────────────

/// Role of a chat bubble (mirrors SolidJS `AgentChatView` roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    System,
}

/// Status tint for assistant/system bubbles, derived from `AgentEvent.level`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    None,
    Info,
    Warn,
    Error,
    Success,
}

impl MessageStatus {
    pub fn from_level(level: &str) -> Self {
        match level {
            "error" => MessageStatus::Error,
            "warn" => MessageStatus::Warn,
            "success" => MessageStatus::Success,
            "info" => MessageStatus::Info,
            _ => MessageStatus::None,
        }
    }
}

/// One chat bubble rendered by `ChatMessage::show`.
#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub timestamp_ms: i64,
    pub status: MessageStatus,
}

// ─── Task-creation form ──────────────────────────────────────────────────────

/// Mutable form buffer used to build an `AgentTaskInput`. Lives inside
/// `ChatTabState` only while the task has not yet been started; swapped for
/// `form: None` once `StartTask` is dispatched.
#[derive(Debug, Clone)]
pub struct TaskFormState {
    pub objective: String,
    /// One constraint per line (split before dispatch). Keeping the buffer as a
    /// single string avoids an entirely separate `ConstraintsEditor` widget in
    /// 7B — 7E may upgrade this.
    pub constraints_text: String,
    pub branch_name: String,
    pub base_ref: String,
    pub auto_pr: bool,
    pub github_base_branch: String,
    pub error: Option<String>,
}

impl Default for TaskFormState {
    fn default() -> Self {
        Self {
            objective: String::new(),
            constraints_text: String::new(),
            branch_name: String::new(),
            base_ref: String::new(),
            auto_pr: false,
            github_base_branch: String::from("main"),
            error: None,
        }
    }
}

impl TaskFormState {
    /// Split the constraints textarea into a clean list of non-empty lines.
    pub fn constraints_list(&self) -> Vec<String> {
        self.constraints_text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect()
    }

    pub fn trimmed_opt(s: &str) -> Option<String> {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    }

    /// Build an `AgentTaskInput` for the given repo path, or return a user-
    /// visible error string if the form is invalid.
    pub fn build(&self, repo_path: &str) -> Result<AgentTaskInput, String> {
        let objective = self.objective.trim().to_string();
        if objective.is_empty() {
            return Err("Objective cannot be empty".to_string());
        }
        if repo_path.is_empty() {
            return Err("No repository open".to_string());
        }
        Ok(AgentTaskInput {
            repo_path: repo_path.to_string(),
            objective,
            branch_name: Self::trimmed_opt(&self.branch_name),
            base_ref: Self::trimmed_opt(&self.base_ref),
            constraints: self.constraints_list(),
            auto_pr: self.auto_pr,
            github_base_branch: Self::trimmed_opt(&self.github_base_branch),
        })
    }
}

// ─── Per-chat state ──────────────────────────────────────────────────────────

/// State for one autonomous-task chat tab.
#[derive(Debug)]
pub struct ChatTabState {
    pub task_id: String,
    /// Human label shown in the sidebar / tab (defaults to objective prefix).
    pub label: String,
    /// Rendered bubbles.
    pub messages: VecDeque<ChatMessage>,
    /// Dedup set, keyed by `AgentEvent.id` (pipeline uses uuid per event).
    pub seen_event_ids: HashSet<String>,
    /// Mirrors `AgentTaskState.status` once known.
    pub status: String,
    pub current_step: Option<String>,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub pr_url: Option<String>,
    pub error: Option<String>,
    /// Composer buffer (disabled after first send in 7B per §6.3).
    pub composer_buffer: String,
    /// UI flag: next frame should scroll the messages pane to the bottom.
    pub scroll_to_bottom: bool,
    /// Form presented *before* a task is started. `None` once the task is live.
    pub form: Option<TaskFormState>,
    /// Set true whenever a `diff-update` event lands (or when the worktree is
    /// first created). Drained in `drain_pipeline_messages`, which spawns a
    /// one-shot worker that computes the new `diff_result`.
    pub diff_needs_refresh: bool,
    /// Width (px) of the right-side LiveDiffPanel. Persisted across frames by
    /// the resizable `SidePanel`; clamped to [240, 640] at render time.
    pub files_panel_width: f32,
    /// Path of the currently-expanded file in the diff panel (if any).
    pub selected_file: Option<String>,
    /// Most recent working-tree diff computed for the chat's worktree, if any.
    pub diff_result: Option<DiffResult>,
    /// Whether a background `git_diff_working_impl` call is in flight. Used
    /// for the loading indicator *and* for debouncing overlapping refreshes.
    pub diff_loading: bool,
    /// Timestamp of the most recent event received on this chat (ms since
    /// epoch). Used by the watchdog to detect idle chats (§10.1 #1).
    pub last_event_ms: i64,
    /// Watchdog flag: the pipeline is running but no events have landed for
    /// `ATTENTION_IDLE_THRESHOLD_MS`. Rendered as a dot in the sidebar.
    pub attention: bool,
    /// PR description generated on-demand when a task finishes with
    /// `auto_pr=false`. `None` means "either auto_pr=true already opened the
    /// PR, or we haven't proposed a draft yet".
    pub pr_draft: Option<PrDescription>,
    /// Set true while a background `ProposePr`/`CreatePr` thread is in flight.
    pub pr_action_in_flight: bool,
    /// Last error from the `CreatePr` action, if any. Surfaced in the card.
    pub pr_error: Option<String>,
    /// Remembers the inputs needed to re-propose a PR (auto_pr=false path).
    pub pr_context: Option<PrContext>,

    // ─── ED-D composer footer state ────────────────────────────────────────
    /// Auto-accept edits toggle; when false, the user must approve each
    /// pipeline edit before it lands. Runtime-only in ED-D; persisted per
    /// session once ED-E plumbs the session data model.
    pub auto_accept: bool,
    /// Model identifier shown in the footer pill.
    pub model_name: String,
    /// Tokens consumed so far; drives the `TokenBudgetMeter` tint.
    pub tokens_used: u64,
    /// Context-window size for the current model; used as the meter denominator.
    pub context_window: u64,
    /// True when the scroll view is not pinned to the bottom; drives the
    /// `ScrollToBottomPill`.
    pub show_scroll_to_bottom_pill: bool,
    /// Unread-message counter while the user is scrolled up. Resets on click.
    pub unread_since_scroll: u32,
}

/// The subset of `AgentTaskInput` we need to re-propose a PR for a finished
/// chat. Kept on `ChatTabState` so the button in `PrDraftCard` doesn't need to
/// cross-reference the original input.
#[derive(Debug, Clone)]
pub struct PrContext {
    pub repo_path: String,
    pub objective: String,
    pub constraints: Vec<String>,
    pub base_branch: String,
    pub auto_pr: bool,
}

impl ChatTabState {
    pub fn new(task_id: String) -> Self {
        Self {
            task_id,
            label: String::from("New task"),
            messages: VecDeque::new(),
            seen_event_ids: HashSet::new(),
            status: "pending".to_string(),
            current_step: None,
            branch_name: None,
            worktree_path: None,
            pr_url: None,
            error: None,
            composer_buffer: String::new(),
            scroll_to_bottom: false,
            form: None,
            diff_needs_refresh: false,
            files_panel_width: 320.0,
            selected_file: None,
            diff_result: None,
            diff_loading: false,
            last_event_ms: pipeline_now_ms(),
            attention: false,
            pr_draft: None,
            pr_action_in_flight: false,
            pr_error: None,
            pr_context: None,
            // ED-D defaults.
            auto_accept: true,
            model_name: String::from("Sonnet 4.6"),
            tokens_used: 0,
            context_window: 200_000,
            show_scroll_to_bottom_pill: false,
            unread_since_scroll: 0,
        }
    }

    /// Whether the pipeline is still running (spinner/disabled composer/etc.).
    pub fn is_running(&self) -> bool {
        matches!(
            self.status.as_str(),
            "pending" | "branching" | "implementing" | "pr_creating"
        )
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "success" | "failed" | "cancelled")
    }

    /// Append a chat bubble with the 1000-message cap (§10.1 #6).
    pub fn push_message(&mut self, msg: ChatMessage) {
        if !msg.id.is_empty() && !self.seen_event_ids.insert(msg.id.clone()) {
            // Duplicate — ignore silently.
            return;
        }
        self.messages.push_back(msg);
        while self.messages.len() > MESSAGE_CAP {
            self.messages.pop_front();
        }
        self.scroll_to_bottom = true;
    }

    /// Apply a pipeline `AgentEvent` to this chat (updates status mirrors +
    /// appends a bubble). Follows the SolidJS mapping in
    /// `frontend/src/components/agent/AgentChatView.tsx`.
    pub fn apply_event(&mut self, ev: &AgentEvent) {
        // Any incoming event clears the attention flag and bumps the liveness
        // timestamp so the watchdog has a fresh reference point (§10.1 #1).
        self.attention = false;
        self.last_event_ms = pipeline_now_ms();

        // Status/metadata inference from message text mirrors pipeline.rs.
        let msg = ev.message.as_str();
        if let Some(rest) = msg.strip_prefix("Step: ") {
            self.current_step = Some(rest.to_string());
        }
        if let Some(rest) = msg.strip_prefix("Branch name: ") {
            self.branch_name = Some(rest.trim().to_string());
        }
        if let Some(rest) = msg.strip_prefix("Worktree created at: ") {
            let is_first = self.worktree_path.is_none();
            self.worktree_path = Some(rest.trim().to_string());
            self.status = "implementing".to_string();
            // Trigger the initial live-diff refresh as soon as the worktree
            // exists — even before the first file write (plan step 6).
            if is_first {
                self.diff_needs_refresh = true;
            }
        }
        if let Some(rest) = msg.strip_prefix("Draft PR created: ") {
            self.pr_url = Some(rest.trim().to_string());
        }
        if msg == "Agent task completed successfully" {
            self.status = "success".to_string();
            self.current_step = None;
        }
        if ev.level == "error" {
            self.status = "failed".to_string();
            self.current_step = None;
            self.error = Some(msg.to_string());
        }

        let role = if ev.level == "error" || ev.level == "warn" {
            MessageRole::Assistant
        } else {
            MessageRole::System
        };

        self.push_message(ChatMessage {
            id: ev.id.clone(),
            role,
            content: ev.message.clone(),
            timestamp_ms: ev.created_at,
            status: MessageStatus::from_level(&ev.level),
        });
    }
}

impl ChatTabState {
    /// Group `self.messages` by canonical pipeline step.
    ///
    /// Returns a list of `(Option<step_id>, Vec<&ChatMessage>)` tuples in order.
    /// `None` corresponds to messages that arrived before the first `Step:`
    /// marker (and post-terminal "Agent task completed successfully"-type
    /// events that arrive after we've already stamped `current_step = None`
    /// on the chat — these render as a trailing pre/post group).
    pub fn group_messages_by_step(&self) -> Vec<(Option<&'static str>, Vec<&ChatMessage>)> {
        let mut groups: Vec<(Option<&'static str>, Vec<&ChatMessage>)> = Vec::new();
        let mut current: Option<&'static str> = None;

        for m in self.messages.iter() {
            // Update `current` if this message is a Step marker.
            if let Some(rest) = m.content.strip_prefix("Step: ") {
                if let Some(canon) = classify_step(rest.trim()) {
                    current = Some(canon);
                }
            }

            match groups.last_mut() {
                Some((id, bucket)) if *id == current => bucket.push(m),
                _ => groups.push((current, vec![m])),
            }
        }

        groups
    }
}

impl Default for ChatTabState {
    fn default() -> Self {
        Self::new(String::new())
    }
}

/// State for one CLI-agent PTY session. Filled in in 7D.
#[derive(Debug)]
pub struct CliSessionState {
    pub info: AgentSessionInfo,
    pub terminal_id: Option<u64>,
    pub diff_drawer_open: bool,
    pub last_diff_refresh_frame: u64,
}

impl CliSessionState {
    pub fn new(info: AgentSessionInfo) -> Self {
        Self {
            info,
            terminal_id: None,
            diff_drawer_open: false,
            last_diff_refresh_frame: 0,
        }
    }
}

// ─── Persisted counterpart ───────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedAgentsState {
    #[serde(default)]
    pub known_task_worktrees: Vec<KnownWorktree>,
    #[serde(default)]
    pub last_active_session: Option<String>,
    #[serde(default)]
    pub default_auto_pr: bool,
    #[serde(default)]
    pub default_constraints: Vec<String>,
    #[serde(default)]
    pub detected_cli_cache: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownWorktree {
    pub task_id: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub created_at: i64,
}

// ─── Runtime ────────────────────────────────────────────────────────────────

pub struct AgentsRuntime {
    pub action_tx: Sender<AgentAction>,
    pub pipeline_rx: Receiver<PipelineMsg>,
    pub pipeline_tx: Sender<PipelineMsg>,
    pub dispatcher_handle: Option<JoinHandle<()>>,

    // ── Autonomous tasks ─────────────────────────────────────────────────
    pub chats: HashMap<String, ChatTabState>,
    /// Stable insertion order so the sidebar has a deterministic list.
    pub chat_order: Vec<String>,
    /// Shared `GitAgentState` — its `tasks` mutex is passed into
    /// `run_agent_pipeline` so the pipeline and UI read the same store.
    pub git_agent_state: Arc<GitAgentState>,

    // ── External CLI sessions ─────────────────────────────────────────────
    pub cli_sessions: HashMap<String, CliSessionState>,
    pub runner_state: Arc<AgentRunnerState>,
    pub attention: HashSet<String>,

    // ── Tool detection cache ─────────────────────────────────────────────
    pub detected_cli_tools: Vec<AgentTool>,

    // ── Orphan worktrees flagged on startup from persisted state ──────────
    pub orphan_worktrees: Vec<KnownWorktree>,

    // ── Per-frame bookkeeping ────────────────────────────────────────────
    pub last_drain_count: usize,
}

impl AgentsRuntime {
    pub fn new() -> Self {
        let (action_tx, action_rx) = crossbeam_channel::unbounded::<AgentAction>();
        let (pipeline_tx, pipeline_rx) = crossbeam_channel::unbounded::<PipelineMsg>();

        // Park the receiver on a dispatcher stub that does nothing until
        // `spawn_dispatcher` is called. We simply drop it — `spawn_dispatcher`
        // will install a fresh channel.
        drop(action_rx);

        Self {
            action_tx,
            pipeline_rx,
            pipeline_tx,
            dispatcher_handle: None,
            chats: HashMap::new(),
            chat_order: Vec::new(),
            git_agent_state: Arc::new(GitAgentState::new()),
            cli_sessions: HashMap::new(),
            runner_state: Arc::new(AgentRunnerState::new()),
            attention: HashSet::new(),
            detected_cli_tools: Vec::new(),
            orphan_worktrees: Vec::new(),
            last_drain_count: 0,
        }
    }

    /// Spawn the dispatcher thread. Safe to call multiple times — subsequent
    /// calls are no-ops.
    pub fn spawn_dispatcher(&mut self, ctx: &egui::Context) {
        if self.dispatcher_handle.is_some() {
            return;
        }

        let (action_tx, action_rx) = crossbeam_channel::unbounded::<AgentAction>();
        self.action_tx = action_tx;

        let pipeline_tx = self.pipeline_tx.clone();
        let ctx = ctx.clone();

        let handle = std::thread::Builder::new()
            .name("voidlink-agents-dispatcher".into())
            .spawn(move || {
                log::info!("agents dispatcher thread started");
                loop {
                    match action_rx.recv() {
                        Ok(action) => {
                            dispatch_action(action, &pipeline_tx, &ctx);
                        }
                        Err(_) => {
                            log::info!("agents dispatcher: action channel closed, exiting");
                            break;
                        }
                    }
                }
            })
            .expect("failed to spawn agents dispatcher thread");

        self.dispatcher_handle = Some(handle);
    }

    /// Drain pending pipeline messages and apply them to runtime state.
    pub fn drain_pipeline_messages(&mut self) {
        let mut count = 0usize;
        while let Ok(msg) = self.pipeline_rx.try_recv() {
            count += 1;
            match msg {
                PipelineMsg::Event { task_id, event } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.apply_event(&event);
                    }
                    // Mirror the event into the shared task store for anyone
                    // inspecting `AgentTaskState.events` (e.g. 7E timeline).
                    // The pipeline already does this; the emitter copy is
                    // redundant but harmless.
                }
                PipelineMsg::StatusChanged { task_id, status } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.status = status;
                    }
                }
                PipelineMsg::Completed { task_id, task } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        let had_worktree = chat.worktree_path.is_some();
                        chat.status = task.status.clone();
                        chat.current_step = task.current_step.clone();
                        chat.branch_name = task.branch_name.clone();
                        chat.worktree_path = task.worktree_path.clone();
                        chat.pr_url = task.pr_url.clone();
                        chat.error = task.error.clone();
                        // First time the worktree shows up → kick a fresh diff
                        // so the panel is populated even if no file-write event
                        // has fired yet (matches §6.1 lifecycle note).
                        if !had_worktree && chat.worktree_path.is_some() {
                            chat.diff_needs_refresh = true;
                        }
                    }
                }
                PipelineMsg::Failed { task_id, error } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.status = "failed".to_string();
                        chat.error = Some(error);
                        chat.current_step = None;
                    }
                }
                PipelineMsg::Cancelled { task_id } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.status = "cancelled".to_string();
                        chat.current_step = None;
                    }
                }
                PipelineMsg::DiffUpdated { task_id } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.diff_needs_refresh = true;
                    }
                }
                PipelineMsg::DiffResult { task_id, result } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.diff_loading = false;
                        match result {
                            Ok(diff) => chat.diff_result = Some(diff),
                            Err(e) => {
                                log::warn!(
                                    "agent diff refresh failed for {}: {}",
                                    task_id,
                                    e
                                );
                            }
                        }
                    }
                }
                PipelineMsg::PtyBytes { pty_id, chunk } => {
                    log::trace!("pty {} bytes={}", pty_id, chunk.len());
                }
                PipelineMsg::PtyExit { pty_id } => {
                    log::info!("pty {} exited", pty_id);
                }
                PipelineMsg::NeedsAttention { session_id } => {
                    self.attention.insert(session_id);
                }
                PipelineMsg::Active { session_id } => {
                    self.attention.remove(&session_id);
                }
                PipelineMsg::AttentionChanged { task_id, attention } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.attention = attention;
                    }
                }
                PipelineMsg::PrDraft {
                    task_id,
                    description,
                } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.pr_draft = Some(description);
                        chat.pr_action_in_flight = false;
                    }
                }
                PipelineMsg::PrCreated { task_id, pr_url } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.pr_url = Some(pr_url);
                        chat.pr_action_in_flight = false;
                        chat.pr_error = None;
                    }
                }
                PipelineMsg::PrCreateFailed { task_id, error } => {
                    if let Some(chat) = self.chats.get_mut(&task_id) {
                        chat.pr_action_in_flight = false;
                        chat.pr_error = Some(error);
                    }
                }
            }
        }
        self.last_drain_count = count;

        // ── Live-diff refresh sweep ──────────────────────────────────────
        //
        // For each chat whose worktree exists and has a pending `diff-update`
        // trigger, spawn a one-shot worker that calls
        // `voidlink_core::git::git_diff_working_impl` and posts
        // `PipelineMsg::DiffResult` back. If `diff_loading` is already true,
        // leave the flag set — the debounce contract keeps exactly one refresh
        // in flight per chat, with the next one queued to run immediately on
        // return (see `agent_diff_debounce_leaves_flag_when_loading` test).
        for task_id in self.chat_order.iter().cloned().collect::<Vec<_>>() {
            let Some(chat) = self.chats.get_mut(&task_id) else {
                continue;
            };
            if !chat.diff_needs_refresh {
                continue;
            }
            let Some(worktree) = chat.worktree_path.clone() else {
                continue;
            };
            if chat.diff_loading {
                // Leave diff_needs_refresh set so we kick again on the next
                // frame after the in-flight worker lands.
                continue;
            }
            chat.diff_needs_refresh = false;
            chat.diff_loading = true;
            let tx = self.pipeline_tx.clone();
            let task_id_c = task_id.clone();
            std::thread::Builder::new()
                .name(format!("voidlink-diff-refresh-{}", task_id_c))
                .spawn(move || {
                    let result = voidlink_core::git::git_diff_working_impl(worktree, false);
                    let _ = tx.send(PipelineMsg::DiffResult {
                        task_id: task_id_c,
                        result,
                    });
                })
                .ok();
        }
    }

    pub fn pipeline_sender(&self) -> Sender<PipelineMsg> {
        self.pipeline_tx.clone()
    }

    pub fn make_emitter(&self, ctx: &egui::Context) -> Arc<EguiEmitter> {
        Arc::new(EguiEmitter::new(ctx.clone(), self.pipeline_tx.clone()))
    }

    pub fn seed_from_persisted(&mut self, persisted: &PersistedAgentsState) {
        self.orphan_worktrees = persisted
            .known_task_worktrees
            .iter()
            .filter(|w| std::path::Path::new(&w.worktree_path).exists())
            .cloned()
            .collect();
    }

    /// Re-run orphan detection against the current set of live chats. Any
    /// known worktree whose directory still exists on disk *and* whose
    /// `task_id` does **not** correspond to a live running chat is surfaced
    /// as an orphan in the sidebar. Called once on startup and whenever the
    /// chats list may have changed (e.g. after inserting a newly-seeded chat).
    pub fn reconcile_orphans(&mut self, persisted: &PersistedAgentsState) {
        self.orphan_worktrees = persisted
            .known_task_worktrees
            .iter()
            .filter(|w| std::path::Path::new(&w.worktree_path).exists())
            .filter(|w| !self.chats.contains_key(&w.task_id))
            .cloned()
            .collect();
    }

    /// Drop an orphan entry after cleanup (called from the UI once
    /// `CleanupOrphan` completes).
    pub fn remove_orphan(&mut self, task_id: &str) {
        self.orphan_worktrees.retain(|w| w.task_id != task_id);
    }

    /// Spawn the attention-badge watchdog. Ticks every `WATCHDOG_TICK_MS` and
    /// posts `PipelineMsg::AttentionChanged { attention: true }` for any
    /// running chat whose `last_event_ms` is older than
    /// `ATTENTION_IDLE_THRESHOLD_MS`. The flag is cleared by `apply_event`.
    ///
    /// Called once from `main.rs::new` after `spawn_dispatcher`. The returned
    /// handle is stashed so the watchdog lives as long as the `AgentsRuntime`.
    pub fn spawn_watchdog(&mut self, ctx: &egui::Context) {
        let tx = self.pipeline_tx.clone();
        let tasks = self.git_agent_state.tasks.clone();
        let ctx = ctx.clone();
        std::thread::Builder::new()
            .name("voidlink-agents-watchdog".into())
            .spawn(move || {
                log::info!("agents watchdog thread started");
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(WATCHDOG_TICK_MS));
                    let now = pipeline_now_ms();
                    let snapshot: Vec<(String, String, i64)> = match tasks.lock() {
                        Ok(guard) => guard
                            .iter()
                            .filter_map(|(id, t)| {
                                // Timestamp of latest event we can see in the
                                // shared task store (mirror of what the chat
                                // sees after `apply_event`).
                                let last_ev_ms = t
                                    .events
                                    .iter()
                                    .map(|e| e.created_at)
                                    .max()
                                    .unwrap_or(0);
                                Some((id.clone(), t.status.clone(), last_ev_ms))
                            })
                            .collect(),
                        Err(_) => Vec::new(),
                    };

                    for (task_id, status, last_ms) in snapshot {
                        let running = matches!(
                            status.as_str(),
                            "pending" | "branching" | "implementing" | "pr_creating"
                        );
                        if !running {
                            continue;
                        }
                        let age = now - last_ms;
                        if age > ATTENTION_IDLE_THRESHOLD_MS {
                            let _ = tx.send(PipelineMsg::AttentionChanged {
                                task_id,
                                attention: true,
                            });
                            ctx.request_repaint();
                        }
                    }
                }
            })
            .ok();
    }

    /// Insert a new chat (used by the sidebar "+ New task" button).
    pub fn insert_chat(&mut self, chat: ChatTabState) {
        let id = chat.task_id.clone();
        if !self.chats.contains_key(&id) {
            self.chat_order.push(id.clone());
        }
        self.chats.insert(id, chat);
    }

    /// Drop a chat and its order entry.
    pub fn remove_chat(&mut self, task_id: &str) {
        self.chats.remove(task_id);
        self.chat_order.retain(|id| id != task_id);
    }

    /// Register an empty `AgentTaskState` in the shared store before a task
    /// starts running. Matches what `git_agent_start` in the Tauri shell does.
    pub fn register_initial_task(&self, input: &AgentTaskInput, task_id: &str) {
        let initial = AgentTaskState {
            task_id: task_id.to_string(),
            status: "pending".to_string(),
            branch_name: input.branch_name.clone(),
            worktree_path: None,
            pr_url: None,
            steps_completed: Vec::new(),
            current_step: None,
            events: Vec::new(),
            error: None,
        };
        if let Ok(mut guard) = self.git_agent_state.tasks.lock() {
            guard.insert(task_id.to_string(), initial);
        }
    }
}

impl Default for AgentsRuntime {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

fn dispatch_action(action: AgentAction, tx: &Sender<PipelineMsg>, _ctx: &egui::Context) {
    match action {
        AgentAction::StartTask {
            task_id,
            input,
            tasks_store,
            migration,
            emitter,
        } => {
            let task_id_clone = task_id.clone();
            let tx_clone = tx.clone();
            std::thread::Builder::new()
                .name(format!("voidlink-git-agent-{}", task_id))
                .spawn(move || {
                    log::info!("git_agent pipeline starting for {}", task_id_clone);
                    voidlink_core::git_agent::pipeline::run_agent_pipeline(
                        task_id_clone.clone(),
                        input,
                        tasks_store.clone(),
                        migration,
                        emitter,
                    );
                    // Produce a Completed/Failed message from the final state so
                    // the UI can sync any fields the chat hasn't seen yet.
                    let final_state = tasks_store
                        .lock()
                        .ok()
                        .and_then(|g| g.get(&task_id_clone).cloned());
                    if let Some(state) = final_state {
                        if state.status == "success" {
                            let _ = tx_clone.send(PipelineMsg::Completed {
                                task_id: task_id_clone.clone(),
                                task: state,
                            });
                        } else if state.status == "failed" {
                            let err = state
                                .error
                                .clone()
                                .unwrap_or_else(|| "unknown error".to_string());
                            let _ = tx_clone.send(PipelineMsg::Failed {
                                task_id: task_id_clone.clone(),
                                error: err,
                            });
                        } else {
                            let _ = tx_clone.send(PipelineMsg::Completed {
                                task_id: task_id_clone,
                                task: state,
                            });
                        }
                    }
                })
                .expect("failed to spawn git_agent pipeline thread");
        }
        AgentAction::CancelTask {
            task_id,
            tasks_store,
        } => {
            // TODO(Phase 8): thread an AtomicBool cancel flag into llm_chat so
            // the running pipeline thread actually stops on cancel. Today we
            // only flip task status to "failed" (see §10.1 risk #2) and the
            // worker continues burning LLM tokens until its next checkpoint.
            // Mirror Tauri's `git_agent_cancel` — best-effort: flip status so
            // subsequent steps become no-ops via update_task checks.
            if let Ok(mut guard) = tasks_store.lock() {
                if let Some(task) = guard.get_mut(&task_id) {
                    if task.status != "success" && task.status != "failed" {
                        task.status = "failed".to_string();
                        task.error = Some("Cancelled by user".to_string());
                        task.current_step = None;
                    }
                }
            }
            let _ = tx.send(PipelineMsg::Cancelled { task_id });
        }
        AgentAction::StartCliSession { input: _ } => {
            log::warn!("AgentAction::StartCliSession — wired in 7D");
        }
        AgentAction::KillCliSession { session_id } => {
            log::warn!("AgentAction::KillCliSession({}) — wired in 7D", session_id);
        }
        AgentAction::CleanupCliSession { session_id } => {
            log::warn!(
                "AgentAction::CleanupCliSession({}) — wired in 7D",
                session_id
            );
        }
        AgentAction::RefreshDiff { worktree_path, .. } => {
            log::warn!("AgentAction::RefreshDiff({}) — wired in 7C", worktree_path);
        }
        AgentAction::DetectTools => {
            log::warn!("AgentAction::DetectTools — wired in 7D");
        }
        AgentAction::ProposePr {
            task_id,
            repo_path,
            objective,
            constraints,
            branch_name,
            base_branch,
            migration,
        } => {
            let tx = tx.clone();
            std::thread::Builder::new()
                .name(format!("voidlink-propose-pr-{}", task_id))
                .spawn(move || {
                    match generate_pr_description(
                        &repo_path,
                        &objective,
                        &constraints,
                        branch_name.as_deref(),
                        &base_branch,
                        &migration,
                    ) {
                        Ok(desc) => {
                            let _ = tx.send(PipelineMsg::PrDraft {
                                task_id,
                                description: desc,
                            });
                        }
                        Err(e) => {
                            log::warn!("propose_pr failed for {}: {}", task_id, e);
                            let _ = tx.send(PipelineMsg::PrCreateFailed {
                                task_id,
                                error: e,
                            });
                        }
                    }
                })
                .ok();
        }
        AgentAction::CreatePr {
            task_id,
            repo_path,
            head_branch,
            base_branch,
            description,
        } => {
            let tx = tx.clone();
            std::thread::Builder::new()
                .name(format!("voidlink-create-pr-{}", task_id))
                .spawn(move || {
                    match submit_draft_pr(
                        &repo_path,
                        &description.title,
                        &description.body,
                        &head_branch,
                        &base_branch,
                    ) {
                        Ok(url) => {
                            let _ = tx.send(PipelineMsg::PrCreated {
                                task_id,
                                pr_url: url,
                            });
                        }
                        Err(e) => {
                            let _ = tx.send(PipelineMsg::PrCreateFailed {
                                task_id,
                                error: e,
                            });
                        }
                    }
                })
                .ok();
        }
        AgentAction::CleanupOrphan {
            task_id: _,
            repo_path,
            branch_name,
            worktree_path,
        } => {
            // Safety: only ever remove a worktree that lives under the repo's
            // `.worktrees/` directory. If the path doesn't match, we fall back
            // to `git_remove_worktree_impl` (which does its own validation) or
            // refuse entirely.
            let is_under_worktrees = std::path::Path::new(&worktree_path)
                .components()
                .any(|c| c.as_os_str() == ".worktrees");

            if !is_under_worktrees {
                log::warn!(
                    "refusing to remove orphan — path {} is not under .worktrees/",
                    worktree_path
                );
                return;
            }

            if let Err(e) = voidlink_core::git::git_remove_worktree_impl(
                repo_path.clone(),
                branch_name.clone(),
                false,
            ) {
                log::warn!("git_remove_worktree_impl({}): {}", branch_name, e);
                // Fallback: if git's prune failed but the directory still
                // exists, wipe it manually.
                if std::path::Path::new(&worktree_path).exists() {
                    let _ = std::fs::remove_dir_all(&worktree_path);
                }
            }
        }
    }
}

/// Generate a `PrDescription` for a finished autonomous task. This mirrors the
/// logic inside the auto-PR branch of `git_agent::pipeline::run_agent_pipeline`
/// so we can surface a draft for `auto_pr=false` tasks without having to
/// re-run the whole pipeline. Lives on the dispatcher thread; must not touch
/// any UI state directly.
fn generate_pr_description(
    _repo_path: &str,
    objective: &str,
    constraints: &[String],
    _branch_name: Option<&str>,
    _base_branch: &str,
    migration: &voidlink_core::migration::MigrationState,
) -> Result<PrDescription, String> {
    let pr_prompt = format!(
        r#"Write a GitHub pull request description for this change.
Objective: {}
Constraints: {}

Return a JSON object with:
- "title": PR title (max 72 chars)
- "body": PR body in markdown (include Summary, Changes Made, Test Plan sections)
- "labels": array of relevant labels (e.g. ["enhancement", "ai-generated"])
- "migration_notes": any migration/breaking change notes (or null)
- "test_plan": testing steps (or null)"#,
        objective,
        constraints.join(", "),
    );

    let raw = migration.llm_chat(&pr_prompt, true)?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    Ok(PrDescription {
        title: v["title"]
            .as_str()
            .unwrap_or("AI-generated change")
            .to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        labels: v["labels"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_else(|| vec!["ai-generated".to_string()]),
        migration_notes: v["migration_notes"].as_str().map(|s| s.to_string()),
        test_plan: v["test_plan"].as_str().map(|s| s.to_string()),
    })
}

/// Submit a draft PR on GitHub for an autonomous task. Thin wrapper around
/// `voidlink_core::git_agent::github::submit_pr_by_repo` so the dispatcher
/// thread has a single call site.
fn submit_draft_pr(
    repo_path: &str,
    title: &str,
    body: &str,
    head_branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    voidlink_core::git_agent::github::submit_pr_by_repo(
        repo_path,
        title,
        body,
        head_branch,
        base_branch,
        true,
    )
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emitter_parses_git_agent_event_name() {
        let ctx = egui::Context::default();
        let (tx, rx) = crossbeam_channel::unbounded::<PipelineMsg>();
        let emitter = EguiEmitter::new(ctx, tx);
        let ev = AgentEvent {
            id: "evt-1".into(),
            level: "info".into(),
            message: "hi".into(),
            created_at: 0,
        };
        emitter
            .emit("git-agent-event:task-123", serde_json::to_value(&ev).unwrap())
            .unwrap();
        match rx.try_recv().unwrap() {
            PipelineMsg::Event { task_id, event } => {
                assert_eq!(task_id, "task-123");
                assert_eq!(event.id, "evt-1");
            }
            other => panic!("unexpected message: {:?}", other),
        }
    }

    #[test]
    fn emitter_routes_diff_update_separately() {
        let ctx = egui::Context::default();
        let (tx, rx) = crossbeam_channel::unbounded::<PipelineMsg>();
        let emitter = EguiEmitter::new(ctx, tx);
        let ev = AgentEvent {
            id: "evt-1".into(),
            level: "diff-update".into(),
            message: "src/foo.rs".into(),
            created_at: 0,
        };
        emitter
            .emit("git-agent-event:task-9", serde_json::to_value(&ev).unwrap())
            .unwrap();
        match rx.try_recv().unwrap() {
            PipelineMsg::DiffUpdated { task_id } => assert_eq!(task_id, "task-9"),
            other => panic!("unexpected message: {:?}", other),
        }
    }

    #[test]
    fn chat_dedupes_events_and_caps_messages() {
        let mut chat = ChatTabState::new("t-1".into());
        let ev = AgentEvent {
            id: "e-1".into(),
            level: "info".into(),
            message: "hello".into(),
            created_at: 0,
        };
        chat.apply_event(&ev);
        chat.apply_event(&ev); // duplicate
        assert_eq!(chat.messages.len(), 1);

        for i in 0..(MESSAGE_CAP + 50) {
            chat.apply_event(&AgentEvent {
                id: format!("e-{}", i + 2),
                level: "info".into(),
                message: format!("m-{}", i),
                created_at: i as i64,
            });
        }
        assert!(chat.messages.len() <= MESSAGE_CAP);
    }

    #[test]
    fn runtime_spawn_and_drain_is_benign() {
        let mut rt = AgentsRuntime::new();
        rt.drain_pipeline_messages();
        assert_eq!(rt.last_drain_count, 0);
    }

    #[test]
    fn agent_diff_debounce_leaves_flag_when_loading() {
        // Two concurrent DiffUpdated triggers should only produce *one*
        // in-flight worker: the second should leave `diff_needs_refresh = true`
        // so the next drain fires a fresh refresh after the in-flight one lands.
        let mut rt = AgentsRuntime::new();
        let mut chat = ChatTabState::new("t-1".into());
        chat.worktree_path = Some("/tmp/does-not-exist-worktree".into());
        rt.insert_chat(chat);

        // First trigger: DiffUpdated → drain spawns a worker and sets loading.
        rt.pipeline_tx
            .send(PipelineMsg::DiffUpdated {
                task_id: "t-1".into(),
            })
            .unwrap();
        rt.drain_pipeline_messages();
        let c = rt.chats.get("t-1").unwrap();
        assert!(c.diff_loading, "first drain should start a refresh");
        assert!(
            !c.diff_needs_refresh,
            "first drain should clear the refresh flag after scheduling"
        );

        // Second trigger arrives while the worker is still running.
        rt.pipeline_tx
            .send(PipelineMsg::DiffUpdated {
                task_id: "t-1".into(),
            })
            .unwrap();
        rt.drain_pipeline_messages();
        let c = rt.chats.get("t-1").unwrap();
        assert!(
            c.diff_loading,
            "loading should still be true (no new worker spawned)"
        );
        assert!(
            c.diff_needs_refresh,
            "debounce should leave the flag set so we refresh again after the in-flight worker returns"
        );
    }

    #[test]
    fn chat_sets_diff_needs_refresh_when_worktree_first_appears() {
        let mut chat = ChatTabState::new("t-1".into());
        assert!(!chat.diff_needs_refresh);
        chat.apply_event(&AgentEvent {
            id: "evt-1".into(),
            level: "info".into(),
            message: "Worktree created at: /tmp/some/worktree".into(),
            created_at: 0,
        });
        assert_eq!(chat.worktree_path.as_deref(), Some("/tmp/some/worktree"));
        assert!(
            chat.diff_needs_refresh,
            "first worktree should trigger initial diff refresh"
        );
    }

    #[test]
    fn task_form_requires_objective() {
        let form = TaskFormState::default();
        assert!(form.build("/tmp/repo").is_err());
        let mut form = TaskFormState::default();
        form.objective = "Add a button".into();
        let input = form.build("/tmp/repo").unwrap();
        assert_eq!(input.objective, "Add a button");
        assert!(input.constraints.is_empty());
    }

    // ── 7E tests ────────────────────────────────────────────────────────────

    #[test]
    fn apply_event_clears_attention_and_bumps_last_event() {
        let mut chat = ChatTabState::new("t-1".into());
        chat.attention = true;
        chat.last_event_ms = 0;

        chat.apply_event(&AgentEvent {
            id: "e-1".into(),
            level: "info".into(),
            message: "hi".into(),
            created_at: 123,
        });

        assert!(!chat.attention, "new event should clear attention flag");
        assert!(
            chat.last_event_ms > 0,
            "new event should bump last_event_ms to now"
        );
    }

    #[test]
    fn attention_flips_via_watchdog_pipeline_msg() {
        // The watchdog posts `AttentionChanged` for idle running chats;
        // `drain_pipeline_messages` must route that to `chat.attention`.
        let mut rt = AgentsRuntime::new();
        let chat = ChatTabState::new("t-wd".into());
        rt.insert_chat(chat);

        rt.pipeline_tx
            .send(PipelineMsg::AttentionChanged {
                task_id: "t-wd".into(),
                attention: true,
            })
            .unwrap();
        rt.drain_pipeline_messages();
        assert!(rt.chats.get("t-wd").unwrap().attention);

        // A fresh event must clear it.
        let ev = AgentEvent {
            id: "fresh".into(),
            level: "info".into(),
            message: "moving again".into(),
            created_at: 999,
        };
        rt.pipeline_tx
            .send(PipelineMsg::Event {
                task_id: "t-wd".into(),
                event: ev,
            })
            .unwrap();
        rt.drain_pipeline_messages();
        assert!(!rt.chats.get("t-wd").unwrap().attention);
    }

    #[test]
    fn timeline_groups_events_by_step_boundaries() {
        // Events before the first Step marker live in the `None` bucket.
        // Events between two Step markers belong to the earlier marker's
        // canonical step until the next Step marker rolls the bucket over.
        let mut chat = ChatTabState::new("t-tl".into());

        let events = [
            ("info", "Starting up"),
            ("info", "Step: generating branch name"),
            ("info", "Branch name: ai/test-123"),
            ("info", "Step: creating worktree"),
            ("info", "Worktree created at: /tmp/x"),
            ("info", "Step: generating implementation"),
            ("info", "modify: src/foo.rs"),
        ];
        for (i, (lvl, msg)) in events.iter().enumerate() {
            chat.apply_event(&AgentEvent {
                id: format!("e-{}", i),
                level: (*lvl).into(),
                message: (*msg).to_string(),
                created_at: i as i64,
            });
        }

        let groups = chat.group_messages_by_step();
        assert_eq!(groups.len(), 4, "pre-start + branch + worktree + implement");
        assert_eq!(groups[0].0, None);
        assert_eq!(groups[1].0, Some("branch"));
        assert_eq!(groups[2].0, Some("worktree"));
        assert_eq!(groups[3].0, Some("implement"));

        // Branch group contains the Step marker and the Branch name:
        // message — two entries.
        assert_eq!(groups[1].1.len(), 2);
        // Implement group is whatever landed after the third Step marker.
        assert_eq!(groups[3].1.len(), 2);
    }

    #[test]
    fn reconcile_orphans_flags_existing_worktrees_without_live_chat() {
        // Fabricate a real temp directory to stand in for an existing worktree.
        let dir = std::env::temp_dir().join(format!(
            "voidlink-orphan-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let persisted = PersistedAgentsState {
            known_task_worktrees: vec![
                KnownWorktree {
                    task_id: "task-alive".into(),
                    worktree_path: dir.to_string_lossy().to_string(),
                    branch_name: "ai/alive".into(),
                    created_at: 0,
                },
                KnownWorktree {
                    task_id: "task-orphan".into(),
                    worktree_path: dir.to_string_lossy().to_string(),
                    branch_name: "ai/orphan".into(),
                    created_at: 0,
                },
                KnownWorktree {
                    task_id: "task-gone".into(),
                    worktree_path: "/definitely/does/not/exist/voidlink".into(),
                    branch_name: "ai/gone".into(),
                    created_at: 0,
                },
            ],
            ..PersistedAgentsState::default()
        };

        let mut rt = AgentsRuntime::new();
        // "alive" has a live chat so it should NOT be flagged as orphan.
        rt.insert_chat(ChatTabState::new("task-alive".into()));

        rt.reconcile_orphans(&persisted);

        let ids: Vec<_> = rt
            .orphan_worktrees
            .iter()
            .map(|w| w.task_id.as_str())
            .collect();
        assert!(!ids.contains(&"task-alive"), "alive chat must not be orphaned");
        assert!(ids.contains(&"task-orphan"), "orphan must be flagged");
        assert!(
            !ids.contains(&"task-gone"),
            "missing worktree path must be pruned"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_orphan_drops_entry() {
        let mut rt = AgentsRuntime::new();
        rt.orphan_worktrees.push(KnownWorktree {
            task_id: "x".into(),
            worktree_path: "/tmp/x".into(),
            branch_name: "b".into(),
            created_at: 0,
        });
        rt.remove_orphan("x");
        assert!(rt.orphan_worktrees.is_empty());
    }

    #[test]
    fn classify_step_recognises_canonical_ids() {
        assert_eq!(classify_step("generating branch name"), Some("branch"));
        assert_eq!(classify_step("creating worktree"), Some("worktree"));
        assert_eq!(
            classify_step("generating implementation"),
            Some("implement")
        );
        assert_eq!(classify_step("committing changes"), Some("commit"));
        assert_eq!(classify_step("pushing branch"), Some("push"));
        assert_eq!(classify_step("creating pull request"), Some("pr"));
        assert_eq!(classify_step("nonsense"), None);
    }
}
