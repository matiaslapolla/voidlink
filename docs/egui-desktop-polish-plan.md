# VoidLink egui Desktop — Polish & Parity Plan

**Target.** The `desktop/` crate (eframe + egui 0.31 + `egui_term` + `egui_commonmark`). This doc plans the work to take the pure-Rust desktop app to the polish level of Conductor.build, VS Code, Cursor, and Codex/Claude Code Desktop — modern agentic-IDE polish, not baseline egui chrome.

**Supersedes.** `docs/tauri-frontend-polish-plan.md`. That plan was drafted against `frontend/` (SolidJS + Tailwind) before the migration direction was finalised. `frontend/` and `src-tauri/` are slated for deletion in Phase 9 of the Rust-native migration. This doc is the active polish plan for the surviving UI crate.

**Extends.** `docs/egui-ui-parity-guide.md` (the "parity guide"). The parity guide carries the 57-token `ThemeTokens` shape, the 21-component widget library, motion timings, font embedding, and phased rollout A–F. This doc does **not** duplicate those. It adds the tokens, shaders, motion, components, and data-model extensions required to reach Conductor/Codex feel on top of that baseline.

**Hard constraints** (egui 0.31 era — do not let plan items drift):

- `CornerRadius` (not `Rounding`); `Margin::symmetric(x, y)` takes `i8`.
- No `ctx.interact()`; use `Area`/panel `Response` for drag.
- `egui_code_editor 0.2.24` pulls egui 0.34 — **incompatible**, not used here.
- `egui_commonmark 0.20` is compatible (already in `desktop/Cargo.toml`).
- `Response::cursor_range()` is gone — use `TextEdit::show()` → `TextEditOutput`.
- Fonts: Geist / Geist Mono via `egui::FontDefinitions` + `ctx.set_fonts()` at startup (see parity guide §6).

No implementation code is included here. This is a scaffolding and planning document.

---

## Table of Contents

1. Audit of current state (`desktop/src/ui/*.rs`)
2. New information architecture
3. Component scaffold blueprint (~30 modules)
4. State / data-model extensions
5. Theme / token extensions (beyond parity §1.1)
6. Motion additions
7. Shader & effects pass (new; not in Tauri plan)
8. DX improvements per tool
9. Phased implementation plan (ED-A..ED-G)
10. Risks & open questions
11. Visual parity checklist

---

## Part 1 — Audit of current state

All paths relative to `desktop/src/`. "UC" = upgrade class. Legend:
`MP` = minor polish, `RE` = restructure, `NF` = new feature, `DM` = data-model change.

| Area | Current impl (paths) | Strengths | Gaps vs references (Conductor / Codex / VS Code / Cursor) | UC |
|---|---|---|---|---|
| Title bar | `ui/title_bar.rs` (196 LOC) | Workspace combobox + theme picker + window controls; drag region wired via eframe viewport commands; repo-path truncation | No breadcrumb (Conductor: `⌥ archive-in-repo-details`), no right-side `BranchChip` (`/kampala-v3  Open ▾`), no sub-tab strip (`All changes | Debugging … | Review`). Drag region is the whole bar — can accidentally drag on combobox open. macOS traffic-light reserve absent. | RE |
| Left sidebar | `ui/sidebar.rs` (567 LOC) | Icon-rail + content pattern; `SidebarPage` enum (Explorer/Search/Git/Notes/Repo/Agents); collapse via `LayoutState.left_sidebar_open`; file-tree with expand/rename/context-menu | `Workspace` is flat (`workspace.repo_root: Option<String>` — one repo per workspace). Conductor groups `repo → session` with per-session status chip, delta count, `⌘1..9` keyboard hint. No `Pinned` / `Recents` sections. Footer has no `+ Add repository` / archive / chat / settings trio. | RE + DM |
| Center column | `ui/center.rs` (405 LOC), `state::Tab`/`TabKind` | Strong tab model (`Welcome`, `File`, `Note`, `Search`, `DepGraph`, `DataFlow`, `AgentChat`, `AgentCliTerminal`, `AgentOrchestrator`); singleton vs dynamic tabs; welcome screen | No tab sub-title strip (Conductor header sub-tabs). No breadcrumb slot on tab row with right-aligned actions. No tab drag-reorder (plan §3.3 of parity guide mentions `egui_dnd` but not wired). Close-on-middle-click absent. Editor is a plain `TextEdit::multiline` — no line numbers, no gutter, no diagnostics. | RE + NF |
| Right panel | `ui/right_panel.rs` (50 LOC) | Collapsible via `LayoutState.right_sidebar_open`; resizable | **Monolithic stub** — currently a single body, no stackable cards. Codex reference shows drag-reorderable card deck (Preview / Changes / Terminal / Tasks / Plan / PRReview / Logs). No PR-state chrome (green band `PR #1432 Ready to merge [Merge]`). | RE + NF |
| Bottom pane | `ui/bottom_pane.rs` (247 LOC) | Tabbed Terminal/Git/Logs; `egui_term` PTY integration via `TerminalManager`; resize handle on `TopBottomPanel` | Logs tab is a placeholder (`"Coming soon"`). Terminal is single-session-at-a-time in the visible pane. Redundant with rail cards under the Codex pattern — once Terminal / Logs move to `RailCard`s, this pane's role collapses to `Problems` + workspace-global output. | RE |
| Status bar | `ui/status_bar.rs` (122 LOC) | Renders `repo_path`, scan age, active tab indicator | No VS-Code-style segments (branch, sync ahead/behind, problems count, Ln/Col, encoding, language). No click affordances for panel toggles. Monotone muted text; no color-coded problems count. | NF |
| Git panel | `ui/git_panel.rs` (1236 LOC) | Big surface: sub-tabs `Changes / Branches / Worktrees / Log / PRs`; diff rendering via `components/diff_rows.rs`; worktree manager; new-worktree form; branch list | No Conductor green band for session PR status. No `Changes N | All files | Review` sub-tabs at *row* level. Delta counts present but row chrome is rough — no per-row hover stripe. Mergeability state not wired to any chip. Currently lives only as bottom-pane view and as a sidebar-rail content page; duplicates exist. | RE |
| Repo intelligence | `ui/repo_intel.rs` (1420 LOC) | Scan job state, search tab, dep-graph tab, dataflow tab, pending-open deduplication | Does not surface graph entities as session-linked. Search UI has no keyboard-nav arrow keys. Graph panels use `Painter::circle_filled` raw — would benefit from glow shaders (§7). Inline file previews use `TextEdit` read-only; no syntax highlighting. | RE + NF |
| Notes | `ui/notes.rs` (413 LOC) | Sidebar list + per-note editor via `egui_commonmark`; persisted via `NotesState` | No slash-command menu for insertion (parity §3.20). No pinned notes. No search within notes. | MP |
| Agents | `ui/agents/mod.rs` (48), `chat.rs` (149), `task_form.rs` (252), `components/` | Wired to Phase-7 agent system; one tab per chat/task; streaming `AgentEvent` timeline; task form with objective / constraints / base ref / auto-PR; inline `LiveDiffPanel` on right | Chat bubbles are monolithic — no `ToolCallGroup` collapse, no `ChatTimelineRow` compact rows, no inline `@FileBadge` parsing. No Conductor-style composer footer (model pill, `@ Link issue`, paperclip, brain, auto-accept). No token-budget meter. No "Scroll to bottom" pill. No `Retry from here`. | RE + NF |
| Widgets (`ui/widgets/`) | **Missing.** Parity §3 proposes `widgets/` — not yet implemented. | — | No reusable `Button`/`IconButton`/`Dialog`/`Tabs`/`Toast`/`CommandPalette` library. Every file paints buttons inline via `egui::Button::new(..)` + ad-hoc bg tinting. | NF |
| Theme | `theme/mod.rs` (127), `dark.rs` (34), `light.rs` (33), `nord.rs` (38) | `ThemePalette` + `Theme::apply` + `egui::Visuals` wiring; three themes live | Palette has ~20 fields, not the 57 named by parity §1.1. No `ThemeTokens` name. No `ctx.data` stashing of tokens — widgets must receive tokens explicitly. No Geist fonts (uses default egui fonts). | RE |
| FX / shaders | **Missing.** | — | No glow, no gradient backdrop, no neon pulse, no shader-backed hero surfaces. Painter calls are flat `rect_filled`/`circle_filled` only. | NF |
| Motion / animation | Scattered `animate_bool_with_time` in `bottom_pane.rs`, `sidebar.rs` | Works on known-good surfaces (collapse, hover) | No named transitions; durations hard-coded at call site (0.08, 0.12 etc.). No `motion.rs` helper; no `ease_out_expo` custom easing for the places where the default quadratic looks flat. | MP |

### Dead code / debt flagged during audit

- `ui/notes.rs::note_editor` is exposed but only referenced from `center.rs` — merge with notes sidebar for single ownership of active-note state.
- `ui/git_panel.rs::git_sidebar_content` and `git_panel::git_panel_content` duplicate content across sidebar and bottom-pane — the two should share rendering primitives via a new `widgets/changes_list.rs`.
- `ui/repo_intel.rs` is 1420 LOC in a single file — split per-tab (`search`, `dep_graph`, `data_flow`) into sibling modules. Nothing is dead; everything is just tangled.
- `state::mod.rs` is 846 LOC — `Tab`/`TabKind`, `TerminalManager`, and `RuntimeState` should live in dedicated files (`state/tabs.rs`, `state/terminal.rs`, `state/runtime.rs`). Not blocking for this plan but flag for ED-A cleanup.
- `bottom_pane::BottomTab::Logs` is a placeholder render (shows `"Coming soon"`-equivalent). Either ship with the new `LogsCard` or delete and reuse the tab for `Problems`.
- Parity guide §3 mentions an `egui_dnd` crate for tab reorder; not yet in `desktop/Cargo.toml`. If shipping drag-reorder in ED-C, add or hand-roll with `Sense::drag()`.
- No `ui/widgets/` directory exists. Parity §3 assumes it. ED-A must create it.

---

## Part 2 — New information architecture

Target module tree under `desktop/src/`:

```
desktop/src/
├── main.rs                       (existing — gains install_fonts, feature-flag plumbing)
├── motion.rs                     NEW — §6
├── fx/                           NEW — §7
│   ├── mod.rs
│   ├── glow_stripe.rs
│   ├── gradient_background.rs
│   ├── neon_pulse.rs
│   └── shader_background.rs      (egui_glow CallbackFn / wgpu paint callback)
├── state/
│   ├── mod.rs                    (existing — refactored; see §4)
│   ├── persistence.rs            (existing)
│   ├── agents.rs                 (existing — Phase 7)
│   ├── repo_intel.rs             (existing)
│   ├── workspaces.rs             NEW — Workspace + Repository + Session types
│   ├── sessions.rs               NEW — SessionStatus, PR poller, session registry
│   ├── rail_deck.rs              NEW — RailCardKind + RailCardState
│   ├── toasts.rs                 NEW — toast queue backing ToastHost
│   ├── tabs.rs                   (extracted from mod.rs)
│   ├── terminal.rs               (extracted — TerminalSession + TerminalManager)
│   └── runtime.rs                (extracted — RuntimeState)
├── theme/
│   ├── mod.rs                    (rename ThemePalette -> ThemeTokens; apply via ctx.data)
│   ├── tokens.rs                 NEW — full 57-field + §5 extension
│   ├── dark.rs / light.rs / nord.rs (expanded to full token set)
│   └── github_dark.rs ...        (deferred to parity §9 Phase F — out of scope here)
└── ui/
    ├── mod.rs
    ├── shell.rs                  NEW — AppShell orchestration (title/left/center/right/bottom/status/toasts)
    ├── title_bar/                EXTRACTED dir
    │   ├── mod.rs
    │   ├── breadcrumb.rs         NEW
    │   ├── subtabs.rs            NEW
    │   ├── branch_chip.rs        NEW
    │   └── window_buttons.rs     NEW (Linux/Windows; macOS reserve handled in shell.rs)
    ├── left_rail/                NEW dir (supersedes sidebar.rs)
    │   ├── mod.rs
    │   ├── workspace_group.rs    NEW
    │   ├── repository_row.rs     NEW
    │   ├── session_row.rs        NEW
    │   ├── session_status_chip.rs NEW
    │   ├── pinned_section.rs     NEW
    │   ├── recents_section.rs    NEW
    │   ├── add_repository.rs     NEW
    │   └── footer_icons.rs       NEW
    ├── center/
    │   ├── mod.rs                (existing center.rs split; tab strip + body)
    │   ├── tab_strip.rs          NEW (replaces inline tab render; hooks drag-reorder)
    │   └── welcome.rs            NEW (currently inline in center.rs)
    ├── right_rail/               NEW dir (replaces right_panel.rs)
    │   ├── mod.rs                NEW — RailCardDeck host
    │   ├── rail_card.rs          NEW — generic card shell
    │   ├── deck_toolbar.rs       NEW — "+" add-card popover
    │   └── cards/
    │       ├── preview.rs        NEW
    │       ├── changes.rs        NEW
    │       ├── terminal.rs       NEW
    │       ├── tasks.rs          NEW
    │       ├── plan.rs           NEW
    │       ├── pr_review.rs      NEW
    │       └── logs.rs           NEW
    ├── bottom_pane.rs            (retained; role narrowed — Problems/Output only)
    ├── status_bar/
    │   ├── mod.rs
    │   ├── branch_segment.rs     NEW
    │   ├── sync_segment.rs       NEW
    │   ├── problems_segment.rs   NEW
    │   ├── line_col_segment.rs   NEW
    │   └── mode_segment.rs       NEW
    ├── pr/
    │   ├── pr_header_band.rs     NEW
    │   └── pr_changes_panel.rs   NEW (file list body for ChangesCard)
    ├── agents/                   (existing, redesigned internals)
    │   ├── mod.rs
    │   ├── chat.rs               (existing — split into sub-widgets)
    │   ├── task_form.rs          (existing)
    │   ├── agent_message.rs      NEW — replaces bubble logic
    │   ├── chat_timeline_row.rs  NEW — compact tool-call row
    │   ├── tool_call_group.rs    NEW — collapsible group
    │   ├── scroll_to_bottom_pill.rs NEW
    │   ├── auto_accept_toggle.rs NEW
    │   ├── token_budget_meter.rs NEW
    │   ├── model_selector.rs     NEW
    │   └── command_footer.rs     NEW
    ├── widgets/                  NEW (parity §3 home)
    │   ├── mod.rs
    │   ├── button.rs, icon_button.rs, input.rs, badge.rs, kbd.rs, switch.rs,
    │   ├── tabs.rs, modal.rs, tooltip.rs, context_menu.rs,
    │   ├── command_palette.rs    NEW — ⌘K global palette
    │   ├── toast_host.rs         NEW — overlay anchor for toasts
    │   ├── delta_count.rs        NEW
    │   ├── file_badge.rs         NEW
    │   ├── keyboard_hint_chip.rs NEW
    │   ├── status_dot.rs         NEW — pulse via §7 neon_pulse
    │   ├── tab_subtitle.rs       NEW
    │   ├── branch_chip.rs        NEW
    │   ├── scroll.rs, card.rs, list_row.rs, divider.rs, spinner.rs
    │   └── gallery.rs            DEBUG-ONLY preview page (feature = "widget-gallery")
    └── components/               (existing — keep diff_rows.rs, add more primitives)
        ├── diff_rows.rs          (existing)
        └── code_diff_block.rs    NEW — hunks + "N unmodified lines" fold
```

### Two structural shifts

**Shift A — Workspace → Repository → Session grouped left rail (Conductor pattern).**
`Workspace` stops owning a single `repo_root`. Instead, a `Workspace` owns N `Repository` references; each `Repository` owns N `Session`s (branch × task × chat × diff × PR). A Session is the primary unit of work: multiple concurrent agent tasks on different branches map to multiple sessions. Data-model migration in §4.

**Shift B — Right rail as a stackable `RailCardDeck` (Codex pattern).**
`right_panel.rs` today is a single body. It becomes a host for an ordered, dismissible, drag-reorderable deck of `RailCard`s (Preview / Changes / Terminal / Tasks / Plan / PRReview / Logs). Per-session persistence of order + collapsed state via `RailCardState` (§4). The `+` popover at the top lets the user re-add dismissed cards.

Both shifts are gated behind a `RuntimeState.new_shell: bool` feature flag (§9). Default on in dev, off at first tagged release until stability is proven.

---

## Part 3 — Component scaffold blueprint

Naming convention for egui idioms: either a **free function** `pub fn show(ui: &mut egui::Ui, state: &mut XState) -> egui::Response` (preferred for stateless panels), or a **struct + `ui` method** `pub struct FooView { ... } impl FooView { pub fn ui(&mut self, ui: &mut egui::Ui) -> egui::Response }` when the widget owns animation state, drag id, scroll offset, etc. Tokens read via `ui.ctx().data(|d| d.get_temp::<ThemeTokens>(egui::Id::NULL))`.

### 3.1 Layout shell

#### `ui/shell.rs::AppShell` — NEW
- **Purpose.** Top-level orchestrator. Owns the decision to paint the title bar, left rail, center body, right deck, bottom pane, status bar, toast host, and shader backdrop in the correct Z order.
- **API.**
  `pub fn show(ctx: &egui::Context, state: &mut AppState, runtime: &mut RuntimeState)`
- **Tokens.** `background`, `sidebar_bg`, `border`, `glass_*`, `shell_gradient_*`.
- **Pattern.** VS Code shell + Conductor proportions (left ≈ 264 px, right ≈ 360 px).
- **Z-order.** Background shader (`Order::Background`) → central panel content → rail cards → floating `Area`s (toasts, scroll-to-bottom pill, command palette scrim).

#### `ui/right_rail/mod.rs::RailCardDeck` — NEW
- **Purpose.** Hosts `RailCard`s for the active session. Handles ordering, add/remove, drag-reorder, persistence (`RailCardState[]` per session).
- **API.** `pub struct RailCardDeck { dragging: Option<RailCardKind>, drop_target: Option<usize>, ... } impl RailCardDeck { pub fn ui(&mut self, ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState, session_id: &str) }`.
- **Drag.** `Sense::drag()` on the `RailCard` title strip; track `drag_started_at_pointer_pos` + hovered card index; on `response.drag_released`, commit reorder via `SessionsStore::reorder_deck(session_id, ids)`.
- **Tokens.** `rail_card_bg` (§5), `rail_card_border` (§5), `border`, `surface`.

#### `ui/right_rail/rail_card.rs::RailCard` — NEW
- **Purpose.** Generic card shell: title + leading icon + trailing actions + drag handle + dismiss button + body.
- **API.** `pub struct RailCard<'a> { kind: RailCardKind, title: &'a str, collapsible: bool, trailing: Option<&'a dyn Fn(&mut egui::Ui)>, body: Box<dyn FnOnce(&mut egui::Ui) + 'a> } impl<'a> RailCard<'a> { pub fn show(self, ui: &mut egui::Ui) -> RailCardResponse }` where `RailCardResponse { dismissed: bool, dragged: bool, drag_delta: egui::Vec2 }`.
- **Tokens.** `rail_card_bg`, `rail_card_border`, `text_muted`, `hover`.

### 3.2 Workspace / left rail

#### `ui/left_rail/workspace_group.rs::WorkspaceGroup` — NEW
- **Purpose.** Collapsible repo group in the left rail. Renders repository name + N `SessionRow`s.
- **API.** `pub fn show(ui: &mut egui::Ui, workspace: &Workspace, repo: &Repository, sessions: &[Session], active_session_id: Option<&str>, expanded: &mut bool, on_select: &mut dyn FnMut(&str))`.
- **Tokens.** `sidebar_bg`, `hover`, `text`, `text_muted`.

#### `ui/left_rail/session_row.rs::SessionRow` — NEW
- **Purpose.** Two-line session row.
  - Line 1: `⌥ <session-name>   <DeltaCount +X -Y>`
  - Line 2: `<parent-branch> · <SessionStatusChip>   <KeyboardHintChip>`
- **API.** `pub fn show(ui: &mut egui::Ui, session: &Session, active: bool, shortcut: Option<u8>) -> egui::Response`.
- **Active visual.** 2 px left stripe in `primary` (painted via `ui.painter().rect_filled` before content), `primary_subtle` bg lerped in over 60 ms (`ctx.animate_bool_with_time`). For the running state, stripe animates via `fx::glow_stripe` (§7).
- **Tokens.** `hover`, `primary`, `text`, `text_muted`, `delta_add_fg` (§5), `delta_del_fg` (§5), plus `SessionStatusChip` tints.

#### `ui/left_rail/session_status_chip.rs::SessionStatusChip` — NEW
- **Purpose.** Color-tinted phrase for the session state.
- **API.** `pub fn show(ui: &mut egui::Ui, status: SessionStatus, compact: bool) -> egui::Response`.
- **Tokens.** `pr_ready_bg` (§5, subtle tint), `pr_conflict_bg` (§5), `pr_draft_bg` (§5), `warning`, `success`, `danger`, `text_muted`.

#### `ui/left_rail/pinned_section.rs`, `recents_section.rs` — NEW
- Codex-style "Pinned" + "Recents" sub-headers above/below the workspace group list. Right-click a `SessionRow` → `Pin`; LRU for Recents.

#### `ui/left_rail/add_repository.rs::AddRepositoryButton` — NEW
- **Purpose.** Footer button that opens the native directory picker via `rfd` or `egui-file-dialog` (pick one during ED-E).
- **API.** `pub fn show(ui: &mut egui::Ui, workspace_id: &str, on_add: &mut dyn FnMut(PathBuf))`.

#### `ui/left_rail/footer_icons.rs` — NEW
- Icon trio: archive / chat / settings. Each an `IconButton` (Ghost variant).

### 3.3 UI primitives (under `ui/widgets/`)

| Module | Purpose | API | Tokens | Pattern |
|---|---|---|---|---|
| `delta_count.rs` | Monospace `+X -Y` pair | `pub fn show(ui: &mut egui::Ui, add: u32, del: u32, hide_zeros: bool, size: DeltaSize)` | `delta_add_fg`, `delta_del_fg` (§5) | Conductor `+312 -332` |
| `file_badge.rs` | `@Filename.tsx` inline chip | `pub fn show(ui: &mut egui::Ui, path: &str) -> egui::Response` (clickable) | `file_badge_bg` (§5), `text`, `border` | Conductor `@RepositoryDetailsDialog.tsx` |
| `keyboard_hint_chip.rs` | Small pill `⌘L to focus` | `pub fn show(ui: &mut egui::Ui, keys: &[&str], label: Option<&str>)` | `keyboard_hint_bg` (§5), `text_muted` | Conductor `⌘L to focus` |
| `status_dot.rs` | 6 px dot w/ optional pulse | `pub fn show(ui: &mut egui::Ui, status: DotStatus, pulse: bool)` — pulse via `fx::neon_pulse` | `status_dot_*` (§5) | Codex Recents status dot |
| `tab_subtitle.rs` | Sub-tab strip with underline-under-active | `pub fn show(ui: &mut egui::Ui, items: &[TabSubtitleItem], active: &str, on_select: &mut dyn FnMut(&str))` | `primary`, `border`, `text`, `text_muted` | Conductor header sub-tabs |
| `branch_chip.rs` | `/branch-name  Open ▾` w/ dropdown | `pub struct BranchChip { branch: String, items: Vec<MenuItem> } impl BranchChip { pub fn ui(&mut self, ui: &mut egui::Ui) -> egui::Response }` | `border`, `text`, `primary` | Conductor `/kampala-v3 Open ▾` |
| `tool_call_group.rs` | `> N tool calls, M messages` collapsible | `pub struct ToolCallGroup<'a> { title: &'a str, count: usize, default_open: bool, body: Box<dyn FnOnce(&mut egui::Ui) + 'a> }` | `border`, `tool_call_row_bg` (§5), `text_muted` | Conductor `> 13 tool calls, 7 messages` |
| `command_palette.rs` | ⌘K global palette | `pub struct CommandPalette { open: bool, query: String, selected: usize, commands: Vec<Command> } impl CommandPalette { pub fn show(&mut self, ctx: &egui::Context) -> Option<CommandOutcome> }` | `surface_elevated`, `primary`, `border`, `primary_subtle` | VS Code `Ctrl+P` / Conductor ⌘K |
| `toast_host.rs` | Bottom-right anchored `Area` w/ queue | `pub fn show(ctx: &egui::Context, toasts: &mut ToastQueue)` | `surface_elevated`, `border`, `success/warning/danger` subtles | §3 below — full spec |
| `modal.rs` | Scrim + focus-trap dialog (as in parity §3.4) | same signature as parity guide | `surface_elevated`, `border`, scrim `Color32::from_black_alpha(140)` | Kobalte Dialog equivalent |

### 3.3.1 `ToastHost` — full spec (not in parity guide)

egui has no native toast primitive. The plan:

- Toast queue is a `VecDeque<Toast>` in `state/toasts.rs`. Each `Toast { id: Uuid, kind: ToastKind, title: String, body: Option<String>, created_at: Instant, ttl: Duration, sticky: bool, action: Option<ToastAction> }`.
- `ToastKind::{Info, Success, Warning, Error}` drives border-left stripe color + icon glyph.
- Render via anchored `egui::Area::new("toast-host").anchor(egui::Align2::RIGHT_BOTTOM, egui::vec2(-16.0, -16.0)).order(egui::Order::Foreground)`.
- Enter animation: 180 ms x-offset slide from `+24 px` to `0 px` + opacity `0 → 1`. Use `ctx.animate_value_with_time(toast_id_hash.with("enter"), 1.0, 0.18)`.
- Exit animation: 140 ms x-offset slide to `+12 px` + opacity `1 → 0`.
- Auto-dismiss: on each frame while any toast is visible, call `ctx.request_repaint_after(Duration::from_millis(100))`. When `created_at.elapsed() > ttl && !sticky`, begin exit animation.
- Dismiss by click on an `×` button (ghost `IconButton`). `ToastAction` renders as a linked trailing `Button` (e.g. "Undo").
- Stack order: newest on top; max 5 visible; surplus queued behind.

Public API:

```rust
pub fn toast_info(runtime: &mut RuntimeState, title: impl Into<String>);
pub fn toast_success(runtime: &mut RuntimeState, title: impl Into<String>, action: Option<ToastAction>);
pub fn toast_warn(runtime: &mut RuntimeState, title: impl Into<String>, body: impl Into<String>);
pub fn toast_error(runtime: &mut RuntimeState, title: impl Into<String>, body: impl Into<String>);
```

### 3.4 Agent chat

#### `ui/agents/chat_timeline_row.rs::ChatTimelineRow` — NEW
- **Purpose.** Compact one-line row emitted when the agent produces a tool call (Write / Edit / Lint / Typecheck / Build / ReadFile / Search / Run / Todo). Replaces the big bubble for tool events.
- **API.** `pub fn show(ui: &mut egui::Ui, row: &ChatTimelineRowData, expanded: &mut bool, on_body: &mut dyn FnMut(&mut egui::Ui)) -> egui::Response`.
- **Tokens.** `tool_call_row_bg` (§5), `hover`, `text`, `text_muted`, `delta_add_fg`, `delta_del_fg`, `status_dot_*`.

#### `ui/agents/tool_call_group.rs::ToolCallGroup` — NEW
- **Purpose.** Collapses consecutive tool calls into a single foldable row (`> 13 tool calls, 7 messages`).

#### `ui/agents/agent_message.rs::AgentMessage` — REDESIGN
- **Purpose.** Replace current bubble-layout logic in `ui/agents/chat.rs`. Supports user bubble (dense `surface_elevated`), assistant prose (bubble-less), file-badge parsing for `@path` tokens using a regex over the text during `LayoutJob` build, error/warn/success tinted subtitle pills.
- **API.** `pub fn show(ui: &mut egui::Ui, msg: &ChatMessage, ctx: &AgentMessageCtx)` where `AgentMessageCtx { on_open_file: Box<dyn FnMut(&Path)>, on_retry_from_here: Box<dyn FnMut(&str)> }`.
- **Implementation detail.** Parse `@filename` spans and render them as `FileBadge` galleys interleaved with plain-text `TextEdit`/`Label` pieces via `egui::text::LayoutJob::append_section`. Keep a wrapping width from `ui.available_width()`.

#### `ui/agents/scroll_to_bottom_pill.rs::ScrollToBottomPill` — NEW
- **Purpose.** Floating pill shown just above the composer when the message list is not pinned to bottom.
- **API.** `pub fn show(ui: &mut egui::Ui, visible: bool, unread: usize) -> egui::Response`.
- **Motion.** 160 ms fade + translate-y `+8 px → 0 px`.

#### `ui/agents/auto_accept_toggle.rs`, `token_budget_meter.rs`, `model_selector.rs`, `command_footer.rs` — NEW
- **AutoAcceptToggle.** Pill switch in the composer footer; per-session persist.
- **TokenBudgetMeter.** `↓ 37.1k / 200k tokens`; colour tints at 80 % (warning) and 95 % (danger).
- **ModelSelector.** Pill `✦ Sonnet 4.5`; dropdown of `ModelOption`s; spinner overlay while `thinking`.
- **CommandFooter.** `Type / for commands` input wrapper with leading `/` glyph + trailing mic/send.

### 3.5 PR chrome

#### `ui/pr/pr_header_band.rs::PRHeaderBand` — NEW
- **Purpose.** Coloured solid band at the top of the right rail when the active session has a PR.
- **Body.** `PR #<n> ↗ <status-phrase> [Merge]`, status ∈ `Ready to merge | Merge conflicts | Draft | Checks failing | Checks running`.
- **Visual.** Painted via `Painter::rect_filled` with `CornerRadius::same(8)` top corners. Glow underlay via `fx::glow_stripe` pulsing at 1.4 s (§7) when `status == ready_to_merge`.
- **API.** `pub fn show(ui: &mut egui::Ui, pr: &PullRequestInfo, on_merge: &mut dyn FnMut(), on_open: &mut dyn FnMut())`.
- **Tokens.** `pr_ready_bg`/`fg`, `pr_conflict_bg`/`fg`, `pr_draft_bg`/`fg`, `pr_failing_bg`/`fg` (§5), `primary_fg`.

#### `ui/pr/pr_changes_panel.rs::PRChangesPanel` — NEW
- **Purpose.** File list inside `ChangesCard` with truncated paths, `DeltaCount`, open icon, sub-tabs `Changes N | All files | Review`.
- **API.** `pub fn show(ui: &mut egui::Ui, files: &[FileDelta], tab: &mut PRChangesTab, on_open: &mut dyn FnMut(&Path))`.

### 3.6 Rail cards (under `ui/right_rail/cards/`)

| Module | Purpose | Tokens | Pattern |
|---|---|---|---|
| `preview.rs` | Embedded preview frame (future: `egui_webview` or static snapshot) + fake URL bar | `rail_card_bg`, `border`, `text_muted` | Codex Preview card |
| `changes.rs` | Wraps `PRChangesPanel` | (inherits) | Conductor + Codex Changes |
| `terminal.rs` | Hosts an `egui_term::TerminalView` inside a `RailCard` | `rail_card_bg`, `editor_bg`, `border` | Codex Terminal card |
| `tasks.rs` | Two-group task list (`Running` / `Completed`) w/ runtime per row | `rail_card_bg`, `status_dot_*`, `text_muted` | Codex Tasks |
| `plan.rs` | Checklist of plan items (☐ / ☑) | `rail_card_bg`, `success`, `text_muted` | Codex Plan |
| `pr_review.rs` | Mini PR review surface (reuses Phase-6 review APIs) | — | Conductor Review |
| `logs.rs` | Wraps `InlineLogCard` — filter tabs, coloured prefixes (`[tsc]`, `[vite]`, `[cargo]`) | `log_prefix_*` (§5) | Codex logs |

Each card has a free function `pub fn show(ui: &mut egui::Ui, state: &mut AppState, runtime: &mut RuntimeState, session: &Session)` and returns an optional `CardEvent` (e.g. request-dismiss).

### 3.7 Editor / diff / terminal

#### `ui/components/code_diff_block.rs::CodeDiffBlock` — NEW
- **Purpose.** Canonical unified diff widget: line numbers, row-bg tinting, fold for `<N unmodified lines>`.
- **API.** `pub fn show(ui: &mut egui::Ui, hunks: &[DiffHunk], cfg: DiffBlockConfig) -> egui::Response` where `DiffBlockConfig { collapse_unmodified_over: usize, word_wrap: bool, line_number_mode: LineNumberMode }`.
- **Reuses.** `ui/components/diff_rows.rs` row painting primitives.
- **Tokens.** `success_subtle` (added), `danger_subtle` (removed), `editor_bg`, `editor_line_number`, `editor_line_number_active`, `border`.

#### `ui/right_rail/cards/logs.rs::InlineLogCard` — NEW
- **Purpose.** Tabbed log viewer: `all | stdout | stderr`, search input, coloured prefix recognition (`[tsc]`, `[vite]`, `[cargo]`).
- **API.** `pub struct InlineLogCard { filter: LogFilter, search: String } impl InlineLogCard { pub fn ui(&mut self, ui: &mut egui::Ui, lines: &[LogLine]) }`.

### 3.8 Title bar

`ui/title_bar/mod.rs` — REFACTOR of existing flat module.
- **New slots.** `breadcrumb: Option<BreadcrumbData>`, `subtabs: Option<TabSubtitleData>`, `right_branch_chip: Option<BranchChipData>`.
- **Drag region.** Restrict `StartDrag` to the gaps between interactive widgets (walk the `ui.horizontal_top` layout and allocate explicit drag rects around the interactive rects). Avoids the current "click-ComboBox-triggers-drag" issue.
- **Tokens.** `title_bar_bg`, `glass_*`, `text`, `text_muted`.

---

## Part 4 — State / data-model extensions

New and extended types. Everything serialisable goes under `state/`, with one module per concern.

### 4.1 `state/workspaces.rs` — Workspace / Repository split

```rust
#[derive(Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub repository_ids: Vec<String>,    // was: repo_root: Option<String>
    pub pinned_session_ids: Vec<String>,
    pub recent_session_ids: Vec<String>, // LRU, capped to 16
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Repository {
    pub id: String,
    pub workspace_id: String,
    pub path: PathBuf,
    pub display_name: String,
    pub default_branch: String,
    pub remotes: Vec<Remote>,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Remote { pub name: String, pub url: String }
```

### 4.2 `state/sessions.rs` — Session + PR

```rust
#[derive(Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Running,
    ReadyToMerge,
    MergeConflicts,
    Archived,
    Failed,
    DraftPr,
    PrOpen,
    PrClosed,
    PrMerged,
    ChecksFailing,
    ChecksRunning,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub repository_id: String,
    pub name: String,            // "archive-in-repo-details"
    pub branch: String,          // worktree HEAD
    pub parent_branch: String,   // "kampala-v3"
    pub status: SessionStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub worktree_path: Option<PathBuf>,
    pub chat_id: Option<String>,         // into agents runtime
    pub task_id: Option<String>,         // voidlink-core::git_agent task id
    pub pr: Option<PullRequestInfo>,
    pub last_delta: DeltaCount,
    pub runtime_ms: Option<u64>,
    pub tokens_used: Option<TokenUsage>,
    pub shortcut_index: Option<u8>,      // 1..=9
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PullRequestInfo {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: PrState,              // Open/Closed/Merged
    pub draft: bool,
    pub head: String,
    pub base: String,
    pub labels: Vec<String>,
    pub checks: ChecksSummary,
    pub mergeable: Mergeable,        // Clean/Conflicts/Unknown/Blocked
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CheckRun {
    pub id: String,
    pub name: String,
    pub conclusion: CheckConclusion,  // Success/Failure/Neutral/Pending
    pub url: Option<String>,
}

#[derive(Clone, Default, Copy, Serialize, Deserialize)]
pub struct DeltaCount { pub add: u32, pub del: u32 }

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct TokenUsage { pub input: u64, pub output: u64, pub context_window: u64 }
```

### 4.3 `state/rail_deck.rs` — Rail-card model

```rust
#[derive(Copy, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum RailCardKind { Preview, Changes, Terminal, Tasks, Plan, PrReview, Logs }

#[derive(Clone, Serialize, Deserialize)]
pub struct RailCardState {
    pub kind: RailCardKind,
    pub collapsed: bool,
    pub meta: RailCardMeta,        // typed per-kind
}

#[derive(Clone, Serialize, Deserialize)]
pub enum RailCardMeta {
    None,
    Preview { url: String },
    Terminal { pty_id: u64 },
    Logs { source: LogSource },
}
```

### 4.4 `state/toasts.rs` — Toast queue

```rust
#[derive(Copy, Clone)]
pub enum ToastKind { Info, Success, Warning, Error }

pub struct Toast {
    pub id: uuid::Uuid,
    pub kind: ToastKind,
    pub title: String,
    pub body: Option<String>,
    pub created_at: Instant,
    pub ttl: Duration,
    pub sticky: bool,
    pub action: Option<ToastAction>,
}

pub struct ToastQueue { pub items: VecDeque<Toast> }
```

### 4.5 Tool calls (agent timeline)

Lives under `state/agents.rs` as an extension of the current `AgentEvent` stream:

```rust
#[derive(Clone)]
pub struct ToolCall {
    pub id: String,
    pub kind: ToolCallKind,
    pub path: Option<PathBuf>,
    pub delta: Option<DeltaCount>,
    pub status: ToolCallStatus,     // Running/Success/Error/Skipped
    pub started_at_ms: i64,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub message_id: Option<String>,
}

#[derive(Copy, Clone)]
pub enum ToolCallKind { Write, Edit, Delete, Lint, Typecheck, Build, Test, Run, ReadFile, Search, Todo, Other }
```

Per the Phase 7 doc, today the pipeline emits free-text `AgentEvent`. The Phase 8 extension is a structured tool-call stream — this struct is the egui-side home for it. Until Phase 8 lands, `ToolCall` is populated by a best-effort parser over `AgentEvent.text` (regexes on `Write src/...`, `Edit src/...`, etc.); the `ChatTimelineRow` falls back to rendering free-text when the parser has no match.

### 4.6 Migration plan for existing `AppState`

| Existing shape | Change | Migration |
|---|---|---|
| `Workspace.repo_root: Option<String>` (`state/mod.rs:182`) | Drop; move to `Repository.path` | On `AppState::load`, for every legacy workspace with `repo_root = Some(p)`: insert a `Repository { path: p, workspace_id: ws.id, display_name: p.file_name() }` and a default `Session { repository_id, branch: detect_default_branch(p), name: "main" }`. Cap at one repo per workspace during migration — multi-repo creation is user-driven post-migration. |
| `AppState.sidebar_page: SidebarPage` | Keep; extend with `SidebarPage::Pinned` (no new persisted variant — computed view inside `SidebarPage::Explorer`/rail). | None |
| `AppState.active_workspace_id` | Unchanged | None |
| `LayoutState.right_sidebar_width/open` | Unchanged | None — `RailCardDeck` lives inside the right side panel |
| `LayoutState` — NEW fields | `right_deck_by_session: HashMap<String, Vec<RailCardState>>` | Seed default deck `[Changes, Terminal, Plan]` for any session without entry. |
| `RuntimeState` | Add `toasts: ToastQueue`, `sessions_registry: SessionsRegistry`, `new_shell: bool` (feature-flag runtime-writable from Settings) | None — rebuilt each run. |
| Existing serde discriminants for `SidebarPage`, `BottomTab`, `GitSubTab` | Preserved (`#[serde(alias = "Agent")]` precedent) | Keep `#[serde(default)]` on all new fields. |

New persistence key: bump config-file version from `v1` to `v2` in `state/persistence.rs`. On first load of v1, run `migrate_v1_to_v2` once and overwrite; keep a `state.v1.bak` side-file for one release as a safety net.

---

## Part 5 — Theme / token extensions (beyond parity §1.1)

These are **new** tokens not covered by the parity guide §1.1. They extend `ThemeTokens` in `theme/tokens.rs`. All three ship-now themes must supply values.

| Token | Purpose | Dark | Light | Nord |
|---|---|---|---|---|
| `pr_ready_bg` | Green band fill when PR ready | `#1f6f43` | `#c7f0d8` | `#4c7f5b` |
| `pr_ready_fg` | Text on `pr_ready_bg` | `#e7fcef` | `#14532d` | `#eceff4` |
| `pr_ready_glow` | Glow tint for ready pulse | `rgba(74,222,128,0.22)` | `rgba(22,163,74,0.14)` | `rgba(163,190,140,0.22)` |
| `pr_conflict_bg` | Amber band fill | `#7a5a14` | `#fff1c2` | `#8a6d2c` |
| `pr_conflict_fg` | Text on conflict band | `#fef9c3` | `#5a3a02` | `#eceff4` |
| `pr_draft_bg` | Muted band fill for draft | `#2e2e42` | `#eeeef2` | `#434c5e` |
| `pr_draft_fg` | Text on draft band | `#afafc3` | `#4a4a5a` | `#d8dee9` |
| `pr_failing_bg` | Red band fill for failing checks | `#6a1e22` | `#ffd4d4` | `#7d4249` |
| `pr_failing_fg` | Text on failing band | `#fecaca` | `#7f1d1d` | `#eceff4` |
| `delta_add_fg` | Monospace `+X` green | `#4ade80` | `#15803d` | `#a3be8c` |
| `delta_del_fg` | Monospace `-Y` red | `#f87171` | `#b91c1c` | `#bf616a` |
| `rail_card_bg` | Card body surface | `#1a1a2b` | `#f7f7fa` | `#3b4252` |
| `rail_card_border` | Card border | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` | `#434c5e` |
| `file_badge_bg` | Inline `@File.tsx` fill | `#232338` | `#eef0f6` | `#434c5e` |
| `file_badge_fg` | Inline chip text | `#d5d5e5` | `#2a3040` | `#e5e9f0` |
| `keyboard_hint_bg` | Chip fill `⌘L to focus` | `#2d2d46` | `#ececf2` | `#4c566a` |
| `keyboard_hint_fg` | Chip text | `#afafc3` | `#4a4a5a` | `#d8dee9` |
| `tool_call_row_bg` | `ChatTimelineRow` hover/active | `#1e1e32` | `#f3f3f8` | `#3b4252` |
| `tool_call_row_stripe` | Left accent stripe for running tool call | `#6366f1` | `#4f46e5` | `#88c0d0` |
| `status_dot_running` | Blue pulse | `#60a5fa` | `#2563eb` | `#81a1c1` |
| `status_dot_idle` | Grey | `#6a6a87` | `#9ca0aa` | `#4c566a` |
| `status_dot_success` | Green | `#22c55e` | `#15803d` | `#a3be8c` |
| `status_dot_error` | Red | `#ef4444` | `#b91c1c` | `#bf616a` |
| `status_dot_warning` | Amber | `#f59e0b` | `#b45309` | `#d08770` |
| `log_prefix_tsc` | `[tsc]` prefix color | `#38bdf8` | `#0369a1` | `#88c0d0` |
| `log_prefix_vite` | `[vite]` prefix | `#a78bfa` | `#6d28d9` | `#b48ead` |
| `log_prefix_cargo` | `[cargo]` prefix | `#f59e0b` | `#b45309` | `#d08770` |
| `log_prefix_generic` | Any `[name]` fallback | `#9ca0aa` | `#4a5160` | `#81a1c1` |
| `toast_info_stripe` | Info stripe | `#60a5fa` | `#2563eb` | `#81a1c1` |
| `toast_success_stripe` | Success stripe | `#22c55e` | `#15803d` | `#a3be8c` |
| `toast_warning_stripe` | Warning stripe | `#f59e0b` | `#b45309` | `#ebcb8b` |
| `toast_error_stripe` | Error stripe | `#ef4444` | `#b91c1c` | `#bf616a` |
| `session_active_glow` | Left-stripe glow for active running session | `rgba(99,102,241,0.35)` | `rgba(79,70,229,0.25)` | `rgba(136,192,208,0.35)` |
| `command_palette_scrim` | Scrim below palette | `rgba(0,0,0,0.55)` | `rgba(20,20,35,0.28)` | `rgba(46,52,64,0.55)` |
| `hero_gradient_a` | Hero shader stop A | `#1a1345` | `#e8eaff` | `#2e3d56` |
| `hero_gradient_b` | Hero shader stop B | `#0a0a18` | `#f7f7fa` | `#2e3440` |
| `hero_gradient_c` | Hero shader stop C | `#0f2030` | `#edf0ff` | `#35414e` |

**Count.** 34 new tokens beyond parity §1.1. That puts `ThemeTokens` at 91 fields.

**Naming convention.** snake_case Rust field names; equivalents in any future CSS export use kebab-case. No one-off hex in widget code; unknown colours go through ED-A review.

**Light-mode rule.** The "green band" is vivid in dark mode but subtle in light. QA: contrast ratio ≥ 4.5:1 for `pr_ready_fg` on `pr_ready_bg`. Programmatic check: add a `theme::assert_contrast()` test that loops every `_fg`/`_bg` pair and asserts WCAG AA.

**Token sourcing.** Where the `frontend/src/index.css` parity source has no direct analog (e.g. `hero_gradient_*`), values are derived OKLch-down-saturate from `primary` + `background`. Document the derivation inline in `theme/tokens.rs` via a `// derived: ` comment so later theme fills stay consistent.

---

## Part 6 — Motion additions

All motion rides the parity guide's §2 timings; this section names the **new** transitions.

| Motion | Duration | Easing | Applied to |
|---|---|---|---|
| `row_hover_fill` | 80 ms | `ease_out_expo` | `SessionRow`, `ChatTimelineRow`, rail-card file list rows, `ListRow` |
| `tab_switch_fade` | 120 ms | `ease_out_expo` | `TabSubtitle`, center tab strip active-tab transitions |
| `rail_card_drag_settle` | 180 ms | rubber-band `cubic_bezier(0.34, 1.56, 0.64, 1.0)` | `RailCard` drop settle |
| `status_dot_pulse` | 1400 ms loop | triangle-wave sin mapped to scale 1.0 → 1.25 | `StatusDot` + session active stripe (shader-backed in §7) |
| `pr_band_color_transition` | 220 ms | `ease_out_expo` | `PRHeaderBand` bg when session status flips |
| `scroll_to_bottom_pill_in` | 160 ms | `ease_out_expo` | `ScrollToBottomPill` fade + translate-y |
| `session_stripe_slide` | 120 ms | `ease_out_expo` | Active 2 px left stripe on `SessionRow` |
| `toast_enter` | 180 ms | `ease_out_expo` | `ToastHost` entry (x-offset + opacity) |
| `toast_exit` | 140 ms | linear | `ToastHost` exit |
| `command_palette_scrim_fade` | 120 ms | linear | Scrim alpha for ⌘K |
| `command_palette_scale_in` | 140 ms | `ease_out_expo` | Palette panel `scale(0.96 → 1.0)` + opacity `0 → 1` |
| `hero_gradient_drift` | 9000 ms loop | sin | Shader uniform time driver (§7) |

### 6.1 `motion.rs` helper module

```rust
// desktop/src/motion.rs
pub mod dur {
    pub const HOVER: f32 = 0.06;
    pub const PRESS: f32 = 0.08;
    pub const ROW_HOVER_FILL: f32 = 0.08;
    pub const FOCUS_RING: f32 = 0.12;
    pub const TAB_SWITCH: f32 = 0.12;
    pub const PR_BAND: f32 = 0.22;
    pub const DIALOG_IN: f32 = 0.10;
    pub const SCROLL_PILL: f32 = 0.16;
    pub const CARD_SETTLE: f32 = 0.18;
    pub const TOAST_IN: f32 = 0.18;
    pub const TOAST_OUT: f32 = 0.14;
    pub const PALETTE_IN: f32 = 0.14;
}

pub fn ease_out_expo(t: f32) -> f32; // 1.0 - 2.0_f32.powf(-10.0 * t)
pub fn ease_out_rubber(t: f32) -> f32;
pub fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32;
pub fn animate_color(ctx: &egui::Context, id: egui::Id, target: Color32, duration: f32) -> Color32; // wraps animate_value_with_time per channel
```

All widget call-sites route through `motion::dur::*` constants and never pass raw floats.

---

## Part 7 — Shader & effects pass (NEW — not in Tauri plan)

Because egui is immediate-mode and CPU-painted, "polish" beyond the basic `Painter::rect_filled` has to come from deliberate effects. This section scopes five shader-class effects in a dedicated `desktop/src/fx/` module.

### 7.1 Renderer baseline

eframe picks its renderer in `NativeOptions.renderer`. Choose **`Renderer::Wgpu`** (already required for real blur in `epaint::Shadow`). Custom shaders hook in two ways:

- **`egui_glow::CallbackFn`** — legacy GL backend escape hatch. Cheap and portable. Useful for simple full-screen gradients.
- **`egui_wgpu::CallbackTrait`** (preferred on wgpu renderer) — each paint callback gets the `wgpu::RenderPass`. This is the path for anything non-trivial (multi-pass, textures, compute).

**Decision for ED-A.** Ship under wgpu renderer; feature-gate `egui_glow` fallback via a `voidlink-desktop/glow-fallback` Cargo feature. The `fx::shader_background` module wires a wgpu callback; `fx::gradient_background` (§7.3) stays on pure CPU painting so it always works.

Wire-up sketch (no code, just the shape):

```
AppShell
  └── paint_background_layer      // Order::Background, bottom of Z stack
        ├── fx::shader_background::paint(...)          // wgpu callback if available
        └── fx::gradient_background::paint(...)        // CPU fallback / low-spec path
```

### 7.2 FX items (one per sub-module)

#### `fx/gradient_background.rs` — animated 3-stop shell gradient
- **Goal.** Replace the current flat `background` fill with a slowly drifting 3-stop gradient (`hero_gradient_a/b/c` — §5).
- **Impl path.** Pure CPU. Paint N horizontal strips (~24) across the screen, each filled with a colour interpolated via `lerp_color` using a `sin(t)` offset driven by `ctx.input(|i| i.time)`. `ctx.request_repaint_after(Duration::from_millis(33))` while this is active.
- **Perf.** ~0.3 ms CPU at 1440p (24 rect_filled calls per frame). Well under budget.
- **When active.** Always on in `AppShell::paint_background_layer` unless `AppState.fx_preference == FxPreference::Solid`.

#### `fx/glow_stripe.rs` — pulsing alpha glow underlay
- **Goal.** Underlay a soft glow behind the `PRHeaderBand` when `status == ready_to_merge`, and behind a session row's active left stripe when the session is running.
- **Impl path.** Pure CPU. Multi-layer painter trick:
  ```
  for i in 1..=6 {
      let expand = i as f32 * 0.8;
      let alpha = ((1.0 - i as f32 / 7.0) * pulse_intensity * base_alpha) as u8;
      painter.rect_filled(rect.expand(expand), radius, tint.with_alpha(alpha));
  }
  ```
  `pulse_intensity` is a 0..=1 value driven by `(sin(time * tau / 1.4) * 0.5 + 0.5)`. `tint` is `pr_ready_glow` / `session_active_glow` depending on surface.
- **Perf.** ~6 `rect_filled` per glow source. If there are many (e.g. 9 running sessions in the sidebar), guard with visibility check: only paint when `ui.clip_rect().intersects(rect)`.
- **Budget.** < 1 ms CPU for a typical session with 0–3 glow sources on screen.

#### `fx/neon_pulse.rs` — `Shadow`-layered neon dot
- **Goal.** The `StatusDot` with `pulse = true` (running state) should not just scale — it should look like a tiny neon LED: bright core + coloured halo.
- **Impl path.** Three stacked `circle_filled` layers:
  - Outer halo: `r = 6.0`, `alpha = 0x40 * pulse`, colour = status tint.
  - Mid halo: `r = 4.0`, `alpha = 0x80`, colour = status tint.
  - Core: `r = 3.0`, `alpha = 0xff`, colour lerped toward white by 0.35.
  Plus `egui::epaint::Shadow { offset: [0, 0], blur: 6, spread: 2, color: tint.with_alpha(0x50) }` painted into the same layer rect via `ctx.layer_painter(LayerId::new(Order::Background, id))`.
- **Perf.** Inexpensive (3 `circle_filled` + 1 `Shadow` per dot). Cap visible animated dots at 32 via `StatusDot::with_animation_gate(visible_count_budget)`.

#### `fx/shader_background.rs` — wgpu paint callback (hero surfaces)
- **Goal.** Hero panels (welcome screen, empty-state rail cards, command-palette backdrop) get a real shader-backed animated gradient — colour-shifted over time, with a subtle radial vignette.
- **Impl path.** `egui_wgpu::CallbackTrait` implementor that owns a `wgpu::RenderPipeline` + uniform buffer. Fragment shader (WGSL):
  - 2-stop radial gradient centred at `uv * aspect`, stops from `hero_gradient_a` → `hero_gradient_b`.
  - Noise-modulated hue shift sampled by `time`.
  - Vignette: `pow(1.0 - distance(uv, center), 0.8)` darken.
- **Build.** Compile-once pipeline stored in `CreationContext`'s `wgpu_render_state`. Uniforms updated per-frame with `queue.write_buffer`.
- **Feature flag.** `fx::shader_background::available()` returns `true` iff the renderer is wgpu and the pipeline compiled. Otherwise the gradient fallback paints instead.
- **Perf.** GPU-side; ~0.1 ms on integrated graphics at 1440p.

#### `fx/command_palette_backdrop.rs` — approximate backdrop blur
- **Goal.** When `CommandPalette.open == true`, the rest of the app visibly dims + blurs behind the palette.
- **Impl path.** True backdrop blur is not available (parity §1.7). Approximate:
  - Paint a `command_palette_scrim` colour rect over the whole screen at `Order::PanelResizeLine` (below palette, above content).
  - Paint 4 low-alpha copies of a pre-captured framebuffer offset by `±2 px` in x/y (*only* when the wgpu callback path is available — stored via a shader). Otherwise skip and ship the scrim alone.
- **Budget.** Scrim-only path: ~0.2 ms. Shader-sampled path: ~0.6 ms.

### 7.3 Perf budget

- Total CPU budget for fx per frame: **< 2 ms**.
- Total GPU budget for fx per frame: **< 1 ms**.
- Only run fx when their rect intersects `ui.clip_rect()` (i.e. visible).
- User preference in Settings: `AppState.fx_preference: FxPreference { Solid, Soft, Full }`.
  - `Solid` — no fx, fastest.
  - `Soft` (default) — gradient + glow + neon, no shader callbacks.
  - `Full` — everything, including wgpu hero shader.
- On startup, measure a median frame-time sample over 60 frames; if > 16 ms at `Full`, drop to `Soft` and toast the user.

### 7.4 FX item count

Five fx modules: `gradient_background`, `glow_stripe`, `neon_pulse`, `shader_background`, `command_palette_backdrop`.

---

## Part 8 — DX improvements per tool

Five bullets per surface, concrete and testable.

### 8.1 Agent chat

1. **Tool-call grouping.** `ToolCallGroup` collapses consecutive events into `> N tool calls, M messages`. Expand on click. Maps from `AgentEvent` via the parser in §4.5.
2. **Retry from here.** Right-click an assistant `AgentMessage` → `Retry from here`. Truncates chat history at that message and re-dispatches via `AgentsRuntime::retry_from`.
3. **Token-budget meter.** Composer-footer pill reads `Session.tokens_used`; turns amber at 80 %, red at 95 % of `context_window`.
4. **Inline file-badge parsing.** Assistant text with `@path/to/file` renders a `FileBadge`; click opens the file in a new center tab via `RuntimeState::open_file`.
5. **Scroll-to-bottom pill.** `ScrollToBottomPill` with unread count driven by `ChatTabState.auto_scroll_pinned`.

### 8.2 Editor

1. **Line numbers + active-line gutter.** Replace the raw `TextEdit::multiline` with a `LineNumberedEditor` that paints line numbers left of the text edit using `tokens.editor_line_number` / `editor_line_number_active`. Uses `TextEdit::show()` → `TextEditOutput` to read cursor.
2. **Diff gutter.** In diff tabs, the `CodeDiffBlock` paints green/red chips in the gutter using `success_subtle` / `danger_subtle`.
3. **⌘-click to split.** Intercept `Modifiers::COMMAND` + primary click on a gutter line; open same file in the opposite rail via a new `RuntimeState::open_file_side(path, SplitSide)`.
4. **Collapsible unmodified runs.** `CodeDiffBlock` with `collapse_unmodified_over: 6` folds runs of unchanged context into `<N unmodified lines>` foldable rows.
5. **LSP diagnostics.** When Phase 9 restores the LSP integration under `voidlink-core::lsp`, wire `Publisher<DiagnosticEvent>` into the editor gutter (squiggles via `Painter::line_segment` in a zig-zag along the text rect bottom).

### 8.3 Terminal

1. **Rail-mount.** `TerminalCard` hosts an `egui_term::TerminalView` inside a `RailCard`; user can keep a terminal and an agent chat side-by-side.
2. **Inline filter tabs.** In `LogsCard`, `InlineLogCard` exposes `all | stdout | stderr` filter.
3. **Search.** `⌘F` inside the terminal focuses a small search strip above the terminal view; dispatches via `egui_term::BackendCommand`.
4. **Copy last command.** Shell-integration addon emits prompt markers; expose a `Copy last command` button in the `TerminalCard` title strip.
5. **ANSI hyperlink detection.** Detect `file://` and `vscode://` links in the terminal buffer and open via `RuntimeState::open_file` when clicked (requires a small extension to `egui_term` or a local copy of its link detector).

### 8.4 Git

1. **PR-state chrome.** `PRHeaderBand` + `SessionStatusChip` surface PR state in both the rail and the sidebar.
2. **Delta counts everywhere.** `DeltaCount` lives on `SessionRow`, `PRChangesPanel` rows, branch list rows, and the Tasks card.
3. **Draft-PR preview.** `Session.pr.draft == true` paints the band muted + shows a `Mark ready` button that calls `voidlink-core::git_review::mark_pr_ready`.
4. **Session merge button.** `PRHeaderBand`'s `[Merge]` button is enabled iff `pr.mergeable == Mergeable::Clean`; disabled with a tooltip otherwise.
5. **One-click conflict resolver.** When `mergeable == Conflicts`, the band exposes `Resolve in editor` which opens a dedicated diff tab per conflicting file.

### 8.5 Workspace / left rail

1. **Pin / unpin sessions.** Right-click `SessionRow` → `Pin`. Pinned sessions render under a `Pinned` header.
2. **⌘1..9 jump.** Assign `shortcut_index` to the first 9 sessions; chip renders `⌘1`. `ctx.input(|i| i.modifiers.command && i.key_pressed(Key::Num1))` → `SessionsRuntime::activate_by_shortcut`.
3. **⌘P command palette.** `CommandPalette` searches sessions, repos, files, commands, settings, theme. Fuzzy match via `fuzzy_matcher` crate.
4. **Archive.** `status: Archived` hides the row from Recents but keeps the worktree + PR data.
5. **Drag to reorder repositories.** `Sense::drag()` on `WorkspaceGroup` header; drop commits `Workspace.repository_ids` order.

### 8.6 Repo intelligence

1. **Graph glow.** Running scan jobs paint `fx::glow_stripe` under the graph edges touched during the current job.
2. **Search palette arrow-nav.** `↑/↓/Enter/Esc` behaviour in the search tab's result list.
3. **Entity preview card.** Click a node → floating `RailCard::Preview` attaches to the right rail with entity metadata.
4. **Dataflow annotations.** Colour-code flows by `success` / `warning` depending on test coverage of each edge.
5. **Shader background on graph canvas.** Repo-intel tabs opt into `fx::shader_background` when `FxPreference == Full` for a subtle parallax under the graph.

### 8.7 Notes

1. **Slash-command menu** — `/heading`, `/code`, `/todo`, `/link`, `/file`. Inline popover (`egui::Area` positioned near cursor).
2. **Pinned notes** surface at top of the notes sidebar.
3. **Search within notes** — debounced `TextEdit` filter.
4. **Linked file badges.** A `@path` inside a note renders a `FileBadge` via the same parser used by agent messages.
5. **Markdown preview pane** — toggle via a button in the note editor header; `egui_commonmark::CommonMarkViewer` side-by-side.

---

## Part 9 — Phased implementation plan (ED-A .. ED-G)

**Rule of thumb.** Tokens + fonts + primitives first. Feature flag `RuntimeState.new_shell` gates the shell-level restructure (ED-C onward). Data-model migration is riskiest → last.

### ED-A · Tokens + fonts + primitives + toast host + motion helpers
- **Scope.** Create `theme/tokens.rs` (91-field `ThemeTokens`), fill Dark / Light / Nord fully. Replace `Theme::apply` with parity §5.3 pattern (`ctx.data_mut(|d| d.insert_temp(Id::NULL, tokens))`). Install Geist + Geist Mono via `install_fonts` in `main.rs`. Create `motion.rs`. Create `widgets/` with `button`, `icon_button`, `input`, `badge`, `kbd`, `switch`, `tabs`, `tooltip`, `context_menu`, `modal`, `scroll`, `card`, `list_row`, `divider`, `spinner`, `delta_count`, `file_badge`, `keyboard_hint_chip`, `status_dot`, `tab_subtitle`, `branch_chip`, `tool_call_group`, `toast_host`. Create `state/toasts.rs`. Add `ui/widgets/gallery.rs` under a `widget-gallery` cargo feature.
- **Deps.** None.
- **Verification.**
  - `cargo check --all-targets`.
  - `cargo run --features widget-gallery` renders all primitives in Dark / Light / Nord.
  - Screenshot diff against parity-guide reference frames.
- **Effort.** 5 eng-days.
- **Risks.** Font licence compliance — ship `desktop/assets/fonts/LICENSE.txt` per parity §6. Contrast regression on any new token — covered by `theme::assert_contrast()`.

### ED-B · TitleBar refactor + `BranchChip` + breadcrumb
- **Scope.** Split `ui/title_bar.rs` into `ui/title_bar/` with `breadcrumb`, `subtabs`, `branch_chip`, `window_buttons`. Tighten drag region. Add macOS traffic-light reserve (80 px pad-left when `cfg(target_os = "macos")`).
- **Deps.** ED-A (`BranchChip`, `TabSubtitle`).
- **Verification.** Manual: open a session, see `⌥ <name>` in header, `/branch Open ▾` on the right, sub-tabs visible when more than one center tab is open. Drag title bar on Linux/Wayland, Windows, macOS.
- **Effort.** 2 eng-days.
- **Risks.** Wayland drag: `ctx.send_viewport_cmd(ViewportCommand::StartDrag)` timing on KDE needs the click event handled in the same frame. Guard with `ui.input(|i| i.pointer.primary_pressed())`.

### ED-C · `RailCardDeck` + empty card shells (feature-flagged)
- **Scope.** Build `ui/right_rail/mod.rs` (`RailCardDeck`), `rail_card.rs`, `deck_toolbar.rs`, and all seven card shells (Preview, Changes, Terminal, Tasks, Plan, PRReview, Logs) — each renders placeholder content. Feature-flag via `RuntimeState.new_shell`. When flag is off, `ui/right_panel.rs` continues to render unchanged.
- **Deps.** ED-A.
- **Verification.** With flag on, can drag cards, dismiss, and re-add from `+` popover. Order persists per session via `RailCardState[]`.
- **Effort.** 4 eng-days.
- **Risks.** Drag persistence — same trade-off as Tauri plan R3: store deck state in `state/sessions.rs` per session, not per workspace.

### ED-D · Agent chat redesign (builds on Phase 7)
- **Scope.** Split `ui/agents/chat.rs` into `agent_message.rs`, `chat_timeline_row.rs`, `tool_call_group.rs`, `scroll_to_bottom_pill.rs`, `auto_accept_toggle.rs`, `token_budget_meter.rs`, `model_selector.rs`, `command_footer.rs`. Wire file-badge parser. Add best-effort tool-call parser (§4.5) over `AgentEvent.text`.
- **Deps.** ED-A, ED-C (so chat telemetry can spill into rail cards `Tasks` / `Plan`).
- **Verification.** Existing agent runs keep working. Tool calls visually collapse. `@file` badges open files. Token meter updates while streaming.
- **Effort.** 5 eng-days.
- **Risks.** Event-stream dedup — preserve the `seen_event_ids` HashSet from the Phase 7 implementation. Parser false-positives: ship with a unit test suite of example event strings.

### ED-E · Workspace / Session data model + left-rail grouping
- **Scope.** Create `state/workspaces.rs` (`Workspace` + `Repository`), `state/sessions.rs` (`Session` + `SessionsRegistry`), `state/rail_deck.rs`. Write `migrate_v1_to_v2` in `state/persistence.rs`. Refactor `ui/sidebar.rs` → `ui/left_rail/` with `WorkspaceGroup`, `SessionRow`, `SessionStatusChip`, `PinnedSection`, `RecentsSection`, `AddRepositoryButton`, `FooterIcons`. `SidebarPage::Explorer` content now hosts the workspace groups.
- **Deps.** ED-A, ED-B, ED-D.
- **Verification.** Existing single-`repo_root` users load into a single `Repository` + single `Session`. Can add a second repository to an existing workspace. Pin/unpin persists. `⌘1..9` jumps.
- **Effort.** 6 eng-days.
- **Risks.** Data-model break — keep the v1 `.bak` file. If `state/persistence.rs::load` fails migration, fall through to default state and toast `"Workspace layout migrated — old file preserved at state.v1.bak"`.

### ED-F · PR chrome end-to-end
- **Scope.** `ui/pr/pr_header_band.rs`, `ui/pr/pr_changes_panel.rs`. Wire `Session.pr` via a poller in `state/sessions.rs` that calls the `voidlink-core::git_review` APIs. Hook merge button. Colour transitions on status flip. `PRHeaderBand` glow via `fx::glow_stripe`.
- **Deps.** ED-E, plus `voidlink-core::git_review` actually exposing PR data post-migration. If not yet available, ship with a stubbed adapter that returns `None` + a compile-time marker `TODO(ED-F-pr-data)`.
- **Verification.** Open a session with an upstream PR — band renders correct state. Merge button enables only when `mergeable == Clean`.
- **Effort.** 4 eng-days.
- **Risks.** GitHub rate limits — poll interval defaults to 45 s with exponential back-off up to 300 s on 403. Auth edge cases piggy-back on existing Phase-6 token handling.

### ED-G · Editor / terminal / status bar polish + shader fx + command palette
- **Scope.**
  - `ui/components/code_diff_block.rs`.
  - Line-numbered editor (`LineNumberedEditor`).
  - `StatusBar` segments (branch, sync, problems, line/col, mode).
  - `fx/` module (§7): `gradient_background`, `glow_stripe`, `neon_pulse`, `shader_background`, `command_palette_backdrop`.
  - `CommandPalette` (⌘K / ⌘P).
- **Deps.** ED-A (primitives), ED-C (rail cards).
- **Verification.** Diff tab folds unmodified runs. Palette opens on `Ctrl/⌘+K`, filters at interactive rate with 1000 seeded commands. Shader backdrop renders at `Full` fx preference; gradient fallback renders when wgpu pipeline unavailable. Frame-time under 16 ms at 1440p on integrated Intel.
- **Effort.** 6 eng-days.
- **Risks.** wgpu shader pipeline portability — test on Linux (Wayland + X11), macOS, Windows.

**Total estimated effort.** ~32 eng-days for one engineer (≈ 3–3.5 weeks with review / QA / cross-OS testing).

### Feature-flag strategy

- `RuntimeState.new_shell: bool` — runtime toggle surfaced in Settings. Default `true` in `cfg(debug_assertions)`, `false` otherwise until ED-G passes QA on all three OSes.
- `cargo feature widget-gallery` — debug-only widget catalog under `ui/widgets/gallery.rs`.
- `cargo feature glow-fallback` — opt-in `egui_glow::CallbackFn` path for `fx::shader_background` on systems where wgpu fails to initialise.
- `AppState.fx_preference: FxPreference` — user-visible control (`Solid` / `Soft` / `Full`) independent of the compile-time feature. Default `Soft` with auto-drop to `Solid` on slow frames.

---

## Part 10 — Risks & open questions

### R1 · egui 0.31 vs 0.34 divergence
`egui_code_editor 0.2.24` pulls egui 0.34, so it stays off the table. If we end up wanting a richer code editor (syntax highlight, folding) we need either to upstream 0.31 support or wait for `egui_code_editor` 0.3 on current egui. **Open:** do we hand-roll a minimal highlighter using `syntect` or accept a plain `TextEdit` + line numbers until a compatible editor crate surfaces?

### R2 · glow vs wgpu backend
Real blur in `epaint::Shadow` and any custom shader (`fx::shader_background`) both want the wgpu renderer. The glow renderer in eframe still ships and some Linux setups (very old Mesa, software rasterisers) need it. **Open:** do we hard-require wgpu or keep the `glow-fallback` feature? Recommendation: require wgpu as the default; keep `glow-fallback` compile-only (no release builds) for bring-up on exotic systems.

### R3 · Wayland / KDE title bar drag
Current drag uses `ViewportCommand::StartDrag`. On KDE Wayland with server-side decorations disabled, pointer capture mid-frame drops the drag. **Open:** do we adopt `winit` 0.30's `start_drag_window` directly, or accept the flakiness and document it? Recommendation: ship the current API; add a `Settings → Window → Use native titlebar` escape hatch that lets KDE users fall back to SSD.

### R4 · macOS traffic-light reserve
eframe on macOS optionally hides native window controls via `with_title_shown(false) + with_titlebar_buttons_shown(false)`. If we hide them we must reserve 80 px pad-left + render our own. If we keep them, we must not render our own custom window buttons. **Open:** which mode is canonical? Recommendation: detect `cfg(target_os = "macos")` and hide native controls; render the full VoidLink header including traffic-light-style dots on the left to preserve muscle memory.

### R5 · fx perf on integrated graphics
`fx::shader_background` and `fx::glow_stripe` together could push beyond 2 ms CPU + 1 ms GPU on a Haswell iGPU. **Open:** do we auto-downgrade mid-session based on a rolling frame-time window, or only at startup? Recommendation: both — startup calibration picks `Soft`/`Full`, and a rolling 120-frame window can toast `"FX dropped to Soft due to slow frames"` if sustained > 18 ms.

### R6 · Theme coverage for v2 tokens
Parity §5 lists seven additional themes deferred to Phase F. The §5 tokens here (34 new fields) must have values in all of them before those themes ship. **Open:** do we auto-derive (primary-relative saturation/lightness rules) or hand-tune? Recommendation: ship dark/light/nord hand-tuned now, write an auto-derivation routine in `theme::auto_fill::derive_extended` that other themes call as a seed, then the maintainer hand-tunes per theme in later PRs.

### R7 · Tool-call stream vs free-text events
Until Phase 8 lands structured tool-call events, `ChatTimelineRow` depends on a regex parser over `AgentEvent.text`. Regex brittleness is real. **Open:** do we commit to a set of regexes per supported agent backend (Claude / Codex / OpenCode) and ship test fixtures in `desktop/tests/tool_call_parser.rs`, or hold `ChatTimelineRow` behind another flag until structured events exist? Recommendation: ship the parser with tests + a fallback `Other` row that carries the raw text — no silent dropouts.

### R8 · `voidlink-core::git_review` shape
git status shows `src-tauri/src/git_review/*.rs` deleted and `voidlink-core/` untracked. ED-F depends on `voidlink-core::git_review` exposing `list_prs`, `mark_ready`, `merge_pr`, `checks_summary`. **Open:** is this surface committed in `voidlink-core`'s API yet? If not, ED-F must land behind a `#[cfg(feature = "pr-live")]` flag with a stub implementation.

### R9 · Drag-reorder dependency
`egui_dnd` is the clean option but adds a dep and recently chases egui versions. Hand-rolling via `Sense::drag()` is ~80 LOC per reorderable surface. **Open:** add `egui_dnd` or roll our own shared `widgets/dnd.rs` helper? Recommendation: roll our own once (`widgets/dnd.rs`), reuse from `RailCardDeck`, `WorkspaceGroup`, `left_rail/recents_section`.

### R10 · Bottom pane role after rail cards
Terminal / Logs moving to rail cards leaves the bottom pane half-empty. **Open:** keep the bottom pane for workspace-global things (Problems, global search, Output) and make session-scoped things (terminal, logs tied to an agent) rail-only? Matches VS Code split. Recommendation: yes — rename `BottomTab::{Terminal, Git, Logs}` to `BottomTab::{Problems, Output, Search}` as part of ED-G.

### R11 · Font asset size
Four Geist weights + two Geist Mono weights at ~250 KB each = ~1.5 MB. Embedded via `include_bytes!` the binary grows by the same. **Open:** ship all six, or prune to Regular + Medium + GeistMono-Regular? Recommendation: Regular + Medium + SemiBold for Proportional and Regular for Mono = 4 files ≈ 1 MB. SemiBold covers heading bold; Medium covers the rest.

### R12 · `egui_commonmark` vs custom Markdown
`egui_commonmark` 0.20 renders Markdown but has limited styling hooks for code blocks (no language-aware highlight). Agent messages and notes both render Markdown. **Open:** do we post-process the `CommonMarkCache` output to inject our diff/code blocks, or ship an in-house renderer? Recommendation: keep `egui_commonmark` for notes and lightweight assistant prose; route tool-call blocks through `ChatTimelineRow` / `CodeDiffBlock` directly, bypassing Markdown entirely.

---

## Part 11 — Visual parity checklist

On a fresh install with a seeded `conductor` workspace (Conductor parity) and an `acme-web` workspace (Codex parity), the following must hold. Booleans map to test fixtures in `desktop/tests/visual/`.

### Left rail (Conductor parity)
- [ ] Workspace groups are collapsible; each has a repo-name header + N `SessionRow`s.
- [ ] `SessionRow` renders two lines: name + `DeltaCount +X -Y` on line 1; parent-branch + `SessionStatusChip` + `KeyboardHintChip` on line 2.
- [ ] Active row shows a 2 px left stripe in `primary` + `primary_subtle` fill; running sessions add a `fx::glow_stripe` pulse.
- [ ] Status tints: green subtitle for `ReadyToMerge`, amber for `MergeConflicts`, muted for `Archived`, red pulse for `ChecksFailing`.
- [ ] Footer row: `+ Add repository`, archive icon, chat icon, settings icon as `Ghost` `IconButton`s.

### Left rail (Codex parity)
- [ ] `Pinned` header above `Recents`.
- [ ] Recents rows show a leading `StatusDot` when the session is running.
- [ ] Footer shows workspace identity (`🏠 <workspace-name>`) + theme selector.

### Header (Conductor parity)
- [ ] Breadcrumb `⌥ <session-name>` left-aligned under window chrome.
- [ ] `TabSubtitle` strip renders `All changes | Debugging … | Review | +` with underline-under-active.
- [ ] `BranchChip` `/kampala-v3  Open ▾` right-aligned in header.
- [ ] Drag region does not capture pointer events over interactive widgets.
- [ ] macOS build shows native traffic lights left-padded to 80 px; Linux/Windows render custom window buttons on the right.

### Agent chat (Conductor + Codex parity)
- [ ] Error messages render as subtle red pill with an inline `FileBadge`.
- [ ] Tool-call runs collapse into `ToolCallGroup` (`> N tool calls, M messages`).
- [ ] Tool events render as `ChatTimelineRow` with `kind`, `path`, `DeltaCount`, duration.
- [ ] User messages use `surface_elevated` bubble; assistant text is bubble-less prose.
- [ ] `ScrollToBottomPill` appears when not pinned to bottom.
- [ ] Composer trailing `KeyboardHintChip` `⌘L to focus`.
- [ ] Composer footer shows `ModelSelector` + `@ Link issue` + `AutoAcceptToggle` + paperclip + send.
- [ ] `TokenBudgetMeter` pill visible; amber at 80 %, red at 95 %.

### Right rail (Codex parity)
- [ ] `RailCardDeck` renders 3–6 `RailCard`s; each has `×` dismiss + drag handle.
- [ ] Dismiss + re-add via `+` popover restores content + order.
- [ ] Card order persists across reloads per session.
- [ ] `PreviewCard` shows a fake browser chrome + tab row with a close `×`.
- [ ] `TerminalCard` embeds a working `egui_term::TerminalView`.
- [ ] `ChangesCard` shows `Changes N | All files | Review` sub-tabs; rows show truncated paths with right-aligned `DeltaCount`.
- [ ] `TasksCard` groups `Running` + `Completed`; runtime per row.
- [ ] `PlanCard` toggles items ☐ / ☑.

### PR chrome (Conductor parity)
- [ ] `PRHeaderBand` renders solid green when ready (`pr_ready_bg`), amber on conflicts, muted on draft, red on failing checks.
- [ ] Band shows `PR #<n> ↗ <status-phrase> [Merge]`.
- [ ] Merge button disabled when `mergeable != Clean`; tooltip explains why.
- [ ] Glow underlay pulses behind the band when `status == ReadyToMerge`.

### Editor / terminal / status bar
- [ ] Editor tabs show line numbers with `tokens.editor_line_number` / `_active`.
- [ ] `CodeDiffBlock` collapses unmodified runs as `<N unmodified lines>`.
- [ ] `InlineLogCard` colours `[tsc]`, `[vite]`, `[cargo]` prefixes distinctly.
- [ ] Status bar shows branch, sync indicator, problems count, line/col, encoding, language.
- [ ] `⌘K` opens the `CommandPalette`; `⌘P` opens the file quick-open.

### Motion
- [ ] Row hover animates `background-color` over 80 ms (`motion::dur::ROW_HOVER_FILL`).
- [ ] PR band cross-fades over 220 ms when status changes.
- [ ] Status dot pulses at 1.4 s cadence when running (shader-backed glow via `fx::neon_pulse`).
- [ ] Drag of a rail card settles with 180 ms rubber-band.
- [ ] Toast enter 180 ms / exit 140 ms.
- [ ] Command palette scrim fades 120 ms; panel scale-ins 140 ms.

### Shaders / fx
- [ ] `FxPreference::Soft` paints gradient background + glow stripes + neon pulse at < 2 ms CPU on integrated Intel.
- [ ] `FxPreference::Full` adds wgpu hero shader on welcome + command-palette backdrop.
- [ ] `FxPreference::Solid` disables all fx; sustained 60 fps guaranteed.
- [ ] Auto-drop `Full → Soft → Solid` on sustained slow frames; toast on drop.

### Themes
- [ ] All §5 tokens resolve in Dark, Light, Nord.
- [ ] `theme::assert_contrast()` passes WCAG AA for every `_fg` / `_bg` pair.
- [ ] No hard-coded `Color32::from_rgb` in `ui/` code; `grep -RIn "from_rgb" desktop/src/ui` returns zero results.

---

*End of plan. Extends `docs/egui-ui-parity-guide.md` and `docs/egui-phase-7-agent-system.md`. Supersedes `docs/tauri-frontend-polish-plan.md` for the active migration direction.*
