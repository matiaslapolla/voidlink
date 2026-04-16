# Phase 7 — Agent System (egui migration)

> Planning doc. Scope: **agent chat + autonomous orchestrator + live diff + multi-session PTY** for the `desktop/` (eframe + egui 0.31) crate.
>
> Companion docs: `docs/egui-ui-parity-guide.md` (tokens + primitives, _do not duplicate_), `docs/rust-native.md` (migration rationale).
>
> Status: Phases 0–6 merged. Phase 7 is the final UX surface required to retire `src-tauri/` and `frontend/`.

---

## 1. Goals & Non-Goals

### 1.1 Ships in Phase 7

1. **Agent Chat tab** — conversational UI over the `git_agent` autonomous pipeline. One tab per chat/task, streaming events rendered as chat bubbles, inline live-diff side panel, composer with Enter/Shift-Enter semantics. Parity with `frontend/src/components/agent/AgentChatView.tsx` (530 lines).
2. **Agent Orchestrator tab** — multi-session launcher/monitor for external CLI agents (`claude`, `codex`, `opencode`), each running in its own PTY inside a dedicated git worktree, with a live-diff drawer. Parity with `frontend/src/components/agent/AgentOrchestratorView.tsx` (373 lines).
3. **Autonomous task form** — "Create task" variant that lets the user specify objective, constraints, branch name, base ref, and auto-PR toggle, then streams pipeline events to an event timeline with step progress and a PR draft preview.
4. **Live diff** — real-time view of what the agent has written into its worktree, available both inline in chat (right-hand files panel) and as a collapsible drawer in the orchestrator.
5. **Sidebar "Agents" page** — lists chats, autonomous tasks, and detected CLI tools with availability indicators.
6. **Persistence of session metadata** — surviving task IDs and PTY IDs across app restarts so a user who crashes doesn't lose their worktree (metadata only — the agent process itself is assumed dead on restart and marked `Orphaned`).

### 1.2 Explicitly deferred

- **No MCP tool-call rendering pipeline.** The `git_agent` pipeline doesn't emit structured tool calls today — it emits free-text `AgentEvent`s. Rendering typed tool blocks ("read_file", "apply_diff") is **Phase 8**.
- **No interactive chat with the LLM** (turn-taking, multi-turn context). Today's pipeline is one-shot — the user's "message" is `AgentTaskInput.objective`. Parity holds: the SolidJS chat has the same shape.
- **No copy/retry buttons on individual messages** (P8). Composer copy/paste via keyboard only.
- **No attachments in the composer** (images, files) — the SolidJS version doesn't have this either, despite the paperclip-adjacent design. Do not add it.
- **No in-app PR review** — the "Create PR" button opens the browser (handled by existing git review module in P6).
- **No resuming a dead PTY session**. If the process dies, the user must clean up and relaunch.
- **No streaming LLM token rendering for chat messages.** The pipeline calls `migration_state.llm_chat(..)` synchronously and returns a final string per step. If/when provider streaming lands (Phase 8+), we plug into the same UI.

---

## 2. Feature Inventory — SolidJS → egui

| SolidJS feature | Location | egui equivalent |
| --- | --- | --- |
| Chat bubble list (user/assistant/system, colour-coded status) | `AgentChatView.tsx:302-341` | `ChatMessage` widget — `egui::Frame` with `CornerRadius`, token-driven fill, `Label::wrap`. 4 variants (user, assistant, system, tool-result) |
| Typing indicator (3 bouncing dots) | `AgentChatView.tsx:344-357` | `TypingIndicator` — `ctx.animate_value_with_time` on 3 dot alphas, 60 fps repaint while `isRunning()` |
| Status bar (spinner/check/X + step name + branch name + PR link + cancel) | `AgentChatView.tsx:234-284` | `TaskStatusBar` — horizontal `ui.horizontal` layout using `StatusBadge` + `Button("Cancel")` + `Hyperlink` for PR. Spinner = `egui::Spinner` |
| Composer textarea (Enter submit, Shift+Enter newline, auto-grow) | `AgentChatView.tsx:364-396` | `MessageComposer` — `egui::TextEdit::multiline().desired_rows(1).frame(false)` in a rounded `Frame`. Intercept `Key::Enter` without `Modifiers::SHIFT` via `ui.input(|i| ...)`. Send button disabled when trimmed text empty |
| Files panel (collapsible file list + inline unified diff, resizable) | `AgentChatView.tsx:399-530` | `LiveDiffPanel` — reuse `git_panel::render_diff_rows` from `desktop/src/ui/git_panel.rs`. Resize = `egui::SidePanel::right(..).resizable(true)` |
| Session list (left rail, launcher form, status dots, attention badge) | `AgentOrchestratorView.tsx:157-223` | `AgentSessionList` — `egui::ScrollArea::vertical()` with selectable rows. Attention badge = small coloured circle painted over status dot |
| PTY terminal pane for a CLI session | `AgentOrchestratorView.tsx:333-335` | `TerminalView` — reuse existing `egui_term::TerminalView` widget already used by `desktop/src/ui/bottom_pane.rs`. One `TerminalBackend` per session |
| Orchestrator diff drawer (toggle + 240 px panel) | `AgentOrchestratorView.tsx:337-366` | `CollapsibleDiffDrawer` — `TopBottomPanel::bottom` scoped inside the orchestrator tab |
| Launcher form (branch input + tool buttons + error) | `AgentOrchestratorView.tsx:228-278` | `AgentLauncherForm` — inline popover/accordion at top of the right pane |
| Autonomous task form (objective textarea, constraint list editor, auto-PR toggle, branch hint, base ref) | (implicit in `git_agent_start` + chat UI) | `TaskCreateForm` — structured form that accepts `AgentTaskInput` and calls `start_task`. Displays branch name *hint* computed from objective but user-editable |
| Event timeline grouped by step | (implicit in `taskState.events`) | `EventTimeline` — vertical list: each `steps_completed` entry becomes a collapsible group showing all events whose `created_at` falls between step boundaries |
| PR draft preview + "Create PR" | (implicit — auto-PR creates draft) | `PrDraftCard` — displays title/body/labels from `PrDescription`, with "Open in browser" button once `pr_url` is set |
| Sidebar → Agents page | Sidebar entry in `frontend/src/App.tsx` (not shown but mapped) | `SidebarPage::Agents` with three collapsible sections: **Chats**, **Autonomous tasks**, **Detected CLIs** |

### 2.1 Live-diff mechanism — decision

Candidate | Pros | Cons
---|---|---
**A. Time-based polling** (what SolidJS does, every 3–5 s) | Trivial to implement. Matches existing working `git_diff_working_impl`. Works regardless of FS backend. | Up to 5 s stale; wastes cycles if no changes; extra git walks on each tick
**B. File watcher (`notify`)** | Near-instant reactivity; zero cost when idle | Cross-platform quirks (macOS FSEvents coalescing, Linux inotify watch limits); must re-run `git_diff_working_impl` on events anyway so the watcher is only a *trigger*
**C. Pipeline-event hook** (pipeline emits `diff-changed` after each file write) | Exact; no polling at all | Requires touching `voidlink-core::git_agent::pipeline`; doesn't cover CLI-agent PTY case (claude/codex write files independently of our pipeline)

**Decision: A + C hybrid.**

- For autonomous-task tabs (`AgentChat`) → **C**: extend `pipeline.rs` to emit an additional `AgentEvent` with `level = "diff-update"` after each `std::fs::write`. The UI triggers a fresh `git_diff_working_impl` call when it sees that event. No polling.
- For CLI-agent sessions (`AgentTerminal`) → **A**: poll every 3 seconds while the terminal tab is *visible* (gated behind `ctx.memory(|m| m.is_tab_visible(..))` — actually simpler: only poll when the diff drawer is expanded).

Rejected **B** entirely — added dependency, fragile watch limits, and we end up polling anyway after the trigger. Not worth it.

---

## 3. Architecture Decisions

### 3.1 Where does `agent_session.rs` live?

**Decision: move it to `voidlink-core/src/agent_session/` (new submodule) and strip the Tauri types out.**

The current file has three hard Tauri deps:

1. `use tauri::Emitter;` + `tauri::AppHandle` — already abstracted behind `voidlink_core::events::EventEmitter`.
2. `use tauri::ipc::InvokeResponseBody;` + `PtyChannels = Arc<DashMap<String, Channel>>` — this is the output sink for PTY bytes. Needs replacement.
3. `PtyStore = Arc<DashMap<String, PtySession>>` where `PtySession` itself is Tauri-agnostic (already uses `portable_pty`). Fine.

Replacement for (2): introduce a `PtyOutputSink` trait in core.

```rust
// voidlink-core/src/agent_session/sink.rs
pub trait PtyOutputSink: Send + Sync + 'static {
    /// Called on every chunk of bytes read from the PTY master.
    fn push(&self, pty_id: &str, data: &[u8]);
    /// Called once when the child process exits (EOF or error).
    fn on_exit(&self, pty_id: &str);
}
```

In Tauri land, one implementor wraps `Channel::send(InvokeResponseBody::Raw(..))` + `app.emit("pty-exit:{}", ())`. In the egui desktop app, the implementor enqueues bytes directly into the `egui_term::TerminalBackend` via `process_command(BackendCommand::Write(..))` and calls `ctx.request_repaint()`. **However** — `egui_term::TerminalBackend` already owns its own PTY internally and wants to spawn the child itself. So for Phase 7, the egui app uses `egui_term` for shell terminals **and** for CLI-agent PTYs: `spawn_session` in core is used only from the Tauri shell. The egui app calls a parallel, simpler path.

**Revised decision:**

- Keep `agent_session.rs` for the legacy Tauri shell (frozen). Do **not** move it.
- In `voidlink-core/src/agent_session/` add a *new* smaller module that wraps `egui_term::TerminalBackend` construction with the worktree-creation boilerplate so the desktop crate can call a single function.

Wait — `voidlink-core` must not depend on `egui_term` (it's a UI crate depending on `eframe`). So the helper in core can only do the worktree + input validation; the `TerminalBackend` spawn has to live in `desktop/`.

**Final decision:**

- `voidlink-core/src/agent_session/mod.rs` (NEW, ~80 LOC): pure logic — worktree creation, branch-name derivation, `AgentSessionInfo` population. No PTY, no UI.
  ```rust
  pub fn prepare_session(input: StartSessionInput) -> Result<PreparedSession, String>;
  pub struct PreparedSession {
      pub session_id: String,
      pub pty_id: String,
      pub worktree_path: String,
      pub branch_name: String,
      pub initial_command: String, // e.g. "claude "
      pub info: AgentSessionInfo,
  }
  pub fn teardown_session(info: &AgentSessionInfo) -> Result<(), String>; // removes worktree
  ```
- `desktop/src/state/agents.rs` calls `prepare_session()` then spawns an `egui_term::TerminalBackend` with `working_directory = worktree_path`, `initial_command` written to the PTY after open.
- `src-tauri/src/agent_session.rs` stays as-is (frozen).

This is cleaner than moving the file and having half of it dead.

### 3.2 Threading model: how the egui UI receives pipeline events

The `git_agent` pipeline (`voidlink-core/src/git_agent/pipeline.rs`) runs on a `std::thread::spawn` and accepts `Arc<dyn EventEmitter>`.

**Options:**

1. Impl `EventEmitter` with `mpsc::Sender<AgentEvent>` → UI holds `Receiver`, drains in `update()`
2. Impl `EventEmitter` that appends to an `Arc<Mutex<VecDeque<AgentEvent>>>` → UI polls that queue
3. Impl `EventEmitter` that calls `ctx.request_repaint()` + shared state → UI reads from `git_agent::GitAgentState::tasks` each frame

**Decision: (1) with `crossbeam_channel::Sender` (unbounded) + `ctx.request_repaint_after(..)`.**

Rationale:
- The pipeline already writes to `tasks: Arc<Mutex<HashMap<...>>>` for status. That's fine for "give me the canonical state right now" queries.
- For **live updates**, a channel is cleaner than polling — it tells us exactly which events are new (no `seenEventIds` tracking like SolidJS).
- `crossbeam_channel` over `std::sync::mpsc` because `Receiver::try_iter()` is nicer (already a dep transitively via `egui`/`eframe`).
- The emitter calls `ctx.request_repaint()` on each push so the egui event loop wakes within one frame.

```rust
// desktop/src/state/agents.rs
pub struct EguiEmitter {
    pub ctx: eframe::egui::Context,
    pub tx: crossbeam_channel::Sender<PipelineMsg>,
}

pub enum PipelineMsg {
    Event { task_id: String, event: AgentEvent },
    StatusChanged { task_id: String },
    PtyBytes { pty_id: String, chunk: Vec<u8> },
    PtyExit { pty_id: String },
    NeedsAttention { session_id: String },
    Active { session_id: String },
}

impl voidlink_core::events::EventEmitter for EguiEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        // Parse the event name (e.g. "git-agent-event:{task_id}") + payload into a PipelineMsg.
        if let Some(task_id) = event.strip_prefix("git-agent-event:") {
            if let Ok(ev) = serde_json::from_value::<AgentEvent>(payload) {
                let _ = self.tx.send(PipelineMsg::Event { task_id: task_id.to_string(), event: ev });
                self.ctx.request_repaint();
            }
        }
        Ok(())
    }
    fn emit_bytes(&self, event: &str, _data: Vec<u8>) -> Result<(), String> { Ok(()) }
}
```

The UI drains `rx.try_iter()` at the top of every `update()` and applies deltas to `RuntimeState::agents`.

### 3.3 Streaming chat — how tokens reach the UI

Phase 7 does **not** stream LLM tokens (the pipeline's `llm_chat` is synchronous end-to-end). But the channel built above is already the right shape for streaming: when `migration/provider.rs` grows a `stream()` variant in Phase 8, the emitter just pushes `PipelineMsg::Token { task_id, delta }` frames. The UI buffers them into the last assistant `ChatMessage.content` and calls `ctx.request_repaint()` — same pattern as rendering `AgentEvent`s now.

So the chat UI's `ChatMessage` struct is designed to grow in place (`content: String`, mutable), not be immutable per-message. This avoids re-architecture in Phase 8.

### 3.4 State shape — new fields

#### 3.4.1 Persisted (`AppState` in `desktop/src/state/mod.rs`)

```rust
// Add to AppState:
#[serde(default)]
pub agents: PersistedAgentsState,

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedAgentsState {
    /// Historical task ids + their worktree path so we can offer "clean up orphan worktree"
    /// on next launch. Full event history is NOT persisted — it lives in memory.
    pub known_task_worktrees: Vec<KnownWorktree>,
    /// Tool preferences.
    pub default_tool: Option<AgentTool>,
    pub default_constraints: Vec<String>,
    pub default_auto_pr: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownWorktree {
    pub task_id: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub created_at: i64,
}
```

#### 3.4.2 Runtime (`RuntimeState`)

```rust
// Add to RuntimeState:
pub agents: AgentsRuntime,

pub struct AgentsRuntime {
    // ── Autonomous tasks (git_agent pipeline) ──
    pub tasks: HashMap<String, ChatTabState>,                  // keyed by task_id
    pub git_agent_state: Arc<GitAgentState>,                   // shared with core pipeline
    pub emitter_tx: crossbeam_channel::Sender<PipelineMsg>,
    pub emitter_rx: crossbeam_channel::Receiver<PipelineMsg>,

    // ── External CLI sessions ──
    pub sessions: HashMap<String, CliSessionState>,            // keyed by session_id
    pub runner_state: Arc<AgentRunnerState>,
    pub attention: HashSet<String>,                             // session_ids with "needs-attention"

    // ── Detected binaries (refresh every 30s) ──
    pub detected_tools: Vec<String>,
    pub detected_at_frame: u64,

    // ── Launcher form ──
    pub launcher: LauncherFormState,
    // ── Task creation form ──
    pub task_form: TaskFormState,
}

pub struct ChatTabState {
    pub task_id: String,
    pub messages: Vec<ChatMessage>,
    pub task: Option<AgentTaskState>,       // last-known pipeline state
    pub seen_event_ids: HashSet<String>,
    pub worktree_diff: Option<DiffResult>,
    pub diff_needs_refresh: bool,
    pub files_panel_width: f32,
    pub selected_file: Option<String>,
    pub input: String,                      // composer buffer
}

pub struct CliSessionState {
    pub info: AgentSessionInfo,
    pub terminal_id: u64,                   // → RuntimeState::terminals
    pub worktree_diff: Option<DiffResult>,
    pub diff_drawer_open: bool,
    pub last_diff_refresh_frame: u64,
}
```

#### 3.4.3 New `TabKind` variants

```rust
pub enum TabKind {
    // ... existing ...
    AgentChat { task_id: String },
    AgentOrchestrator,              // singleton tab, like Search
    AgentCliTerminal { session_id: String },
}
```

`AgentOrchestrator` is a singleton because it *is* the orchestrator — list + detail in one view. If the user wants per-session focus, they click a session and we also open an `AgentCliTerminal` tab in the top-pane tabbar. (Matches the SolidJS behaviour where the orchestrator owns the TerminalPane inline, but egui's modal tab system prefers dedicated tabs.)

---

## 4. Sidebar — `SidebarPage::Agents`

The existing `SidebarPage::Agent` (singular) enum variant will be **renamed to `Agents`** for consistency with the other plural pages in the parity guide (no effect since labels are string-driven).

Structure (`desktop/src/ui/agents/sidebar.rs`):

```
┌─ Agents ────────────────────────────┐
│ [+ New chat]     [+ New task]       │  ← two primary buttons, uses `buttons::primary`
├──────────────────────────────────────┤
│ ▼ Chats (3)                         │
│   ● Add error boundary         2m   │
│   ● Refactor auth              14m  │  ← selecting opens AgentChat tab
│   ○ Port to new SDK          done   │
│ ▼ Autonomous tasks (1)              │
│   ⟳ Generate migration plan   →PR   │
│ ▼ CLI sessions (2)                  │
│   ● claude  feat/foo-123      run   │
│   ⚠ codex   feat/bar-456     attn   │
│ ▼ Detected CLIs                     │
│   ✓ claude    ✓ codex    ✗ opencode │
└──────────────────────────────────────┘
```

Each list row uses the parity-guide `list_item` primitive with an optional leading status dot (`tokens.success`, `tokens.warning`, `tokens.text_muted`). Attention = pulsing warning dot, painted via `ctx.animate_value_with_time`.

---

## 5. Component List

Each new widget below goes in `desktop/src/ui/agents/components/`. LOC targets are rough; primitives referenced are from `egui-ui-parity-guide.md` §3.

| Widget | Purpose | LOC | Parity primitives composed |
|---|---|--:|---|
| `ChatMessage` | Render one user/assistant/system/tool bubble with status tint | ~120 | `Frame`, `CornerRadius`, `Label` wrap, status-tint via `tokens.danger_subtle`/`tokens.success_subtle`/etc |
| `TypingIndicator` | 3 bouncing dots while running | ~30 | `ctx.animate_value_with_time` (§2.2), `Circle` painter |
| `MessageComposer` | Multi-line textarea + send btn + Enter/Shift-Enter handling | ~90 | `TextEdit::multiline`, `buttons::primary`, `focus_ring` |
| `TaskStatusBar` | Top-of-chat bar: spinner/check/X + step + branch + PR + cancel | ~100 | `StatusBadge`, `Spinner`, `Hyperlink`, `buttons::ghost` |
| `TaskCreateForm` | Objective + constraints + auto-PR toggle + start | ~200 | `TextEdit`, `ConstraintsEditor`, `Switch` (§3.10 parity), `buttons::primary` |
| `ConstraintsEditor` | Dynamic list of string inputs with +/− | ~80 | `TextEdit::singleline`, `buttons::ghost`, `Icon::plus`/`x` |
| `EventTimeline` | Vertical list of AgentEvents grouped by step | ~140 | `CollapsingHeader`, level-coloured gutter (info/warn/error) |
| `StepProgress` | Horizontal step pips: branch→worktree→implement→commit→push→pr | ~80 | `Circle` painter, `tokens.primary`/`tokens.success`/`tokens.border` |
| `StatusBadge` (reuse) | "running" / "done" / "failed" pill | ~30 | already in parity guide §3.6 |
| `LiveDiffPanel` | Collapsible list of changed files + inline unified diff | ~220 | reuse `git_panel::render_diff_rows` (extract function if needed) |
| `AgentSessionList` | Left-rail list of CLI sessions with status dot + attention badge | ~140 | `list_item` primitive, painter for attention dot |
| `AgentLauncherForm` | Inline form: branch input + tool buttons + error | ~120 | `TextEdit`, `buttons::secondary`, `Alert::warn` |
| `PrDraftCard` | Show title/body/labels preview + "Open PR" button | ~100 | `Frame`, `Label`, `LabelChip`, `Hyperlink` |
| `CliTerminalView` | Wraps `egui_term::TerminalView` inside agent context | ~60 | existing terminal backend reused |
| `DetectedToolsRow` | ✓/✗ per CLI binary | ~40 | `Icon::check`/`x`, `tokens.success`/`tokens.text_muted` |

**Sketch — `ChatMessage` API:**

```rust
pub struct ChatMessage {
    pub id: String,
    pub role: Role,
    pub content: String,        // mutable; grows when streaming
    pub timestamp_ms: i64,
    pub status: MessageStatus,  // Info | Warn | Error | Success | None
}

pub enum Role { User, Assistant, System, ToolResult }
pub enum MessageStatus { None, Info, Warn, Error, Success }

pub fn show(ui: &mut Ui, msg: &ChatMessage, tokens: &ThemeTokens);
```

**Sketch — `AgentCtx` (passed down into all widgets):**

```rust
pub struct AgentCtx<'a> {
    pub tokens: &'a ThemeTokens,
    pub repo_path: &'a str,
    pub agents: &'a mut AgentsRuntime,
    /// Channel back to the pipeline/emitter to issue actions (start/cancel/send).
    pub actions: &'a crossbeam_channel::Sender<AgentAction>,
}

pub enum AgentAction {
    StartTask(AgentTaskInput),
    CancelTask { task_id: String },
    StartCliSession(StartSessionInput),
    KillCliSession { session_id: String },
    CleanupCliSession { session_id: String },
    RefreshDiff { worktree_path: String, target: DiffTarget },
}

pub enum DiffTarget { Task(String), Session(String) }
```

An action dispatcher thread (spawned at app start) owns the receiver and calls the actual core functions, pushing results back through `PipelineMsg`.

---

## 6. Data & Event Flows

### 6.1 Autonomous task lifecycle

```
User clicks "+ New task" in sidebar
  → ui/agents/sidebar.rs opens TaskCreateForm in a new AgentChat tab
  → user fills form, hits Start
  → ChatTabState::new() pushed into RuntimeState::agents.tasks
  → AgentAction::StartTask sent on action channel

Dispatcher thread receives StartTask
  → calls git_agent::pipeline::run_agent_pipeline(task_id, input, tasks, migration, emitter)
     on a fresh std::thread::spawn (matches current Tauri behaviour)
  → pipeline runs sequentially: branch → worktree → implement → commit → push → pr
  → each pipeline step calls emitter.emit("git-agent-event:{task_id}", AgentEvent)
  → EguiEmitter parses the event name, forwards PipelineMsg::Event → channel
  → also re-emits PipelineMsg::DiffUpdate when the file-write step completes
     (requires ~10-line patch to pipeline.rs to emit a "diff-update" event after each std::fs::write)

Main thread (update() each frame):
  → drain rx.try_iter()
  → for PipelineMsg::Event { task_id, event }: append to ChatTabState.messages
     (format as assistant bubble with level→status mapping)
  → for PipelineMsg::DiffUpdate: mark ChatTabState.diff_needs_refresh = true
  → if diff_needs_refresh: spawn a one-shot thread calling git_diff_working_impl(worktree_path)
     and posting PipelineMsg::DiffResult back
  → when task.status transitions to "success"/"failed", append a terminal bubble
     and show the PrDraftCard if pr_url is set
```

### 6.2 CLI session (claude/codex/opencode)

```
User clicks "+ New chat" → AgentLauncherForm appears inline
  → user enters optional branch name, clicks "claude" button
  → AgentAction::StartCliSession sent

Dispatcher:
  → voidlink_core::agent_session::prepare_session(input) → PreparedSession
     (creates worktree, computes session/pty ids, derives initial command)
  → spawns egui_term::TerminalBackend via RuntimeState::terminals
     with working_directory = worktree_path
  → after backend is up, writes initial_command ("claude ") into the PTY
  → inserts CliSessionState into RuntimeState::agents.sessions
  → posts PipelineMsg::StatusChanged so the sidebar updates
  → opens TabKind::AgentCliTerminal { session_id } in the center area

Runtime:
  → egui_term::TerminalView handles all PTY IO directly (no custom reader thread)
  → idle-watchdog: a std::thread on app start polls all egui_term backends and
     emits PipelineMsg::NeedsAttention after 30s of no new bytes
     (or we skip this in P7 and land it in P7E — see rollout)
  → when diff drawer is expanded: center.rs calls a throttled git_diff_working_impl
     once per 3000ms (gated by frame count)
```

### 6.3 Sending a follow-up message in an existing chat

Parity-wise this is a no-op in Phase 7 (same as SolidJS): the first message *starts* a task; follow-ups in an in-flight task are ignored with a grey system bubble ("Agent is busy"). Once task is terminal, the composer shows "New chat" instead of Send. Implement as a simple button swap.

---

## 7. File-by-File Plan

### 7.1 `voidlink-core/`

| File | Action | Purpose | LOC |
|---|---|---|--:|
| `voidlink-core/src/agent_session/mod.rs` | **CREATE** | Pure session prep/teardown (no PTY, no UI). `prepare_session`, `teardown_session`, `derive_branch_name`. Types re-used from `agent_runner::{AgentSessionInfo, StartSessionInput, AgentTool}`. | ~90 |
| `voidlink-core/src/lib.rs` | MODIFY | `pub mod agent_session;` | +1 |
| `voidlink-core/src/git_agent/pipeline.rs` | MODIFY | (a) After each `std::fs::write` success, emit an extra `AgentEvent { level: "diff-update", .. }`. (b) Expose `pub fn subscribe_events(task_id, emitter) -> ..` if a second consumer needs the same stream — but current design has *one* emitter injected at start, so this is optional. | +15 |
| `voidlink-core/src/git_agent/mod.rs` | MODIFY | Add `AgentEvent::level` constants (`"diff-update"`). | +5 |
| `voidlink-core/src/agent_runner/mod.rs` | no change | Already clean and UI-agnostic. | — |
| `voidlink-core/src/events.rs` | no change | Already has `EventEmitter` trait. | — |

### 7.2 `desktop/`

| File | Action | Purpose | LOC |
|---|---|---|--:|
| `desktop/Cargo.toml` | MODIFY | Add `crossbeam-channel = "0.5"`, `portable-pty` (already transitive via `egui_term`? check; add only if missing). **No `notify`, no `tokio`.** | +2 |
| `desktop/src/state/mod.rs` | MODIFY | Add `TabKind::AgentChat/AgentOrchestrator/AgentCliTerminal`. Add `agents: AgentsRuntime` to `RuntimeState`. Add `agents: PersistedAgentsState` to `AppState`. Rename `SidebarPage::Agent` → `SidebarPage::Agents`. | +60 |
| `desktop/src/state/agents.rs` | **CREATE** | `AgentsRuntime`, `ChatTabState`, `CliSessionState`, `LauncherFormState`, `TaskFormState`, `PipelineMsg`, `AgentAction`, `EguiEmitter`, `spawn_dispatcher`. | ~380 |
| `desktop/src/state/persistence.rs` | MODIFY | Round-trip `PersistedAgentsState` under the `agents` key. On load, reconcile `known_task_worktrees` — if a worktree no longer exists on disk, prune it. | +40 |
| `desktop/src/ui/mod.rs` | MODIFY | `pub mod agents;` and route the new tab kinds to the appropriate view module. | +10 |
| `desktop/src/ui/sidebar.rs` | MODIFY | Add a branch for `SidebarPage::Agents` that calls `agents::sidebar::show(..)`. | +15 |
| `desktop/src/ui/center.rs` | MODIFY | Match on new `TabKind::AgentChat/AgentOrchestrator/AgentCliTerminal` and dispatch. Also drain the `PipelineMsg` channel once per frame here (or earlier in `update()`). | +40 |
| `desktop/src/ui/agents/mod.rs` | **CREATE** | Module root, re-exports. | ~20 |
| `desktop/src/ui/agents/sidebar.rs` | **CREATE** | `pub fn show(ui, state, ctx)` — chats list, tasks list, CLI sessions list, detected-tools row, "+ New chat"/"+ New task" buttons. | ~250 |
| `desktop/src/ui/agents/chat.rs` | **CREATE** | `pub fn show(ui, chat_state, ctx: &mut AgentCtx)` — full chat tab (status bar + scrollable message list + typing indicator + composer + right-side LiveDiffPanel). | ~450 |
| `desktop/src/ui/agents/orchestrator.rs` | **CREATE** | `pub fn show(ui, state, ctx)` — two-pane: session list + selected session detail. Selecting a session triggers opening the AgentCliTerminal tab. Contains AgentLauncherForm at top. | ~380 |
| `desktop/src/ui/agents/task_form.rs` | **CREATE** | `TaskCreateForm` — renders when `ChatTabState.task` is `None` instead of empty message list. Objective textarea + constraints editor + branch input + base ref + auto-PR toggle + Start button. | ~260 |
| `desktop/src/ui/agents/cli_terminal.rs` | **CREATE** | `pub fn show(ui, session_state, ctx)` — dedicated tab for a single CLI session. Header (tool, worktree, status, Cancel/Cleanup) + terminal via `egui_term::TerminalView` + collapsible diff drawer. | ~220 |
| `desktop/src/ui/agents/components/chat_message.rs` | **CREATE** | `ChatMessage` widget. | ~120 |
| `desktop/src/ui/agents/components/typing.rs` | **CREATE** | `TypingIndicator`. | ~30 |
| `desktop/src/ui/agents/components/composer.rs` | **CREATE** | `MessageComposer`. | ~100 |
| `desktop/src/ui/agents/components/status_bar.rs` | **CREATE** | `TaskStatusBar`. | ~100 |
| `desktop/src/ui/agents/components/event_timeline.rs` | **CREATE** | `EventTimeline` + `StepProgress`. | ~220 |
| `desktop/src/ui/agents/components/diff_panel.rs` | **CREATE** | `LiveDiffPanel`. Extracts the relevant row-rendering helper from `git_panel.rs` into a shared `desktop/src/ui/components/diff_rows.rs` if not already done. | ~230 |
| `desktop/src/ui/agents/components/launcher.rs` | **CREATE** | `AgentLauncherForm` + `DetectedToolsRow`. | ~160 |
| `desktop/src/ui/agents/components/pr_draft.rs` | **CREATE** | `PrDraftCard`. | ~100 |
| `desktop/src/ui/agents/components/constraints_editor.rs` | **CREATE** | `ConstraintsEditor`. | ~80 |
| `desktop/src/ui/components/diff_rows.rs` | **CREATE** (or extract) | Shared unified-diff row renderer used by both `git_panel` and agent `LiveDiffPanel`. Extract from the existing ~250-LOC diff section in `ui/git_panel.rs`. | ~180 (moved, not new logic) |
| `desktop/src/main.rs` | MODIFY | After `RuntimeState::default()`, call `agents::spawn_dispatcher(&ctx, &mut runtime.agents)` once. | +8 |

### 7.3 Totals

- **New files:** 18 (1 in core, 17 in desktop)
- **Modified files:** 8
- **New Rust LOC planned:** ~3,300 (agents module + state + components), of which ~180 is extraction, not new logic
- **Net new logic:** ~3,100 LOC
- **Core additions:** ~110 LOC

---

## 8. Dependencies

| Crate | Version | Why | Verdict |
|---|---|---|---|
| `crossbeam-channel` | 0.5 | Cleaner `try_iter()` + `select!` than `std::sync::mpsc`; transitively present already via egui | **ADD** to `desktop/Cargo.toml` explicitly |
| `notify` | — | Considered for live-diff. Rejected in §2.1 | **SKIP** |
| `tokio` | — | Pipeline is sync std-thread today; egui is sync | **SKIP** |
| `portable-pty` | 0.9 | Already used by `src-tauri` for agent_session; `egui_term` vendors it | **SKIP** (transitive is fine — don't double-declare) |
| `similar` / `similar-asserts` | — | Diff rendering uses existing `git::DiffResult` already; no new diff engine needed | **SKIP** |
| `lucide-egui` / icon crate | — | Parity guide already settles on a small hand-rolled icon set in `theme/icons.rs` | **SKIP** |

Net: **one new dep** (`crossbeam-channel`). Keeps the binary lean.

---

## 9. Phased Rollout

| Sub-phase | Scope | Files touched | Verification | Estimate |
|---|---|---|---:|---:|
| **7A — State plumbing** | `AgentsRuntime`, `PipelineMsg`, `AgentAction`, `EguiEmitter`, dispatcher thread, persistence, `TabKind` variants, `SidebarPage::Agents` rename | `state/agents.rs`, `state/mod.rs`, `state/persistence.rs`, `main.rs` | `cargo check -p voidlink-desktop` passes. App starts, opens empty Agents sidebar page. | 1 day |
| **7B — Autonomous task (chat) MVP** | `ChatTabState`, `TaskCreateForm`, basic `ChatMessage` rendering, `TaskStatusBar`, event→bubble mapping. No live diff yet. | `ui/agents/{chat.rs,task_form.rs,components/{chat_message,status_bar,composer}.rs}` + core pipeline patch for `diff-update` events | Manually: fire a task with a local LLM (Ollama), see events stream into chat, status transitions through steps, terminal bubble on success. | 2 days |
| **7C — Live diff** | `LiveDiffPanel`, shared `diff_rows.rs` extraction, `diff_needs_refresh` flow, right-side resizable panel in chat | `ui/agents/components/diff_panel.rs`, `ui/components/diff_rows.rs`, `ui/git_panel.rs` (extract only) | Start a task; as the agent writes files, the right panel updates within ~1s of each write. Click file → expanded inline diff matches git_panel. | 1.5 days |
| **7D — CLI orchestrator + multi-session PTY** | `AgentOrchestrator` tab, `AgentSessionList`, `AgentLauncherForm`, `CliSessionState`, `CliTerminalView`, `AgentCliTerminal` tab | `voidlink-core/src/agent_session/mod.rs`, `ui/agents/{orchestrator.rs,cli_terminal.rs,components/launcher.rs}` | Launch `claude` and `codex` concurrently in two sessions. Each has its own worktree. Diff drawer shows per-session diff. Kill/Cleanup work. | 2 days |
| **7E — Polish + idle watchdog + PR draft card** | `TypingIndicator`, `EventTimeline` collapsing by step, `PrDraftCard`, attention badge + watchdog thread, orphan-worktree reconcile on launch | `ui/agents/components/{typing,event_timeline,pr_draft}.rs`, `state/agents.rs` (watchdog), `state/persistence.rs` | Go through the full SolidJS flow visually, side-by-side, and confirm parity. | 1.5 days |

**Total:** ~8 engineer-days.

---

## 10. Risks & Open Questions

### 10.1 Risks

1. **PTY lifetime across app restarts.** `egui_term::TerminalBackend` spawns the child when the backend is constructed; we can't *reattach* to an existing PTY after a crash. The running agent process (claude/codex) will orphan. Mitigation: on app startup, walk `known_task_worktrees` and surface them in the sidebar under an "Orphaned" group with a "Clean up worktree" button. Do not try to reattach — explicitly out of scope.
2. **Cancelling a mid-run pipeline cleanly.** `git_agent_cancel` in the Tauri shell only mutates task state — it does NOT signal the running `std::thread` blocked in `migration_state.llm_chat()`. Same limitation will exist in egui. Document as a known issue; a proper fix (pass an `AtomicBool` cancel flag down into `llm_chat`) is Phase 8.
3. **Worktree deleted while agent is running.** If the user force-cleans a worktree externally, the next `std::fs::write` in the pipeline will fail and raise an `emit_event!("warn", ..)`. Task status becomes `failed`. UI handles this path — just verify.
4. **Tokens leaking into chat logs.** `AgentEvent.message` includes the branch name and sometimes truncated LLM output. It *should not* include API keys (pipeline never logs them). Add a sanity grep test: the pipeline code must not format `migration_state.api_keys` into any event string. Add a unit test that asserts `make_event` with any API-key-looking payload is not emitted (defensive — we're not paranoid, just thorough).
5. **`SidebarPage::Agent` → `Agents` rename**. Breaks serialized `AppState`. Use `#[serde(alias = "Agent")]` or bump a persistence version. Decision: add alias, don't bump version — the existing persistence logic has `#[serde(default)]` on new fields, so this is forward-compatible.
6. **Event channel unbounded growth.** If the user leaves a task running in the background, `ChatTabState.messages` can grow without bound. The pipeline already caps `AgentTaskState.events` to 500 (see `pipeline.rs:62-64`). We mirror that: cap `ChatTabState.messages` at 1000 (drop oldest).
7. **`egui_term` one-backend-per-tab assumption.** The crate hasn't been stress-tested with 3+ simultaneous backends. Mitigation: phase 7D test specifically runs 3 concurrent sessions. If `egui_term` misbehaves, fall back to rendering raw scrollback bytes in an `egui::TextEdit::multiline` read-only with ANSI stripping.

### 10.2 Open questions

- **Should a chat and its pipeline task be 1:1 or 1:many?** Today: 1:1 (one objective → one pipeline run). SolidJS also 1:1. Confirmed.
- **Is the "autonomous task" tab distinct from the "chat" tab, or the same tab with a different initial state?** Decision: **same tab** (`TabKind::AgentChat`). The distinction is purely whether the user entered via "+ New chat" (opens directly to `TaskCreateForm`) or from the orchestrator (opens with an already-running task). Keeps code paths unified.
- **Where does an orphan worktree get its label in the sidebar?** Decision: `branch_name` (persisted), colour = `tokens.text_muted`, sub-label = "no active process".
- **Do we surface the `git_generate_pr_description` + `git_create_pr` path for non-auto-PR flows?** The SolidJS chat calls `gitAgentApi.proposePr` / `.createPr` from `taskState.prUrl === null && status === 'success'`. Answer: yes — the `PrDraftCard` widget takes over the post-success state and offers a "Create PR" button for non-auto-PR runs. Phase 7E.

---

## 11. Test Plan

### 11.1 Golden path (manual)

1. Launch desktop app. Open a repo. Click Agents sidebar icon.
2. Click "+ New task". Fill objective ("Add a health-check endpoint"). Add one constraint ("Do not touch package.json"). Leave auto-PR off. Click Start.
3. Observe:
   - Status bar shows spinner + "branching" → "implementing" → "committing" → "pushing".
   - Chat bubbles stream in with correct level tints.
   - After "implementing" starts, the right-hand Modified Files panel appears.
   - Panel updates as files land.
   - On success, terminal bubble appears + `PrDraftCard` renders title/body preview.
   - Clicking "Create PR" opens the browser (or shows a PR URL once creation succeeds).
4. Open a second chat in parallel. Verify both run without cross-contamination.
5. In orchestrator: "+ New agent" → pick `claude` → verify terminal opens, cwd is the new worktree, initial prompt `claude ` is pre-filled.
6. Kill a running CLI session → status dot → red. Clean up → worktree removed from disk.

### 11.2 Edge cases

| Case | Expected |
|---|---|
| LLM provider offline (Ollama down, no API key) | First step errors → task status = `failed` → error bubble with the provider message, no dangling worktree |
| CLI binary missing (`claude` uninstalled) | Launcher form shows warning; tool button absent. Sidebar "Detected CLIs" row shows ✗ |
| Cancel mid-implementation | `git_agent_cancel` marks task failed; pipeline thread continues to completion but later writes are no-ops (status check). Document as known. |
| 3 simultaneous CLI sessions | All 3 terminals render; no flicker; diff polling per-session unaffected |
| App restart with an in-flight task | Task ID in persisted list, but no live state. Show as Orphaned in sidebar with "Clean up worktree". Worktree path verified to still exist on disk. |
| Worktree manually deleted during run | Next file-write step errors; task status = failed; UI shows error bubble |
| Very long event stream (500+ events in `AgentTaskState.events`) | Pipeline caps at 500, UI caps messages at 1000 — no unbounded memory growth |
| Very wide diff line (1000+ cols) | Line wraps inside the diff panel (unlike SolidJS which `overflow-x-auto`s) — matches existing `git_panel` behaviour |
| Binary file in diff | Shows "Binary file" placeholder — reuses existing `git_panel` behaviour |
| Composer: Enter vs Shift+Enter | Enter → send; Shift+Enter → newline. Verify on all three OS keymaps (mac cmd+Enter also accepted). |
| PR creation fails (no GITHUB_TOKEN) | Warning bubble; task still marked success; user can click Create PR manually via `PrDraftCard` after setting token |

### 11.3 Automated (where feasible)

- Unit: `agent_session::prepare_session` returns a unique `session_id`/`pty_id` pair and a worktree path under `<repo>/.git/worktrees/`.
- Unit: `EguiEmitter::emit("git-agent-event:foo", ..)` produces a `PipelineMsg::Event { task_id: "foo", .. }`.
- Unit: `ChatTabState::append_event` dedupes by event ID and caps at 1000.
- Integration (optional, needs dummy LLM): `run_agent_pipeline` with a mocked `migration_state` that returns a canned JSON change-set → verify events emitted match the expected sequence.

---

## Appendix A — Reference: SolidJS → egui component file map

| Replaces | New file |
|---|---|
| `frontend/src/components/agent/AgentChatView.tsx` | `desktop/src/ui/agents/chat.rs` + components/* |
| `frontend/src/components/agent/AgentOrchestratorView.tsx` | `desktop/src/ui/agents/orchestrator.rs` + `cli_terminal.rs` |
| `frontend/src/api/agent-runner.ts` | direct `AgentAction` calls to dispatcher |
| `frontend/src/api/git-agent.ts` | direct calls to `voidlink_core::git_agent::pipeline::run_agent_pipeline` |
| `frontend/src/types/agent-runner.ts`, `types/git.ts` (AgentEvent, AgentTaskState) | already in `voidlink_core::{agent_runner, git_agent}` |
| `frontend/src/components/terminal/TerminalPane.tsx` | `egui_term::TerminalView` direct |
| `frontend/src/components/git/DiffViewer.tsx` | `ui/components/diff_rows.rs` (extracted from `git_panel.rs`) |
| `frontend/src/components/layout/ResizeHandle.tsx` | `egui::SidePanel::right(..).resizable(true)` built-in |

## Appendix B — Reference: Tauri commands → egui call sites

| Tauri command (legacy) | egui equivalent |
|---|---|
| `git_agent_start(input)` | `AgentAction::StartTask(input)` → dispatcher → `pipeline::run_agent_pipeline` on `std::thread` |
| `git_agent_status(id)` | `RuntimeState::agents.tasks.get(&id).task.clone()` |
| `git_agent_cancel(id)` | `AgentAction::CancelTask { id }` → dispatcher → `GitAgentState::tasks` mutation |
| `git_generate_pr_description(..)` | direct sync call (already in core) |
| `git_create_pr(..)` | direct sync call (already in core) |
| `agent_list_sessions()` | `RuntimeState::agents.sessions.values().collect()` |
| `agent_start_session(input)` | `AgentAction::StartCliSession(input)` → dispatcher → `agent_session::prepare_session` + `TerminalManager::spawn` |
| `agent_kill_session(id)` | `AgentAction::KillCliSession { id }` |
| `agent_cleanup_session(id)` | `AgentAction::CleanupCliSession { id }` |
| `agent_detect_tools()` | `voidlink_core::agent_runner::detect::detect_tools()` direct |
| `agent_get_scrollback(pty_id)` | n/a — `egui_term::TerminalBackend` owns its own scrollback |
| Events `git-agent-event:{id}`, `agent:status-changed`, `agent:needs-attention`, `agent:active`, `pty-output:{id}`, `pty-exit:{id}` | All flow through `EguiEmitter` → `PipelineMsg` → channel → `update()` |

---

*End of plan.*
