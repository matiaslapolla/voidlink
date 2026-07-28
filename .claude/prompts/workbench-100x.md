<context>
VoidLink is a local-first Tauri 2 + Solid.js git workbench (repo root = cwd; `frontend/`, `src-tauri/`). Its editor and git-config surfaces already have their own 100x prompts (`.claude/prompts/editor-100x.md`, `.claude/prompts/git-config-settings.md`). This one covers the third and largest surface: the **workbench shell** — the frame everything else is mounted inside.

The shell works, but it stopped growing. `frontend/src/store/layout.ts` is 2049 lines holding ten parallel `Record<worktreeId, T[]>` tab collections, six ad-hoc localStorage keys and every UI pref, all in one `createAppStore()`; `docs/features/README.md:62` admits "The workspace and tab model itself — worth its own page; not written yet." `MainSurface` renders exactly one pane at a time. Sidebar widths live in component-local signals (`WorkspaceRail.tsx` `createSignal(212)`, `TerminalSidebar.tsx` `createSignal(256)`) and are lost on every reload. Tab navigation is `tab.next` / `tab.prev` in document order — no MRU, no jump-to-N, no back/forward. Snapshots capture five tab kinds out of ten. Nothing in the tab strip tells you a background terminal rang a bell or a task finished.

Goal: make the workbench a first-class module — a shell that can hold multiple panes, remembers everything, navigates by keyboard, and shows what is happening in tabs you are not looking at. The store rewrite comes first because every other wave needs somewhere to put its state.
</context>

<task>
Rebuild the workbench shell across six waves, in this order. Each wave lands and is verifiable on its own; do not start a wave before the previous one typechecks, lints, and its tests pass.

**Wave 0 — Design foundation (small, first).**
Waves 2–4 ship visible surfaces — splitters, group headers, an MRU overlay, two quick switchers, a snapshot manager. Retrofitting the design system in Wave 5 means building them twice. Land the substrate first:
- **Motion and status tokens.** Add the `--ease-*` and `--dur-*` tokens from `frontend/design-system/MASTER.md` §7.2 to `index.css`. Shared with `.claude/prompts/editor-100x.md` Wave 0 — whichever prompt lands first adds them; the second reuses and does not redefine.
- **`<StatusLed>`** in `frontend/src/components/layout/`, extracted from the existing terminal LED, implementing the §7.5.3 signal vocabulary (signal, precedence, reserved slot). Wave 5's tab activity and the editor prompt's LSP indicator both consume it. Same shared-ownership rule.
- **`<Splitter>`** — pulled forward from Wave 2 because `WorkspaceRail`, `TerminalSidebar` and the git sidebar all need it before groups exist. Spec in `<design>` below.
- **Density audit.** `index.css` already exposes `.density-row` / `.density-section` / `.density-gap` driven by `data-density` (MASTER §5). Wave 5's "density preference" is therefore a *surfacing* task, not a new system. In this wave, confirm the three classes cover rail, tab strip, sidebars and status bar, and add the missing coverage. Do not build a second density mechanism.
No behavior change beyond the panel-width persistence that `<Splitter>` brings.

**Wave 1 — Decompose the layout store (riskiest; first).**
Split `frontend/src/store/layout.ts` into a `frontend/src/store/layout/` directory while keeping `createAppStore()`'s public surface (the `as const` object returned at l.2026 and `AppStore`) byte-for-byte compatible, so no consumer changes in this wave:
- `tabs.ts` — a tab registry: one `TabKindSpec` per kind (`file | terminal | diff | compare | stack | conflict | history | preview | brain | browser`) declaring its storage key, serializer/deserializer, closed-tab snapshot shape, equality function and label. The ten `*ByWorktree` Records become one `Record<TabKind, Record<worktreeId, Tab[]>>` behind accessors; the ten `activeX()` memos on the store surface stay, now derived from the registry. Adding a tab kind must cost one spec entry, not eleven edits.
- `persistence.ts` — every `localStorage` read/write in one module: `GIT_PREFS_KEY`, `COMPARE_TABS_KEY`, `STACK_TABS_KEY`, `PINNED_TABS_KEY`, `BROWSER_TABS_KEY`, `EDITOR_TABS_KEY`, `WORKSPACES_KEY`, `ACTIVE_WS_KEY`, plus the new keys later waves add. One debounced write path, one `try/catch` policy, one place a quota error is handled. No other module touches `localStorage`.
- `prefs.ts` — the global UI prefs (`gitSidebarCollapsed`, `leftSidebarCollapsed`, `sidebarsSwapped`, `diffMode`, `gitTab`, `ignoreWhitespace`, `sidebarTab`, `gitSections`, `sidebarSections`) and the panel geometry Wave 2 adds.
- `workspaces.ts` — workspace/worktree CRUD, selection, reorder, rename.
- `index.ts` — `createAppStore()` composing the above, re-exporting every type `layout.ts` exports today (`DiffMode`, `GitTab`, `SidebarTab`, `ActiveItem`, `DiffTab`, `OpenFileTab`, `CompareTab`, `StackTab`, `ConflictTab`, `HistoryTab`, `PreviewTab`, `BrainTab`, `BrowserTab`, `ClosedTab`, `CompareTreeMode`, `PersistedEditorTabs`, `serializeEditorTabs`, `parseEditorTabs`, `samePath`, `AppStore`) so `@/store/layout` keeps resolving for all ~40 importers.
Bump `LAYOUT_VERSION` to 2 in `frontend/src/store/migrate.ts` and add the v1→v2 step as a pure `StorageSnapshot → StorageSnapshot` transform in the same style as v0→v1: consolidate the scattered tab blobs into the registry's storage shape, carry unknown keys through untouched, stay idempotent. A user with today's saved state must reload into exactly the same open tabs, pins, active tab and sidebar state.

**Wave 2 — Layout power.**
- **Pane groups.** Extend `MainSurface` to hold 1–4 tab groups in a splittable tree (horizontal/vertical splits, recursive), each group owning its own tab list and active tab, all reading through the Wave 1 registry. One group is the default and must be pixel-identical to today. Splits, their orientation and their flex ratios persist per worktree.
- **The group header**, defined here rather than assumed in Wave 5. With one group there is no header — today's workbench is unchanged. With two or more, each group's tab strip gains a leading focus indicator (a 2px `--primary` rule on the focused group's strip; `--border` on the others) and a trailing slot reserved for the group's aggregate activity mark (§7.5.3 escalation, populated in Wave 5). The focused group must be identifiable without moving the mouse — this is what makes keyboard navigation between groups usable at all.
- **Drag tabs between groups**, and drag a tab onto a group's edge to split into it. `TabStrip.tsx` already owns drag-reorder within a kind; extend it with a group-id-aware drop target rather than forking a second strip. This prompt owns TabStrip's structure and drag model; `.claude/prompts/editor-100x.md` Wave 4 owns only per-tab *content* (dirty dot, activity mark, close affordance) via `TabDescriptor` props.
- **Persisted, resizable panels.** Move `WorkspaceRail`'s width, `TerminalSidebar`'s width and the git sidebar's width out of component-local signals into `prefs.ts`, persisted and restored, using the Wave 0 `<Splitter>`.
- **Focus modes.** `ui.maximize-pane` (toggle the active group to fill `main`) and `ui.zen` (hide rail, both sidebars and the tab strip; status bar stays), both restoring the exact prior geometry on exit. Both registered as actions with keymap entries.
- The embedded browser paints above the DOM (see `docs/features/browser.md`) — a browser tab in a non-visible group, a maximized sibling, or zen mode must explicitly hide its webview, not merely be covered.

**Wave 3 — Navigation and keyboard.**
- **Tab MRU.** Per-group most-recently-used order; `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle it with a held-modifier overlay listing candidates, committing on release. Keep `tab.next` / `tab.prev` as document-order navigation.
- **Jump to tab N** — `tab.select.1` … `tab.select.9` in the active group, generated like `workspaceSelectId` in `frontend/src/commands/actionIds.ts`, plus `tab.select.last`.
- **Back/forward** across a navigation history of (group, tab, and for editor targets the line) — `ui.navigate-back` / `ui.navigate-forward`, with buttons in the title bar. The history is per worktree and lives in the Wave 1 store.
- **Palette upgrades** in `frontend/src/commands/CommandPalette.tsx`: recently-used actions first, a `>`-free default mode that mixes actions with open tabs and recent files, fuzzy-highlighted match ranges, and per-action keybinding hints resolved from `keymap.ts`.
- **Quick switchers**: `Cmd+Shift+P`-style worktree/workspace switcher listing every worktree across every workspace with its dirty/ahead/behind badges, and a "go to open tab" switcher. Both reuse the `FileFinder.tsx` overlay chrome and its fuzzy matcher rather than a third overlay implementation.
- Every new binding goes through `commands/keymap.ts` + `actionIds.ts`; no component registers key handling of its own.

**Wave 4 — State durability.**
- **Session restore, complete.** Every tab kind in the registry restores on boot for every worktree — including terminals (recreate the session with its cwd and label, mark it as a fresh PTY, never pretend scrollback survived) and browser tabs (last URL). Add per-kind `restore()` to the Wave 1 `TabKindSpec`.
- **Snapshots, complete.** `commands/snapshots.ts`'s `WorkspaceSnapshot` covers five kinds; extend it to all ten plus pane geometry, with a versioned snapshot format and a migration for existing saved snapshots. Snapshot save/restore/delete/rename gets a real management UI instead of only palette entries.
- **Reopen-closed for every kind**, not the four in today's `ClosedTab` union, driven by the registry's closed-tab shape. Raise the history limit and persist it across reloads.
- **Crash-safe persistence.** Writes go through Wave 1's single debounced path with a write-to-temp-key-then-commit sequence, and a corrupt or partially-written blob degrades to defaults for that one key with a toast — never a white screen. A `--reset-layout` style escape hatch in Settings that clears layout state without touching settings or AI keys.

**Wave 5 — Presence and polish.**
- **Tab activity.** Per-tab badges driven by the registry: terminal bell / process exited / long-running command, dirty, browser loading, compare/stack refreshing. Background groups surface their activity on the group header so a badge is never invisible.
- **Status bar segments API.** Turn `StatusBar.tsx` from a hardcoded row into a registry of segments (id, priority, render, click action) that features contribute to, with overflow collapsing on narrow windows. Port the existing branch / ahead-behind / AI-draft / stack chips onto it.
- **Git sidebar UX.** Keep every existing behavior; improve the surface: section reorder + per-section collapse persisted through `prefs.ts`, a filter box in `ChangesPane`, keyboard navigation through the change list with stage/unstage/discard on the focused row, sticky section headers, virtualized lists where the row count is unbounded (`@tanstack/solid-virtual` is already a dependency), and consistent empty states across `ChangesPane` / `BranchesPane` / `WorktreesPane` / `StashesPane` / `TagsPane`.
- **Shell polish.** Real empty states for a workspace with no worktrees, a worktree with no tabs and a group with no tabs; a density preference (comfortable/compact) applied to rail, tab strip, sidebars and status bar; consistent focus rings and transitions per `frontend/design-system/MASTER.md`.
- Write `docs/features/workspaces-and-tabs.md` covering the workspace → worktree → group → tab model, and link it from `docs/features/README.md` (replacing the "not written yet" note at l.62). Update `docs/features/keyboard-shortcuts.md` and `docs/features/snapshots.md` for the new bindings and snapshot format.
</task>

<reuse>
- `frontend/src/store/layout.ts` (2049 lines) — read it fully before touching it. `AppStoreState` at l.127; the ten `*ByWorktree` Records at l.135–151; `GIT_PREFS_KEY` + `loadGitPrefs()` at l.171–230; the tab-blob keys at l.232–240; `loadPinnedTabs`/`loadStackTabs`/`loadBrowserTabs`/`loadEditorTabs`/`loadCompareTabs`/`loadWorkspaces` at l.273–531; `createAppStore()` at l.544; the returned surface at l.2026. This is the file being decomposed, not rewritten from scratch — behavior must be preserved line for line.
- `frontend/src/store/migrate.ts` + `migrate.test.ts` — `LAYOUT_VERSION`, `LAYOUT_VERSION_KEY`, `StorageSnapshot`, `KeyValueStore`, `MIGRATION_INPUT_KEYS`, and the pure-function/idempotency discipline the v0→v1 step already documents. The v1→v2 step follows the same contract and extends the same test file.
- `frontend/src/store/layout.test.ts` — the existing store test harness; extend it rather than starting a parallel one.
- `frontend/src/components/layout/TabStrip.tsx` (705 lines) — `TabDescriptor`, the `TabKind` union, pin/close/close-others, overflow chevron popover, HTML5 drag-reorder. Its header comment explains why it takes no store (the editor window renders a broadcast snapshot). Group-aware drops must keep that property: the strip still takes descriptors, not a store.
- `frontend/src/components/layout/MainSurface.tsx` (650 lines) — the workbench's pane host and `NewTabMenu` / `TabContextMenu` / new-terminal / new-compare paths. Groups extend this component; do not build a second surface.
- `frontend/src/components/layout/AppShell.tsx` — the `titleBar` / `rail` / `sidebar` / `main` / `rightSidebar` / `statusBar` slot frame and its `fill` prop (stacked mode nests the workbench). Zen and maximize work within these slots.
- `frontend/src/components/layout/WorkspaceRail.tsx` (421 lines) — `MIN_WIDTH`/`MAX_WIDTH`, the local `width` signal, drag-reorder, double-click rename, worktree badges from `hydrateWorktrees`. `TerminalSidebar.tsx` has the same local-width + `startResize` pattern. Both become `<Splitter>` + `prefs.ts` consumers.
- `frontend/src/components/layout/StatusBar.tsx` — the current chips and its `voidlink:refresh-git` window-event subscription; the segment registry must keep that refetch cadence.
- `frontend/src/components/git/GitSidebar.tsx` — `Section` (l.92), `IconBtn` (l.74), `ChangesPane` (l.496), `BranchesPane` (l.1090), `WorktreesPane` (l.1354), `TagsPane` (l.1511), `StashesPane` (l.1618). Wave 5 improves these in place; the git engine calls behind them are untouched.
- `frontend/src/commands/registry.ts` (`Action`, `registerActions`), `commands/keymap.ts`, `commands/actionIds.ts` (`ACTION_IDS`, `workspaceSelectId`, `WORKSPACE_SELECT_COUNT`), `commands/keys.ts`, `commands/keymap.test.ts` — the single source of truth for actions and bindings, with a test that already asserts every binding points at a declared action. Dynamic ids stay out of `ACTION_IDS`, as its header comment specifies.
- `frontend/src/commands/CommandPalette.tsx`, `FileFinder.tsx`, `commands/overlay.ts` — the overlay stacking contract and the existing fuzzy matcher. Quick switchers reuse these.
- `frontend/src/commands/snapshots.ts` — `WorkspaceSnapshot` and its content-key (`"kind:identifier"`) addressing scheme, which is what makes a restore survive changed tab ids. Extend the scheme; do not switch to id-based capture.
- `frontend/src/api/windows.ts` — `EditorTabsSnapshot`, `publishEditorTabs`, `onEditorTabs`, `EditorRequest`, `openEditorTab`, `publishWindowContext`, `bridgeGitRefsAcrossWindows`. The workbench owns the editor window's four tab collections; pane groups, MRU and session restore must not break that broadcast contract or the two independent active-item pointers (`activeItemByWorktree` vs `editorActiveItemByWorktree`, l.152–159).
- `frontend/src/commands/environment.ts` + `components/layout/ViewSwitcher.tsx` — `isStackedMode()`, `STACKED_VIEWS`, `stackedView`. Every geometry change must behave in stacked mode, where the workbench is one view among three inside a single window.
- `frontend/src/components/browser/BrowserPane.tsx` + `docs/features/browser.md` — the child-webview compositing constraint that dictates explicit hide/show.
- `@tanstack/solid-virtual` — already a dependency, already the pattern for long lists.
- `frontend/design-system/MASTER.md` — the visual conventions every new surface follows.
- `.claude/prompts/editor-100x.md` and `.claude/prompts/git-config-settings.md` — the sibling prompts. Their surfaces are out of scope here; read them only to avoid colliding with their planned changes to `TabStrip.tsx` and `SettingsDialog.tsx`.
</reuse>

<design>
Read `frontend/design-system/MASTER.md` §7 (motion), §7.5 (liveness & presence), §7.6 (interaction states), §10 (accessibility), §11.5 (brand) before Wave 0. This module *is* the "alive and proactive" surface — §7.5.3's escalation rule and §7.5.5's interruption levels are its core requirement, not polish.

**Motion budget: almost everything here is keyboard-initiated, so almost nothing animates.** Per MASTER §7.1: tab switch, jump-to-tab-N, MRU cycle, back/forward, palette open, switcher open, zen toggle, maximize toggle — all `0ms`. Concretely:
- **The MRU overlay does not animate in or out.** It is held-modifier UI shown and dismissed dozens of times a session; a 150ms fade makes `Ctrl+Tab` feel broken. It appears on the same frame as the first `Tab` and disappears on modifier release. Selection movement within it is instant.
- **Zen and maximize do not animate the geometry change.** Panels are removed, not slid away. What *does* need to be instant and obvious is the exit path — see below.
- **Splits do not animate on creation.** The new group is there.
- The only motion in this module: the splitter's own 1:1 pointer tracking (§7.3.10), the context-menu/popover enter at `--dur-short` from its trigger origin, and functional pulses on genuinely in-flight regions.

**`<Splitter>` spec.** The most-touched new control in the plan, and unspecified in the original draft.
- Visual width 1px using `--border`; **hit area ≥8px** via a transparent `::before` overlay — visual size never changes on hover (§7.6 no-layout-shift).
- Hover: the 1px rule takes `--primary` at `--dur-tint`. Gate behind `@media (hover: hover)`.
- Drag: 1:1 pointer tracking with `setPointerCapture`, respecting the grab offset; the pane follows every frame; `cursor: col-resize` / `row-resize` held for the duration of the drag, not just on hover. Reversible mid-drag.
- Boundaries: clamp at min/max, and do not hard-stop the pointer — the handle stops, the pointer keeps tracking, so releasing outside the range settles at the clamp rather than jumping.
- Keyboard: focusable, `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, arrow keys step 8px, `Shift+arrow` steps 32px, `Home`/`End` go to min/max.
- Double-click resets to the default width. Announce it — the `title` says so.
- Nine states per §7.6, including a disabled state for a splitter whose pane is collapsed.

**Drop targets for tab drag.** The edge-split affordance *is* the interaction; without a visible target it is undiscoverable.
- Dragging a tab over a group's tab strip: an insertion caret, 2px `--primary`, between the two tabs it would land between. No row highlight.
- Dragging over a group's *body*: the group tints `bg-primary/10` with a 1px `--primary` inset border — "drop here, same group".
- Dragging into a group's outer 20% edge zone: the prospective split region fills with `bg-primary/15` at the exact geometry the new group would occupy, so the user sees the resulting layout before committing. This is the whole point; a generic "highlighted edge" is not enough.
- At the four-group cap, edge zones stop responding and take `cursor: no-drop`. The reason appears in the drag ghost, not a toast.
- All of this is `opacity`/`background` only — never animate the layout preview's geometry.

**Tab activity — the proactive core (Wave 5).** Implement MASTER §7.5.3 exactly; the one-sentence brief in the original draft is not a spec.
- The signal set and their tokens are fixed by §7.5.3: dirty, running, finished-while-away, failed, bell, stale. Do not add a seventh.
- **Precedence when one tab carries several**: failed > running > bell > finished > dirty. One mark, the highest.
- **Escalation is mandatory** (§7.5.3 rule 1): a signal on a tab in a non-active group escalates to that group's Wave 2 header slot; a signal in a group that is hidden entirely (zen, maximized sibling) escalates to the status bar. A user must never have to open a pane to learn something happened in it. This is the single most load-bearing requirement in Wave 5 — test it explicitly.
- **The mark's slot is reserved at rest** so its arrival causes no reflow, and it replaces the close affordance rather than sitting beside it.
- Under `prefers-reduced-motion`, *running* must still be distinguishable from *finished* without the pulse — differ in fill as well as motion (§7.5.3 rule 4).
- Terminal bell, process exit and long-running-command detection are three different signals, not one; map them to bell, finished/failed (by exit code) and running respectively.

**Zen and maximize need an exit path that is visible without motion.** A user who enters zen by accident and has lost the rail, both sidebars and the tab strip must be able to get out. Keep a single persistent affordance in the status bar (which stays) naming the mode and its keybinding — `Zen · ⌘K Z`. Restoring geometry exactly on exit is already required; make the *return* instant, not animated, since the same user will toggle it repeatedly.

**Empty states — "consistent" defined.** All of them use the MASTER §9.7 shape: a Lucide icon at `w-5 h-5`, one line naming *why* it is empty, and the action that fixes it rendered as a real accelerator, not prose. The distinguishing requirement is that **no two empty states share an icon or a sentence** — a user must be able to tell "no worktrees in this workspace" from "no tabs in this group" from "no changes" from "no stashes" at a glance. Enumerate them and check for collisions:
`workspace with no worktrees` · `worktree with no tabs` · `group with no tabs` · `ChangesPane clean` · `BranchesPane` (cannot be empty — omit) · `WorktreesPane single` · `StashesPane` · `TagsPane` · `no search results in the changes filter` (distinct from "clean") · `snapshot manager with no snapshots`.

**Status bar segment registry (Wave 5).** Priority is a number, and overflow collapses lowest-priority-first into a `⋯` popover — never truncate a segment's text to unreadability, never wrap the bar to two lines. Every segment: `text-[10px]`, one optional LED, click action, `aria-label`. Segments that carry a §7.5.3 signal jump to the front of the priority order while the signal is live, and return to their resting priority when it clears — the escalation target must never itself be the thing that overflows.

**Git sidebar (Wave 5) — the freshness contract applies.** Ahead/behind counts, dirty counts and branch state are the numbers most likely to go stale. Each renders live / refreshing / stale per MASTER §7.5.4, and the existing `voidlink:refresh-git` cadence determines which. A stale ahead/behind count shown as if it were live is the exact failure §7.5.4 exists to prevent. Virtualized lists keep the same row height in both density modes so `@tanstack/solid-virtual`'s estimates stay correct.

**Command palette and switchers.** Fuzzy match ranges highlight with `bg-primary/15` on the matched characters — one highlight treatment, reused across palette, file finder and both switchers. Keybinding hints render right-aligned in `text-[10px] text-muted-foreground` mono. Recently-used ordering must be stable within a session so muscle memory works; do not reorder while the palette is open.

**Nine states, everywhere** (§7.6), including the new splitter, group header, drop target, MRU overlay row and every snapshot-manager control. Every icon-only button gets `aria-label`. Every new list gets keyboard navigation, not just click. Ambient signals need an `aria-live="polite"` region (§10.10) — a badge that only exists visually is not proactive for a screen-reader user.
</design>

<constraints>
- Solid.js 1.9 — `createSignal` / `createStore` + `produce` / `createMemo` / `createEffect(on(…))` / `<For>` / `<Index>` / `<Show>` / `onMount` / `onCleanup`; props are getters. Not React.
- TypeScript 5.9 strict, Vite 7, Tailwind 4 (`@tailwindcss/vite`), lucide-solid icons, Vitest 4. Tauri `=2.11.2` with `unstable`.
- Query context7 before using any API you are not already reading in this repo — in particular `@tanstack/solid-virtual` for virtualized lists and the Tauri webview APIs for browser-tab visibility. Do not write either from memory.
- This is frontend-only. If a wave seems to need a new Rust command, say so and stop rather than adding one — the workbench shell is a rendering and state problem.
- Separation of concerns: persisted state lives in `store/layout/`; components read it through `useAppStore()` and never touch `localStorage`; key handling lives only in `commands/keymap.ts`; presentation components own no persistence. `TabStrip` stays store-free.
- Wave 1 must not change any consumer outside `frontend/src/store/`. If a consumer change is unavoidable, it belongs to the wave that needs it, not to the decomposition — a decomposition with behavior changes in it is untestable.
- Persisted-state compatibility is non-negotiable: a user on today's build must reload into their exact open tabs, pins, active tab and sidebar state. Prove it with a migration test over a realistic v1 storage snapshot, not by inspection.
- Nothing may regress in stacked mode or in the standalone Editor / Git windows. The cross-window broadcast in `api/windows.ts` is a contract, not an implementation detail.
- Build exactly these five waves. Make routine judgment calls yourself; check in only where two readings would produce materially different work. If a premise here looks wrong, say so in one sentence and continue as specified rather than quietly widening or narrowing it.
</constraints>

<assumptions>
- Pane groups cap at four, in a recursive split tree. A free-form grid is a later question; four covers terminal-beside-graph-beside-browser.
- Pane geometry, MRU order and navigation history are per worktree, persisted in localStorage alongside the existing layout state — not per window, and not synced across windows.
- Terminal session restore recreates a fresh PTY with the saved cwd and label. Scrollback is not restored and the UI must not imply it was.
- The default single-group layout stays the default; a user who never splits sees today's workbench with better persistence.
- Density defaults to comfortable (today's spacing).
</assumptions>

<out_of_scope>
- The editor module — Monaco options, LSP, find-in-files, editor split panes, editor settings. `.claude/prompts/editor-100x.md` owns all of it.
- Git config reading or writing, and the Settings → Git pane. `.claude/prompts/git-config-settings.md` owns it.
- Any new Rust command or change under `src-tauri/`.
- New git functionality of any kind — Wave 5 restyles and re-navigates the git sidebar; it adds no git operations.
- The AI commit box, the agent panel, and the brain vault surface.
- The terminal emulator itself — PTY spawning, xterm addons, deep links. Terminal *tabs* are in scope; the pane's internals are not.
- Detaching a pane group into its own OS window.
- Multi-window layout sync, or a fourth window kind.
- Cloud or file-based sync of layout state; localStorage remains the only store.
- Theming and palette work — `docs/features/themes.md` is untouched.
- A plugin or extension API for tab kinds; the registry is internal.
</out_of_scope>

<acceptance>
- After each wave: `cd frontend && npx tsc --noEmit` clean, `cd frontend && npx eslint .` clean.
- Run only the touched suites: `cd frontend && npx vitest run src/store src/commands src/components/layout`.
- **Wave 1** — extend `src/store/migrate.test.ts` with a v1→v2 case over a realistic snapshot (all six tab blobs populated, pins set, an active item per worktree) asserting the post-migration store hydrates to identical open tabs, pins and active items; assert idempotency (running twice equals running once) and that unrelated localStorage keys survive untouched. Add a `store/layout/tabs.test.ts` proving the registry round-trips every one of the ten kinds through serialize → deserialize → equality. `layout.test.ts` must pass unmodified — that is the decomposition's proof.
- **Wave 2** — tests for the split-tree reducer (split, close last tab in a group collapses it, move tab between groups, ratios normalize, four-group cap) and for the geometry serializer; manual: split three ways, drag a tab between groups, resize each panel, reload, confirm identical geometry; open a browser tab in a background group and confirm its webview is hidden.
- **Wave 3** — tests for the MRU list (activation reorders, close removes, cycling with a held modifier commits on release) and the navigation history (back/forward across groups, no duplicate consecutive entries, bounded length); `keymap.test.ts` passes with every new binding declared in `ACTION_IDS`.
- **Wave 4** — tests for session restore per kind (each `TabKindSpec.restore()` from a serialized payload), the snapshot format migration from the current shape, reopen-closed for all ten kinds, and the corrupt-blob path (malformed JSON in one key degrades that key to defaults and leaves the rest intact).
- **Wave 5** — tests for status-bar segment ordering and overflow collapsing, and for the changes-list filter + keyboard-navigation reducer; manual visual check against `frontend/design-system/MASTER.md` in both density modes and both themes.
- Manual at the end, in stacked mode and in detached windows: split panes, cycle tabs by MRU, jump to tab 3, navigate back, save and restore a snapshot containing every tab kind, reload and confirm the full session returns.
- Design acceptance, checked against `frontend/design-system/MASTER.md`:
  - Grep the diff for `transition` on any keyboard-initiated path — MRU overlay, zen/maximize, split creation, switcher mount, tab activation. Every hit is a bug (MASTER §7.1).
  - **Escalation test (the load-bearing one):** open a terminal tab in group B, focus group A, run `sleep 3 && exit 1` in B. The failed LED must be visible from group A on B's header without opening B. Repeat with B maximized away and confirm it escalates to the status bar. Repeat in zen mode. A signal that is only visible inside the pane it happened in is a Wave 5 failure.
  - Precedence: give one tab a dirty buffer *and* a failed process; exactly one mark renders, and it is the failure.
  - `prefers-reduced-motion: reduce`: running and finished remain distinguishable; the MRU overlay and switchers lose nothing.
  - Splitter: resize each of the three panels by keyboard only (`Tab` to the separator, arrows, `Shift+arrow`, `Home`/`End`), double-click to reset, and drag past the clamp and release — the pane settles at the bound with no jump.
  - Drag a tab into a group's edge zone and confirm the *resulting split geometry* is previewed before release, not a generic edge glow. Do it at the four-group cap and confirm the edge zones refuse with `no-drop` and a stated reason.
  - Enter zen with no mouse, then exit it with no mouse using only what is visible on screen.
  - Screenshot every empty state listed in `<design>` side by side; no two share an icon or a sentence.
  - Narrow the window until the status bar overflows: segments collapse lowest-priority-first into `⋯`, no text truncates to unreadability, and a segment carrying a live signal never collapses.
  - Both density modes × `solarized-light` and `monokai`: focus rings, group-focus rules and every LED still meet 3:1, and virtualized row heights stay correct.
</acceptance>
