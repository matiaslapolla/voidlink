# VoidLink Tauri Frontend — Polish & Parity Plan

**Goal.** Bring the SolidJS + Tauri frontend (`frontend/`) to the polish level of
**Conductor.build**, **VS Code**, **Cursor**, and **Codex/Claude Code Desktop** while
strictly respecting our existing brand system defined in
`docs/egui-ui-parity-guide.md` (the "parity guide"). This doc **extends** the parity
guide — it does not duplicate it. Anywhere a token exists already, we reference it
by section; only genuinely new tokens are added in §5.

Scope: planning + scaffolding blueprint. No source code is edited here. The output
is the set of component names, props, data-model changes, token deltas, motion
rules, DX wins, and a phased rollout. Effort is sized in engineer-days; risks and
open questions are surfaced explicitly.

---

## Table of Contents

1. Audit of current state
2. New information architecture
3. Component scaffold blueprint
4. Data model extensions
5. Token extensions (beyond parity guide)
6. Motion additions
7. DX improvements per tool
8. Phased implementation plan (FE-A..FE-G)
9. Risks & open questions
10. Visual parity checklist

---

## Part 1 — Audit of current state

Paths are relative to `frontend/src/`. "UC" = upgrade class. Legend:
`MP` = minor polish, `RE` = restructure, `NF` = new feature, `DM` = data-model change.

| Area | Current impl (paths) | Strengths | Gaps vs references (Conductor / Codex / VS Code / Cursor) | UC |
|---|---|---|---|---|
| Title bar | `App.tsx:282–330`, `components/TitleBar.tsx` (unused duplicate) | Glass styling; working Tauri drag region; theme + layout + window controls in a single row | No breadcrumb (Conductor puts `⌥ archive-in-repo-details` in header), no right-side branch chip (`/kampala-v3  Open ▾`), no tab sub-title row. Two `TitleBar` variants exist (root + `components/`) — dead code. macOS traffic-light reserved padding inconsistent with Linux/Windows. | RE |
| Left sidebar | `components/layout/LeftSidebar.tsx`, `components/layout/FileExplorer.tsx`, `components/layout/NavTree.tsx`, `components/sidebar/PageSidebar.tsx`, `components/workspace/WorkspaceSidebar.tsx` | Solid keyboard shortcut (`Ctrl+B`); collapsed-to-rail mode; NavTree + FileExplorer side-by-side; workspace dropdown w/ rename | Workspace is flat (just a `WorkspaceDropdown`). Conductor groups `repo → branch/session` with status chip (`kampala-v3 · Ready to merge · ⌘1`), delta counts (`+312 -332`), and a `+ Add repository` CTA. No `⌘1..9` jump. Footer lacks the icon-trio (archive/chat/settings). No "Home" entry. No Codex-style pinned/recent sections with status dots. | RE + DM |
| Center column | `components/layout/CenterColumn.tsx`, `CenterTabBar.tsx`, `BreadcrumbBar.tsx` | Clean singleton/dynamic tab distinction; drag-reorder; preview/pin; middle-click close | Tab bar lacks sub-tabs (Conductor: `All changes | Debugging ReferenceError | Review branch changes | +`). Breadcrumb does not accept right-side actions (branch chip + dropdown). No contextual "tab subtitle" for agent-chat sessions. | RE |
| Right sidebar | `components/layout/RightSidebar.tsx` | Collapsible sections (Context / GitStatus / TokenUsage / Activity), persisted, badge counts | Monolithic: sections are fixed, unreorderable, non-dismissible. Codex refs show **stackable cards** (Preview / Log / Diff / Terminal / Tasks / Plan) with `×` dismiss + drag handle. No PR-state chrome on top (`PR #1432 ↗ Ready to merge [Merge]`). No file list with delta counts (Conductor `Changes 10 | All files | Review`). No embedded Terminal sub-pane. | RE + NF |
| Bottom pane | `components/layout/BottomPane.tsx`, `BottomPanel.tsx` | Tabbed (Terminal / Git / Logs / Agent); resize; keyboard toggle | Redundant with right-rail cards in the Codex pattern. Logs/Agent are "coming soon" placeholders (`App.tsx:416–425`). No status bar integration. | RE |
| Status bar | `components/layout/BottomBar.tsx` | Tab toggles with active highlight; statusText; repoPath | No VS Code-style segments (branch, sync indicators, problems count, line/col, encoding, language mode). No clickable affordances. Monotone muted text. | NF |
| Agent chat | `components/agent/AgentChatView.tsx` (531 lines), `AgentOrchestratorView.tsx` | Working Tauri event stream; polling fallback; inline file panel with diff; running/success/failed chrome | Monolithic component. No tool-call grouping (Conductor: `> 13 tool calls, 7 messages`). No inline file-badge parsing (`@RepositoryDetailsDialog.tsx`). No Codex-style compact timeline rows (`Write src/… +62 >`). No "Scroll to bottom" pill. No composer footer (model pill, `@ Link issue`, brain, paperclip). No token-budget meter (Conductor shows `25s · ↓ 37.1k tokens`). No Auto-accept toggle. No retry-from-here. | RE + NF |
| Editor | `components/editor/Editor.tsx` (TipTap — unused in main shell?), `CodeMirrorEditor.tsx`, `FileEditor.tsx`, `SplitDiffView.tsx`, `EditorToolbar.tsx` | CodeMirror 6 integration (see commit `5b4a48b`); split diff available | No gutter diagnostics (LSP wire is detached after Rust refactor per git status). No quick-action lightbulb. No `⌘click` to split. `SplitDiffView` has no collapsible `38 unmodified lines`. No minimap. | RE + NF |
| Terminal | `components/terminal/TerminalView.tsx`, `TerminalPane.tsx`, `ShellIntegrationAddon.ts` | xterm integration with shell-integration addon; PTY via Tauri | No inline filter tabs (`all / stdout / stderr`), no colored `[tsc] / [vite]` prefix support, no search, no copy-last-command, no ANSI hyperlink detection. Only lives as bottom-pane or dynamic tab — can't be stacked into right rail. | NF |
| Git panel | `components/git/` — 18 files incl. `GitTabContent`, `PrDashboard`, `PrPreview`, `PrReviewView`, `MergeButton`, `DiffViewer`, `SplitDiffViewer`, `DiffExplanation`, `WorktreePanel`, `AuditLog`, `BranchPicker`, `GitStatusBar` | Broad surface: PR listing, review view, merge button, diff explain, worktrees, audit log, branch picker | Chrome doesn't match Conductor's green band (`PR #1432 ↗ Ready to merge [Merge]`). Delta counts absent on row level (only shown in diff). No `Changes 10 / All files / Review` sub-tab on the right rail. No "Ready to merge / Merge conflicts / Draft" sidebar status chip per session. GitHub API wiring lives in `git-agent` / `git-review`; not surfaced as session metadata. | RE + DM |
| Repository / graph | `components/repository/RepositoryView.tsx`, `Graph2D.tsx`, `Graph3D.tsx`, `DataFlowView.tsx`, `EntityView.tsx`, `SearchTab.tsx`, `RepositoryHeader.tsx` | Rich visualisation; search + graph views | Not wired into the new session concept; graph is presentational but has no link to sessions / branches. | MP |
| Settings | `components/settings/SettingsPanel.tsx` | Dialog-based; opens from left rail | Not a full settings surface (keyboard / themes / accounts / integrations). Cursor/VS Code-level settings page missing. | NF |
| Prompt Studio | `components/prompt-studio/PromptStudioView.tsx` | Singleton tab; execution + versioning + optimization (from commit `475f3ea`) | Could reuse the new `ChatTimelineRow` + `ToolCallGroup` primitives for a denser run view. | MP |
| Workflow | `components/workflow/WorkflowTab.tsx`, `hooks/useWorkflowManager.ts` | DSL + run-state; objective/constraints | No visual pipeline (Codex shows `Write → Edit → Lint → Typecheck → Build` timeline); we only render text. | RE |

### Dead code / debt flagged during audit

- `frontend/src/components/TitleBar.tsx` is unused — `App.tsx` renders its own title bar inline. Remove or wire it.
- `frontend/src/components/workspace/WorkspaceSidebar.tsx` exists alongside `LeftSidebar.WorkspaceDropdown`. Consolidate.
- Bottom pane "Logs" and "Agent output" tabs are placeholders (`App.tsx:416–425`). Either ship or delete.
- `activeArea` on `WorkspaceState` (`types/workspace.ts`) duplicates center-tab routing now that tabs exist per workspace.

---

## Part 2 — New information architecture

Target tree (stable IDs in `kebab-case`, components in `PascalCase`):

```
AppShell (three-column, persistent)
├── TitleBar (breadcrumb mode)
│    ├── TitleBarLogo
│    ├── TitleBarBreadcrumb   ← NEW: "⌥ archive-in-repo-details"
│    ├── TitleBarSubtabs      ← NEW: "All changes | Debugging … | Review"
│    ├── TitleBarBranchChip   ← NEW: "/kampala-v3  Open ▾"
│    └── TitleBarWindowButtons (theme / layout / min / max / close)
│
├── LeftRail (workspace-grouped, Conductor-style)
│    ├── HomeEntry
│    ├── WorkspaceGroup × N     ← NEW
│    │    ├── RepositoryRow      (name, branch count, collapse)
│    │    └── SessionRow × N     ← NEW: row w/ delta + SessionStatusChip + KeyboardHintChip
│    ├── PinnedSection           ← NEW (Codex)
│    ├── RecentsSection          ← NEW (Codex)
│    └── FooterRail
│         ├── AddRepositoryButton  ← NEW
│         ├── ArchiveButton
│         ├── ChatButton
│         └── SettingsButton
│
├── CenterColumn
│    ├── CenterTabBar           (existing, gets sub-tab slot)
│    ├── BreadcrumbBar          (existing, gets right-action slot)
│    └── CenterBody
│         ├── AgentChatView     (redesigned — see §3)
│         ├── RepositoryView / EditorView / DiffView / PromptStudioView / WorkflowView
│
├── RightRail (stackable card deck)  ← RESTRUCTURED
│    ├── PRHeaderBand           ← NEW (Conductor green band)
│    └── RailCardDeck
│         ├── RailCard: PreviewCard
│         ├── RailCard: ChangesCard
│         ├── RailCard: TerminalCard
│         ├── RailCard: TasksCard
│         ├── RailCard: PlanCard
│         ├── RailCard: PRReviewCard
│         └── RailCard: LogsCard
│
├── BottomPane (optional; no longer redundant)
│    └── collapsed by default — terminal/logs now live as rail cards
│
└── StatusBar (existing BottomBar)
     ├── BranchSegment
     ├── SyncSegment  (ahead/behind)
     ├── ProblemsSegment
     ├── LineColSegment
     ├── EncodingSegment
     └── ModeSegment
```

### Two big structural shifts

**Shift A — Workspace-grouped sidebar (Conductor).** The left rail stops being a
flat tab nav. It becomes: `Workspace → Repository → Session`. A **Session** is a
new top-level entity: (branch × task × chat × diff × PR). Multiple sessions can
exist per repo (think: multiple ongoing agent tasks on different branches,
matching Conductor's `kampala-v3`, `archive-in-repo-details`, etc.). Data-model
implications in §4.

**Shift B — Stackable right-rail cards (Codex).** `RightSidebar.tsx` stops being
a fixed set of collapsible sections and becomes a **RailCardDeck** — an ordered,
dismissible, drag-reorderable stack of `RailCard`s. Each card is a first-class
component (`PreviewCard`, `ChangesCard`, etc.). The user can close any card with
`×` and re-open from a "+" popover. Card order persists per workspace.

---

## Part 3 — Component scaffold blueprint

For each new/changed component: **Path**, **Purpose**, **Props** (sketched TS),
**Brand tokens used** (from parity guide §1.1 or §5 below), **Pattern mirrored**.

### 3.1 Layout shell

#### `components/layout/AppShell.tsx` — *refactor*
- **Purpose.** Top-level three-column layout. Gains `rightDeck` slot (replaces
  `rightSidebar`) and passes workspace id down so children can bind.
- **Props (sketch):**
  ```ts
  interface AppShellProps {
    titleBar: JSX.Element;
    leftRail: JSX.Element;
    centerColumn: JSX.Element;
    rightDeck: JSX.Element;      // was rightSidebar
    bottomPane?: JSX.Element;    // now optional
    statusBar: JSX.Element;
  }
  ```
- **Tokens.** `background`, `sidebar_bg`, `border`, `glass_*`, `shell_gradient_*`.
- **Pattern.** VS Code shell + Conductor proportions (left ~264px, right ~360px).

#### `components/layout/RailCardDeck.tsx` — **NEW**
- **Purpose.** Container for stackable `RailCard`s on the right rail. Handles
  ordering, add/remove, drag-reorder, persistence (via `layout` store).
- **Props:**
  ```ts
  interface RailCardDeckProps {
    workspaceId: string;
    sessionId: string | null;
    cards: RailCardState[];      // see §4
    onReorder: (ids: RailCardKind[]) => void;
    onDismiss: (kind: RailCardKind) => void;
    onAdd: (kind: RailCardKind) => void;
  }
  ```
- **Tokens.** `rail_card_bg` (§5), `rail_card_border` (§5), `border`, `surface`.
- **Pattern.** Codex right-rail stack. Drag uses HTML5 drag API like
  `CenterTabBar`.

#### `components/layout/RailCard.tsx` — **NEW**
- **Purpose.** Generic card wrapper. Accepts title, leading icon, trailing
  actions, drag handle, dismiss button, and `<slot />` body.
- **Props:**
  ```ts
  interface RailCardProps {
    kind: RailCardKind;
    title: string;
    icon?: Component<{ class?: string }>;
    trailingActions?: JSX.Element;  // e.g. search, tabs
    collapsible?: boolean;
    defaultCollapsed?: boolean;
    onDismiss?: () => void;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    children: JSX.Element;
  }
  ```
- **Tokens.** `rail_card_bg`, `rail_card_border`, `text_muted`, `hover`.
- **Pattern.** Codex `Preview ×` / `Terminal ×` / `Tasks ×` cards.

### 3.2 Workspace rail

#### `components/workspace/WorkspaceGroup.tsx` — **NEW**
- **Purpose.** A collapsible repo group in the left rail (Conductor style).
  Renders the repository name header + N `SessionRow`s.
- **Props:**
  ```ts
  interface WorkspaceGroupProps {
    workspace: Workspace;
    repository: Repository;
    sessions: Session[];
    activeSessionId: string | null;
    expanded: boolean;
    onToggle: () => void;
    onSelectSession: (id: string) => void;
    onAddSession: () => void;
  }
  ```
- **Tokens.** `sidebar_bg`, `hover`, `text`, `text_muted`.
- **Pattern.** Conductor left-rail group for `conductor`, `melty_home`, etc.

#### `components/workspace/SessionRow.tsx` — **NEW**
- **Purpose.** Two-line session row.
  - Line 1: `⌥ <session-name>   <DeltaCount +X -Y>`
  - Line 2: `<parent-branch> · <SessionStatusChip>   <KeyboardHintChip>`
- **Props:**
  ```ts
  interface SessionRowProps {
    session: Session;
    active: boolean;
    shortcut?: string;           // "⌘1".."⌘9"
    onClick: () => void;
    onContextMenu?: (e: MouseEvent) => void;
  }
  ```
- **Tokens.** `hover`, `primary` (active left stripe), `text`, `text_muted`,
  `delta_add_fg` (§5), `delta_del_fg` (§5), plus status-specific colors from
  `SessionStatusChip`.
- **Pattern.** Conductor row `⌥ archive-in-repo-details   +312 -332 / kampala-v3 · Ready to merge   ⌘1`. Active row gains 2px left stripe in `primary`.

#### `components/workspace/SessionStatusChip.tsx` — **NEW**
- **Purpose.** Color-tinted phrase for the session's state.
- **Props:**
  ```ts
  interface SessionStatusChipProps {
    status: SessionStatus;       // see §4
    compact?: boolean;
  }
  ```
- **Tokens.** `pr_ready_bg` (§5, subtitle tint), `pr_conflict_bg` (§5), `warning`,
  `text_muted`, `success`, `danger`.
- **Pattern.** Conductor green "Ready to merge", amber "Merge conflicts",
  muted "Archive".

#### `components/workspace/AddRepositoryButton.tsx` — **NEW/MOVE**
- **Purpose.** Footer "+ Add repository" button — picks a directory and creates a
  `Repository` (new entity, see §4). Opens the existing `open()` dialog from
  `@tauri-apps/plugin-dialog`.
- **Props:**
  ```ts
  interface AddRepositoryButtonProps {
    workspaceId: string;
    onAdd: (repoPath: string) => void;
  }
  ```
- **Tokens.** `text_muted`, `hover`, `primary` (hover text).

### 3.3 UI primitives (extend `components/ui/`)

| Component | Path | Purpose | Props | Tokens | Pattern |
|---|---|---|---|---|---|
| `DeltaCount` | `components/ui/DeltaCount.tsx` | Monospace `+X -Y` pair, optional zero-hide | `{ add: number; del: number; hideZeros?: boolean; size?: 'xs'\|'sm' }` | `delta_add_fg`, `delta_del_fg` (§5) | Conductor row `+312 -332`, Codex `+62`, `+142 -38` |
| `FileBadge` | `components/ui/FileBadge.tsx` | Mono-ish chip `@Filename.tsx` with optional open-on-click | `{ path: string; onOpen?: () => void; variant?: 'inline'\|'block' }` | `file_badge_bg` (§5), `text`, `border` | Conductor inline `@RepositoryDetailsDialog.tsx` |
| `KeyboardHintChip` | `components/ui/KeyboardHintChip.tsx` | Small chip `⌘L to focus`. Renders a `<kbd>`-ish pill | `{ keys: string[]; label?: string }` | `keyboard_hint_bg` (§5), `text_muted` | Conductor composer `⌘L to focus`, `⌘I` link-issue |
| `StatusDot` | `components/ui/StatusDot.tsx` | 6px dot w/ optional pulse for running | `{ status: 'running'\|'idle'\|'success'\|'error'; pulse?: boolean }` | `status_dot_*` (§5) | Codex Recents row dot |
| `TabSubtitle` | `components/ui/TabSubtitle.tsx` | Sub-tab strip, underline-under-active | `{ items: { id: string; label: string }[]; activeId: string; onSelect: (id) => void; onAdd?: () => void }` | `primary`, `border`, `text`, `text_muted` | Conductor header `All changes | Debugging … | Review | +` |
| `BranchChip` | `components/ui/BranchChip.tsx` | `/<branch-name>` + optional `Open ▾` dropdown | `{ branch: string; dropdown?: { label: string; onClick: () => void; items?: MenuItem[] } }` | `border`, `text`, `text_muted`, `primary` | Conductor header `/kampala-v3 Open ▾` |
| `ToolCallGroup` | `components/ui/ToolCallGroup.tsx` | `> N tool calls, M messages` collapsible | `{ title: string; count: number; children: JSX.Element; defaultOpen?: boolean; trailingIcons?: JSX.Element }` | `border`, `tool_call_row_bg` (§5), `text_muted` | Conductor chat `> 13 tool calls, 7 messages` |
| `ModelSelector` | `components/ui/ModelSelector.tsx` | Pill `✦ Sonnet 4.5` w/ dropdown; shows thinking spinner | `{ current: ModelId; options: ModelOption[]; onChange: (id) => void; thinking?: boolean }` | `surface_elevated`, `primary_subtle`, `primary` | Conductor `✦ Sonnet 4.5`, Codex `Opus 4.6 ●` |
| `CommandFooter` | `components/ui/CommandFooter.tsx` | `Type / for commands` input wrapper with leading `/` glyph + trailing mic | `{ value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder?: string; trailing?: JSX.Element }` | `surface`, `border`, `text`, `text_muted` | Codex composer `Type / for commands` |

### 3.4 Agent chat

#### `components/agent/ChatTimelineRow.tsx` — **NEW**
- **Purpose.** One-line compact row used by the agent message list when the
  agent emits a tool call (write/edit/lint/etc). Replaces the big bubble
  for tool events. Click expands details; inline delta counts shown.
- **Props:**
  ```ts
  interface ChatTimelineRowProps {
    kind: ToolCall['kind'];              // Write | Edit | Lint | Typecheck | Build | ReadFile | Search | Run | Todo
    path?: string;
    deltaAdd?: number;
    deltaDel?: number;
    status: ToolCall['status'];          // running | success | error | skipped
    duration?: number;                    // ms
    onToggle?: () => void;
    expanded?: boolean;
    children?: JSX.Element;              // output body when expanded
  }
  ```
- **Tokens.** `tool_call_row_bg` (§5), `hover`, `text`, `text_muted`,
  `delta_add_fg`, `delta_del_fg`, `status_dot_*`.
- **Pattern.** Codex `Write src/components/PanelGrid.tsx +62 >`, `Lint >`,
  `Typecheck >`, `Updated todos 22 items >`.

#### `components/agent/AgentMessage.tsx` — **REDESIGN**
- **Purpose.** Replace current bubble-layout logic in `AgentChatView.tsx:302–341`.
  Supports: user bubble (dense), assistant prose (no bubble), file-badge parsing
  for `@Filename.tsx` tokens, error/warn/success tinted subtitle pills (the
  Conductor red `ReferenceError @RepositoryDetailsDialog.tsx`).
- **Props:**
  ```ts
  interface AgentMessageProps {
    message: ChatMessage;
    onOpenFile?: (path: string) => void; // called when user clicks @<badge>
    onRetryFromHere?: (messageId: string) => void;
  }
  ```
- **Tokens.** `surface`, `border`, `text`, `text_muted`, `danger_subtle`,
  `success_subtle`, `warning_subtle`, `primary_subtle`, `file_badge_bg`.

#### `components/agent/ScrollToBottomPill.tsx` — **NEW**
- **Purpose.** Floating pill shown just above the composer when the message list
  is not pinned to bottom. Click jumps to end.
- **Props:**
  ```ts
  interface ScrollToBottomPillProps {
    visible: boolean;
    unreadCount?: number;
    onClick: () => void;
  }
  ```
- **Tokens.** `surface_elevated`, `border`, `primary`.
- **Pattern.** Conductor "Scroll to bottom" floating pill.

#### `components/agent/AutoAcceptToggle.tsx` — **NEW**
- **Purpose.** Pill toggle `Auto accept edits` in the composer footer. Persists
  per session.
- **Props:**
  ```ts
  interface AutoAcceptToggleProps {
    value: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
  }
  ```
- **Tokens.** `success_subtle` (on), `muted` (off), `border`.
- **Pattern.** Codex `Auto accept edits` pill.

### 3.5 PR chrome

#### `components/pr/PRHeaderBand.tsx` — **NEW**
- **Purpose.** Green solid band atop the right rail when the active session has
  an open PR. Shows `PR #<n> ↗ <status-phrase> [Merge]`. `status-phrase` ∈
  `Ready to merge | Merge conflicts | Draft | Checks failing | Checks running`.
- **Props:**
  ```ts
  interface PRHeaderBandProps {
    pr: PullRequestInfo;
    mergeable: boolean;
    onMerge: () => void;
    onOpenExternal: () => void;
  }
  ```
- **Tokens.** `pr_ready_bg` (§5), `pr_conflict_bg` (§5), `success`, `danger`,
  `warning`, `text_inverse`.
- **Pattern.** Conductor `PR #1432 ↗ Ready to merge [Merge]`.

#### `components/pr/PRChangesPanel.tsx` — **NEW**
- **Purpose.** File list inside `ChangesCard`. Columns: path (truncated w/ `…`
  at mid-path), `DeltaCount`, small "open" icon. Includes sub-tabs
  `Changes N | All files | Review` + `Search / Filter` icons.
- **Props:**
  ```ts
  interface PRChangesPanelProps {
    files: FileDelta[];
    activeTab: 'changes' | 'all' | 'review';
    onTabChange: (t: 'changes' | 'all' | 'review') => void;
    onOpenFile: (path: string) => void;
    onFilter?: (q: string) => void;
  }
  ```
- **Tokens.** `border`, `text`, `text_muted`, `delta_add_fg`, `delta_del_fg`,
  `hover`.
- **Pattern.** Conductor right-rail file list with `src/ui/compone…RepositoryDetailsDialog.tsx +225 -117`.

### 3.6 Rail cards (all NEW under `components/rail-cards/`)

| Component | Purpose | Key props | Tokens | Pattern mirrored |
|---|---|---|---|---|
| `PreviewCard` | Embedded browser preview frame w/ fake URL bar | `{ url: string; onReload: () => void; onBack: () => void; onForward: () => void; tabLabel: string }` | `rail_card_bg`, `border`, `text_muted` | Codex `Preview ×` w/ `● acme-web ×` tab |
| `TerminalCard` | Hosts a `TerminalPane` (re-used from `components/terminal/`) inside a `RailCard` | `{ ptyId: string; onDismiss: () => void }` | `rail_card_bg`, `editor_bg`, `border` | Codex `Terminal ×` |
| `ChangesCard` | Renders `PRChangesPanel` | `{ sessionId: string; pr?: PullRequestInfo }` | (inherits) | Conductor + Codex diff card |
| `TasksCard` | Two-group task list (`Running` / `Completed`) with per-row runtime | `{ tasks: TaskEntry[]; onCancel: (id) => void }` | `rail_card_bg`, `status_dot_*`, `text_muted` | Codex `Tasks ×` |
| `PlanCard` | Checklist of agent plan items | `{ items: PlanItem[]; onToggle: (id) => void }` | `rail_card_bg`, `text`, `text_muted`, `success` | Codex `Plan ×` |
| `PRReviewCard` | Mini PR review surface (reuses `PrReviewView`) | `{ prNumber: number; repoPath: string }` | — | Conductor `Review branch changes` sub-tab |
| `LogsCard` | Wraps `InlineLogCard` (§3.7) | `{ source: LogSource }` | — | Codex log card |

### 3.7 Editor + terminal enhancements

#### `components/editor/CodeDiffBlock.tsx` — **ENHANCE** (new file, extracts from `SplitDiffView` and `AgentChatView.FileCard`)
- **Purpose.** Canonical diff block with line numbers, row bg tinting, and
  `<38 unmodified lines>` collapsible runs.
- **Props:**
  ```ts
  interface CodeDiffBlockProps {
    hunks: DiffHunk[];
    collapseUnmodifiedOver?: number; // default 6 — rows to collapse
    onExpandRun?: (hunkId: string, runId: string) => void;
    wordWrap?: boolean;
    lineNumberMode?: 'old' | 'new' | 'both';
  }
  ```
- **Tokens.** `success_subtle` (added row bg), `danger_subtle` (removed row bg),
  `editor_bg`, `editor_line_number`, `editor_line_number_active`, `border`.
- **Pattern.** Codex diff card `+85 -12 · 38 unmodified lines`.

#### `components/terminal/InlineLogCard.tsx` — **NEW**
- **Purpose.** Tabbed log viewer for rail. Tabs `all | stdout | stderr`, search
  input, colored prefix recognition.
- **Props:**
  ```ts
  interface InlineLogCardProps {
    lines: LogLine[];                // { ts, source, level, text }
    filter: 'all' | 'stdout' | 'stderr';
    onFilterChange: (f: 'all' | 'stdout' | 'stderr') => void;
    onSearch: (q: string) => void;
    onClear: () => void;
  }
  ```
- **Tokens.** `rail_card_bg`, `log_prefix_tsc` (§5), `log_prefix_vite` (§5),
  `log_prefix_generic` (§5), `text`, `text_muted`.
- **Pattern.** Codex `[tsc] ok Found 0 errors`, `[vite] (client) hmr update …`.

### 3.8 TitleBar

#### `TitleBar.tsx` (root of `frontend/src/`) — **REFACTOR**
- **Purpose.** Merge current inline implementation in `App.tsx:285–330` into a
  proper component. Add optional breadcrumb + right-side branch chip.
- **Props:**
  ```ts
  interface TitleBarProps {
    breadcrumb?: { icon?: string; label: string; onClick?: () => void };
    subtabs?: TabSubtitleProps;
    rightBranchChip?: BranchChipProps;
    onToggleTheme: () => void;
    onCycleLayout: () => void;
  }
  ```
- **Tokens.** `title_bar_bg`, `glass_*`, `text`, `text_muted`.
- **Pattern.** Conductor header row + VS Code command bar.

---

## Part 4 — Data model extensions

All types go in new file `types/session.ts` (or extend `types/workspace.ts`).
Existing stores in `store/` must migrate — deltas called out at the end.

```ts
// types/session.ts

export interface Workspace {
  id: string;
  name: string;
  repositoryIds: string[];     // was: single repoRoot
  pinnedSessionIds: string[];  // Codex "Pinned"
  recentSessionIds: string[];  // Codex "Recents", LRU
}

export interface Repository {
  id: string;
  workspaceId: string;
  path: string;                // absolute fs path (was repoRoot)
  displayName: string;
  defaultBranch: string;
  remotes: { name: string; url: string }[];
  githubOwner?: string;
  githubRepo?: string;
}

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'ready_to_merge'
  | 'merge_conflicts'
  | 'archived'
  | 'failed'
  | 'draft_pr'
  | 'pr_open'
  | 'pr_closed';

export interface Session {
  id: string;
  repositoryId: string;
  name: string;                // shown as row title; e.g. "archive-in-repo-details"
  branch: string;              // current head branch (session worktree head)
  parentBranch: string;        // "kampala-v3"
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;

  // linked data
  worktreePath: string | null; // resolved worktree on disk (existing git-agent concept)
  chatId: string;              // reference into chat store
  taskId: string | null;       // git-agent task id
  pr: PullRequestInfo | null;

  // activity
  lastDelta: { add: number; del: number };
  runtimeMs?: number;
  tokensUsed?: { input: number; output: number };

  // ui
  shortcutIndex?: number;      // 1..9 for ⌘1..⌘9
}

export interface PullRequestInfo {
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  head: string;
  base: string;
  labels: string[];
  checks: {
    status: 'pending' | 'success' | 'failure' | 'neutral';
    summary?: string;
    runs: CheckRun[];
  };
  mergeable: 'clean' | 'conflicts' | 'unknown' | 'blocked';
}

export interface CheckRun {
  id: string;
  name: string;
  conclusion: 'success' | 'failure' | 'neutral' | 'pending';
  url?: string;
}

export interface ToolCall {
  id: string;
  kind:
    | 'Write'
    | 'Edit'
    | 'Delete'
    | 'Lint'
    | 'Typecheck'
    | 'Build'
    | 'Test'
    | 'Run'
    | 'ReadFile'
    | 'Search'
    | 'Todo'
    | 'Other';
  path?: string;
  deltaAdd?: number;
  deltaDel?: number;
  status: 'running' | 'success' | 'error' | 'skipped';
  startedAt: number;
  durationMs?: number;
  output?: string;
  messageId?: string;          // ties back into chat timeline
}

export type RailCardKind =
  | 'preview'
  | 'changes'
  | 'terminal'
  | 'tasks'
  | 'plan'
  | 'prReview'
  | 'logs';

export interface RailCardState {
  kind: RailCardKind;
  collapsed: boolean;
  meta?: Record<string, unknown>;  // e.g. preview URL, terminal ptyId
}
```

### Migration deltas

| Existing shape | Change | Migration |
|---|---|---|
| `WorkspaceState.repoRoot: string \| null` (`types/workspace.ts:14`) | Split into `Workspace.repositoryIds[] -> Repository.path` | Write a v2 migrator in `App.tsx` (`loadInitialState`): old `repoRoot` becomes `Repository { path: repoRoot, workspaceId: ws.id }` and a default `Session { repositoryId, branch: defaultBranch }`. |
| `WorkspaceState.activeArea` (`WorkArea`) | Deprecated; sessions carry their own active center tab | Drop from persistence; map any legacy value into the initial center-tab. |
| `WorkspaceState.searchResults/contextItems` | Move to `Session`-scoped? No — keep on `Workspace` (cross-session research). | No migration; just reparent from `WorkspaceState` to `Workspace` shape. |
| `LayoutStoreState.centerTabsByWorkspace` (`store/layout.ts:59`) | Change key from `workspaceId` to `sessionId`. | Add `centerTabsBySession`; keep `centerTabsByWorkspace` deprecated for one release; migrate on load. |
| `LayoutStoreState` | Add `rightDeckBySession: Record<string, RailCardState[]>`. | Seed default deck per session: `['changes','terminal','plan']`. |
| `gitAgentApi.start(...).taskId` | Becomes `Session.taskId` | No format change; only wiring. |
| `git-review` APIs (`api/git-review.ts`) for PR listing/status | Feed `Session.pr.*` | Add a poller in a new `store/sessions.ts`. |

New store: `store/sessions.ts` exposing `[sessionsStore, sessionsActions]` (same
pattern as `layout.ts`). Persistence key `voidlink-sessions-v1`.

---

## Part 5 — Token extensions (beyond parity guide)

These are **new** tokens not covered in the parity guide §1.1. Values follow
the same OKLch-derived sRGB approach used by the parity guide. They must land
in `frontend/src/index.css` (default dark + `.light` block) and
`frontend/src/themes.css` (nord block) simultaneously.

| Token | Purpose | Dark (hex) | Light (hex) | Nord (hex) |
|---|---|---|---|---|
| `pr_ready_bg` | Green band fill when PR ready to merge | `#1f6f43` | `#c7f0d8` | `#4c7f5b` |
| `pr_ready_fg` | Text on `pr_ready_bg` | `#e7fcef` | `#14532d` | `#eceff4` |
| `pr_conflict_bg` | Amber band fill when conflicts | `#7a5a14` | `#fff1c2` | `#8a6d2c` |
| `pr_conflict_fg` | Text on `pr_conflict_bg` | `#fef9c3` | `#5a3a02` | `#eceff4` |
| `pr_draft_bg` | Muted band fill when draft | `#2e2e42` | `#eeeef2` | `#434c5e` |
| `pr_draft_fg` | Text on `pr_draft_bg` | `#afafc3` | `#4a4a5a` | `#d8dee9` |
| `delta_add_fg` | Monospace `+X` green | `#4ade80` | `#15803d` | `#a3be8c` |
| `delta_del_fg` | Monospace `-Y` red | `#f87171` | `#b91c1c` | `#bf616a` |
| `rail_card_bg` | Card body surface | `#1a1a2b` | `#f7f7fa` | `#3b4252` |
| `rail_card_border` | Card border | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` | `#434c5e` |
| `file_badge_bg` | Inline `@File.tsx` chip fill | `#232338` | `#eef0f6` | `#434c5e` |
| `file_badge_fg` | Inline `@File.tsx` chip text | `#d5d5e5` | `#2a3040` | `#e5e9f0` |
| `keyboard_hint_bg` | Chip fill for `⌘L to focus` | `#2d2d46` | `#ececf2` | `#4c566a` |
| `keyboard_hint_fg` | Chip text | `#afafc3` | `#4a4a5a` | `#d8dee9` |
| `tool_call_row_bg` | `ChatTimelineRow` hover/active | `#1e1e32` | `#f3f3f8` | `#3b4252` |
| `status_dot_running` | Blue 6px pulse | `#60a5fa` | `#2563eb` | `#81a1c1` |
| `status_dot_idle` | Grey | `#6a6a87` | `#9ca0aa` | `#4c566a` |
| `status_dot_success` | Green | `#22c55e` | `#15803d` | `#a3be8c` |
| `status_dot_error` | Red | `#ef4444` | `#b91c1c` | `#bf616a` |
| `log_prefix_tsc` | `[tsc]` colored prefix | `#38bdf8` | `#0369a1` | `#88c0d0` |
| `log_prefix_vite` | `[vite]` colored prefix | `#a78bfa` | `#6d28d9` | `#b48ead` |
| `log_prefix_cargo` | `[cargo]` colored prefix | `#f59e0b` | `#b45309` | `#d08770` |
| `log_prefix_generic` | Any `[name]` fallback | `#9ca0aa` | `#4a5160` | `#81a1c1` |

**Naming convention.** Snake_case in TS, kebab-case in CSS
(`--pr-ready-bg`, `--delta-add-fg`, etc.). Exposed via Tailwind theme
extension (mirroring the parity guide §1.1).

**Light-mode rule.** The "green band" in Conductor is vivid in dark mode but
must read as subtle in light mode — hence the pastel light values. QA: contrast
ratios must pass WCAG AA against `pr_ready_fg`.

---

## Part 6 — Motion additions

All transitions use tokens already defined in the parity guide §2. The new
named transitions are:

| Motion | Duration | Easing | Applied to |
|---|---|---|---|
| `row-hover-fill` | 80ms | `ease-out-expo` | `SessionRow`, `ChatTimelineRow`, file-list rows in `ChangesCard` |
| `tab-switch-fade` | 120ms | `ease-out-expo` | `TabSubtitle`, `CenterTabBar` active-tab transitions |
| `rail-card-drag-settle` | 180ms | cubic-bezier(.34,1.56,.64,1) (rubber-band overshoot) | `RailCard` dropping into the deck |
| `status-dot-pulse` | 1400ms | `ease-in-out` infinite | `StatusDot` in `running` state |
| `pr-band-color-transition` | 220ms | `ease-out-expo` | `PRHeaderBand` background when status flips |
| `scroll-to-bottom-pill-in` | 160ms | `ease-out-expo` | `ScrollToBottomPill` fade+translate |
| `session-stripe-slide` | 120ms | `ease-out-expo` | The 2px active left-stripe on `SessionRow` |

Implementation:
```css
@keyframes status-dot-pulse {
  0%, 100% { transform: scale(1);   opacity: 0.9; }
  50%      { transform: scale(1.25); opacity: 1;   }
}
```

---

## Part 7 — DX improvements per tool

For every area, 3–5 concrete wins beyond aesthetics.

### Agent chat
1. **Tool-call grouping.** Collapse consecutive tool calls into
   `ToolCallGroup` (`> 13 tool calls, 7 messages`). Expand on click. Maps from
   the existing `AgentEvent` stream (`types/git.ts`).
2. **"Retry from here."** Right-click on an assistant message → `Retry from
   here`. Re-runs the agent with chat history truncated to that point.
3. **Token-budget meter.** Composer-footer pill shows
   `↓ 37.1k / 200k tokens` using context window for the current model. Turns
   amber at 80%, red at 95%. Data from `Session.tokensUsed`.
4. **Inline file-badge parsing.** Assistant messages containing `@path/to/file`
   render a `FileBadge` that opens the file in a new center tab (`openFile`).
5. **Scroll-to-bottom pill.** `ScrollToBottomPill` with unread message count.

### Editor
1. **Gutter diagnostics.** Reconnect LSP (after Rust refactor): red/yellow
   squiggles + gutter icons. (Depends on backend re-wiring — see §9.)
2. **Quick-action lightbulb.** Same as VS Code — show in gutter when LSP has
   `code_actions`.
3. **`⌘click` split.** Hold `⌘` (or `Ctrl`) + click a gutter location → open
   same file in the opposite editor pane.
4. **Minimap toggle.** Reuse CodeMirror's scroll-gutter with a custom renderer.
5. **Collapsible unmodified runs** in diff view (`CodeDiffBlock`).

### Terminal
1. **Inline filter tabs** (`all | stdout | stderr`) via `InlineLogCard`.
2. **Search.** Integrate xterm `search` addon; `⌘F` focuses search input.
3. **Copy last command.** Shell-integration addon already emits marker events;
   add a `Copy last command` button that reads from the last prompt marker.
4. **ANSI hyperlink detection.** xterm `web-links` addon + a custom matcher for
   `file://` and `vscode://`-style URIs (opens via our `openFile`).
5. **Rail-mountable.** Terminal becomes a `TerminalCard` in the right rail, so
   the user can keep a log and an agent chat side-by-side.

### Git
1. **PR-state chrome.** `PRHeaderBand` + `SessionStatusChip` across rail +
   sidebar.
2. **Delta counts on every row** (`DeltaCount` everywhere: sessions, files,
   branches, commits).
3. **Draft-PR preview.** If `Session.pr.draft`, band is muted + shows `Draft`
   and a `Mark ready` button that calls `gitReviewApi.markReady`.
4. **Session merge button** in `MergeButton` component uses the same backend
   but reads `Session.pr.mergeable` to enable/disable.
5. **One-click conflict resolver.** When `Session.pr.mergeable === 'conflicts'`
   the band exposes `Resolve in editor` → opens the conflicting files in a
   dedicated `diff` tab per file.

### Workspace
1. **Pin / unpin sessions.** Right-click a `SessionRow` → `Pin`. Pinned
   sessions appear under a `Pinned` header (Codex).
2. **`⌘1..9` jump.** Assign `shortcutIndex` on first 9 sessions. Show chip.
3. **`⌘P` session palette.** New command palette (new `components/ui/CommandPalette.tsx`)
   searches sessions, repos, files, commands. Existing file-open could fold in.
4. **Archive.** `status: 'archived'` removes the row from Recents but keeps the
   worktree and PR data.
5. **Drag to reorder repositories** inside a workspace.

### Prompt Studio / Workflow
1. **Reuse `ChatTimelineRow`** for workflow step rendering: step `1. Write
   plan.md`, `2. Edit src/…`, etc.
2. **Reuse `ToolCallGroup`** to collapse runs.
3. **Reuse `StatusDot`** per step.
4. **Inline PR preview.** If a workflow ends in a PR, show a `PRHeaderBand`
   at the top of the workflow output.
5. **Export as agent seed.** `Save workflow as session template` →
   pre-populates a new `Session`.

---

## Part 8 — Phased implementation plan

**Rule of thumb.** Tokens + primitives first (no breakage). Then shell
restructure behind a feature flag. Feature upgrades after shell is stable.
Data-model migration last — it's the riskiest.

### FE-A · Token & primitive pass
**Scope.** Add §5 tokens to `index.css`, `.light` block, `themes.css` (Nord).
Ship new primitives: `DeltaCount`, `FileBadge`, `KeyboardHintChip`, `StatusDot`,
`TabSubtitle`, `BranchChip`, `ToolCallGroup`, `ModelSelector`, `CommandFooter`.
Add unit snapshots.
**Deps.** None.
**Verification.** Storybook-style `/ui/_preview` route (or the existing
`ui-variants` skill) renders all primitives in both themes. Existing app does
not regress (primitives are opt-in).
**Effort.** 3 eng-days.
**Risks.** Token bloat; mitigate by adding the names in a single commit with
the CSS + TS exposure.

### FE-B · TitleBar refactor + `BranchChip` wiring
**Scope.** Extract inline title bar from `App.tsx` into `TitleBar.tsx` root;
add breadcrumb + sub-tabs slot + right branch chip. Remove duplicate
`components/TitleBar.tsx`.
**Deps.** FE-A primitives.
**Verification.** Manual: open a session, see `⌥ <session>` in header and
`/branch Open ▾` on the right.
**Effort.** 1.5 eng-days.
**Risks.** Tauri drag region regressions; keep `data-tauri-drag-region` on
the breadcrumb area.

### FE-C · RailCardDeck + empty card shells
**Scope.** Build `RailCardDeck`, `RailCard`, and shells for all seven cards
(`PreviewCard`, `ChangesCard`, `TerminalCard`, `TasksCard`, `PlanCard`,
`PRReviewCard`, `LogsCard`) — each card renders placeholder content.
Feature-flag behind `VITE_VOIDLINK_RAIL_DECK=1`; when flag off, the current
`RightSidebar` is used.
**Deps.** FE-A.
**Verification.** With flag on, can drag cards, dismiss, and re-add from a
`+` popover. Persists order.
**Effort.** 3 eng-days.
**Risks.** Drag order persistence — see §9.

### FE-D · Agent chat redesign
**Scope.** Break `AgentChatView.tsx` into:
`AgentMessage`, `ChatTimelineRow`, `ToolCallGroup` (UI reuse),
`ScrollToBottomPill`, `AutoAcceptToggle`, `ModelSelector`, `CommandFooter`.
Add token-budget meter. Wire file-badge parsing.
**Deps.** FE-A, FE-C (for rail cards that render agent telemetry).
**Verification.** Existing agent runs keep working. Tool calls collapse into
groups. `@file` badges open files.
**Effort.** 4 eng-days.
**Risks.** Event-stream merging logic is subtle; keep `seenEventIds` dedup
behavior.

### FE-E · Sessions data model + WorkspaceGroup sidebar
**Scope.** New `types/session.ts` + `store/sessions.ts`. Migrator in
`App.tsx`. New `WorkspaceGroup` + `SessionRow` + `SessionStatusChip` +
`AddRepositoryButton`. `LeftSidebar` becomes `LeftRail` using these.
**Deps.** FE-A, FE-B, FE-D.
**Verification.** Existing `repoRoot`-only users land on a single session per
repo; data preserved.
**Effort.** 5 eng-days.
**Risks.** Data-model break — see §9.

### FE-F · PR chrome end-to-end
**Scope.** `PRHeaderBand`, `PRChangesPanel`, `ChangesCard` → real data.
Wire `git-review` API. Add poller in `store/sessions.ts`. Hook merge button.
**Deps.** FE-E.
**Verification.** Open a session with an upstream PR — band renders correct
status; merge button works.
**Effort.** 3 eng-days.
**Risks.** GitHub API rate limits; auth edge cases.

### FE-G · Editor / terminal DX + status bar
**Scope.** `CodeDiffBlock`, `InlineLogCard`, gutter diagnostics (pending LSP
re-wire), VS-Code-style `StatusBar` segments, command palette `⌘P`.
**Deps.** FE-A, FE-C.
**Verification.** Diff view collapses unmodified runs. Terminal supports
stderr-only filter. Status bar shows branch / sync / problems.
**Effort.** 4 eng-days.
**Risks.** LSP backend churn (per git status, `src-tauri/src/lsp/*.rs` is
deleted pending refactor).

**Total estimated effort.** 23.5 eng-days for one engineer; ~2.5 weeks at a
realistic pace with review + QA.

### Feature-flag strategy
Single env var `VITE_VOIDLINK_NEW_SHELL` gates FE-C, FE-E, FE-F, FE-G.
Default ON in `dev`, OFF in initial staged release. Remove after FE-G ships.

---

## Part 9 — Risks & open questions

### R1 · Workspace × Sessions data-model break
`WorkspaceState.repoRoot` is persisted in `localStorage` under
`voidlink-repo-workspaces` (see `App.tsx:34–74`) and in the `layout` store
under `voidlink-layout-v2`. A forward-only migration is needed. **Open:** do
we keep a fallback to read the legacy single-repo shape for one release, or
ship a one-shot migrator with a "Reset workspaces" safety button in Settings?

### R2 · PR chrome depends on GitHub wiring
`src-tauri/src/git_review/*.rs` is **deleted** in current git status alongside
`git_agent` and `github` modules, pending a Rust-side refactor. `PRHeaderBand`
and `ChangesCard` need that API restored (or stubbed). **Open:** does the new
`voidlink-core` crate (untracked) already expose a PR API? If not, FE-F
should land with a stubbed adapter behind an interface and block on the Rust
side.

### R3 · Rail-card drag persistence
Persisting drag order means `store/layout.ts` grows a
`rightDeckBySession` map. With the existing debounced persistence, rapid drag
could cause writes to stall. **Open:** should we keep deck state on
`sessions` store instead (scoped per session) vs. `layout` (scoped per
workspace)? Recommendation: `sessions` store — matches the Codex pattern
where a pinned Preview card travels with the task, not the workspace.

### R4 · Tauri window chrome on macOS
Current inline title bar (`App.tsx:285–330`) reserves no traffic-light padding
on macOS and the standalone `components/TitleBar.tsx` has `pl-20` but is not
used. **Open:** confirm macOS traffic lights render via
`tauri.conf.json` `titleBarStyle` and then land a platform-aware
`TitleBar` (Linux/Windows show custom controls; macOS hides them and reserves
80px left padding).

### R5 · Bottom pane vs. rail cards
If Terminal/Logs/Agent live as rail cards, the existing bottom pane is
half-redundant. **Open:** keep the bottom pane for *workspace-global* things
(problems, search results) and move *session-scoped* things to rail? That's
a clean split and matches VS Code (problems/output at bottom, source control /
preview on the side).

### R6 · TipTap vs. CodeMirror
`components/editor/Editor.tsx` (TipTap) appears unused in the Tauri shell
after the CodeMirror migration (commit `5b4a48b`). **Open:** is TipTap
retained for the Pages / docs concept (`PageSidebar`, `NestedPageNode`)? If
yes, document the two-editor split explicitly; if no, delete.

### R7 · Performance of the agent timeline
Collapsing 13 tool calls into a single `ToolCallGroup` is fine, but agent
sessions with 1000+ events (lint/typecheck) will still balloon. **Open:** do
we virtualize the chat list? Recommend: start with flat render; virtualize if
profile shows >50ms render per append.

### R8 · Theme coverage for Nord
Nord is the only named theme actively supplied in `themes.css` besides
default dark/light. Parity guide §5 mentions GitHub Dark/Light, Monokai, etc.
**Open:** do new §5 tokens need values for those themes at ship time? Propose
shipping dark/light/nord now and auto-deriving other themes with sensible
defaults, then filling in post-FE-G.

---

## Part 10 — Visual parity checklist

You can say the upgrade matches when **all** of the following are true on a
fresh install, with both a seeded `conductor` workspace (for Conductor
parity) and an `acme-web` workspace (for Codex parity).

### Left rail (Conductor parity)
- [ ] Workspace dropdown shows repo groups collapsible, each with a
      repo-name header and a branch/session list below.
- [ ] Each `SessionRow` renders two lines: name + `DeltaCount +X -Y` on
      line 1, parent-branch + `SessionStatusChip` + `KeyboardHintChip` on
      line 2 — matches Conductor row
      `⌥ archive-in-repo-details   +312 -332 / kampala-v3 · Ready to merge   ⌘1`.
- [ ] Active row shows a 2px left stripe in `primary` and subtle fill in
      `hover`.
- [ ] Status tints: green subtitle for `ready_to_merge`, amber for
      `merge_conflicts`, muted for `archived`, grey pulse dot for `running`.
- [ ] Footer row shows `+ Add repository`, archive icon, chat icon, settings
      icon as ghost buttons.

### Left rail (Codex parity)
- [ ] `Pinned` section header above `Recents`.
- [ ] Recents rows show a leading `StatusDot` when running.
- [ ] Footer shows workspace identity (`🏠 <workspace-name>`) + theme toggle.

### Header (Conductor parity)
- [ ] Breadcrumb `⌥ <session-name>` left-aligned under window chrome.
- [ ] `TabSubtitle` strip renders `All changes | Debugging … | Review | +`
      with underline-under-active.
- [ ] `BranchChip` `/kampala-v3  Open ▾` right-aligned in header.

### Agent chat (Conductor + Codex parity)
- [ ] Error messages render as subtle red pill with an inline `FileBadge`
      (Conductor `ReferenceError @RepositoryDetailsDialog.tsx`).
- [ ] Tool-call runs collapse into `ToolCallGroup` `> N tool calls, M
      messages`.
- [ ] Tool events render as `ChatTimelineRow` with `kind`, path, delta,
      duration — matches Codex
      `Write src/components/PanelGrid.tsx +62 >` and `Lint >`.
- [ ] User messages use `surface_elevated` fill bubble; assistant text is
      bubble-less prose.
- [ ] `ScrollToBottomPill` appears when not pinned to bottom.
- [ ] Composer has trailing `KeyboardHintChip` `⌘L to focus`.
- [ ] Composer footer row shows `ModelSelector` + `@ Link issue` +
      `AutoAcceptToggle` + paperclip + send.

### Right rail (Codex parity)
- [ ] `RailCardDeck` renders 3–6 `RailCard`s; each has `×` dismiss + drag
      handle.
- [ ] Dismissing a card and re-adding from `+` restores content.
- [ ] Card order persists across reloads.
- [ ] `PreviewCard` shows a fake browser chrome (`← → ↻ localhost:5173/`)
      and a tab row with a close `×`.
- [ ] `TerminalCard` embeds a working `TerminalPane`.
- [ ] `ChangesCard` shows `Changes N | All files | Review` sub-tabs with
      search + filter icons; rows show truncated paths with `DeltaCount`
      right-aligned.
- [ ] `TasksCard` groups `Running` + `Completed`; runtime per row (`1m 12s`).
- [ ] `PlanCard` is a checklist; `☐` / `☑` toggle.

### PR chrome (Conductor parity)
- [ ] `PRHeaderBand` renders solid green when ready (`pr_ready_bg`),
      amber on conflicts, muted on draft, red on failing checks.
- [ ] Band shows `PR #<n> ↗ <status-phrase> [Merge]`.
- [ ] Merge button is disabled when `mergeable !== 'clean'`.

### Editor / terminal / status bar
- [ ] `CodeDiffBlock` collapses unmodified runs as `38 unmodified lines`
      with expand affordance.
- [ ] `InlineLogCard` colors `[tsc]` and `[vite]` prefixes distinctly.
- [ ] Status bar shows branch, sync indicator, problems count, line/col,
      encoding, language.

### Motion
- [ ] Row hover animates `background-color` over 80ms.
- [ ] PR band cross-fades over 220ms when status changes.
- [ ] Status dot pulses at 1.4s cadence when running.
- [ ] Drag of a rail card settles with 180ms rubber-band.

### Themes
- [ ] All §5 tokens resolve in dark, light, and nord.
- [ ] No color is hard-coded in component code (grep for `#` in
      `components/` returns only icon SVG fill attrs).

---

*End of plan. Extends `docs/egui-ui-parity-guide.md`. Does not replace it.*
