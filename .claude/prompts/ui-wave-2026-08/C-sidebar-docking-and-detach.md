# Stream C — Sidebars as dockable, detachable panels

```text
<context>
VoidLink's shell has three sidebars — the workspace rail, the files/terminals sidebar,
and the git sidebar — and exactly one knob for arranging them: a global
`sidebarsSwapped` boolean that flips left and right wholesale. That knob is why the
vertical-tabs layout had to stack the file explorer *on top of* the git panel in a
single right column: there was no way to say "this panel goes on that edge".

This stream replaces the boolean with a per-sidebar dock side, which makes three of the
user's asks fall out of one model:
  • files and git become two independent sidebars in vertical-tabs mode, not one stacked
    column;
  • each sidebar can be dragged to either edge;
  • the workspace rail becomes collapsible like the other two, with its own icon rail.

Then, on top of that model: a docked sidebar can be *detached* into its own OS window.
The app already runs three windows off one bundle with a label-based root and an event
bridge, so a detached panel is a fourth root, not a new architecture.

This is the largest diff in the wave. It lands after Streams A and B.
</context>

<task>
1. **Per-sidebar dock side.** Replace `sidebarsSwapped: boolean` with a persisted
   `dockSide: Record<SidebarId, "left" | "right">` where
   `SidebarId = "workspaces" | "files" | "git"`. Migrate existing persisted blobs:
   `sidebarsSwapped: true` maps to the arrangement it produced today, `false` to the
   default. `AppShell` grows from fixed `rail`/`sidebar`/`rightSidebar` slots to a left
   stack and a right stack, each holding zero or more sidebars in a persisted order,
   with the existing island geometry (`--island-inset`, `--island-gap`, `.island-slot`
   collapse-when-empty) preserved exactly.

2. **Vertical tabs: files and git are two sidebars.** Delete the stacked right column in
   `App.tsx` (`rightPane()`'s `<div class="flex flex-col …">` wrapper). In vertical-tab
   mode the file explorer is a normal docked sidebar on its own edge with its own width
   and its own `Splitter`, exactly as in horizontal mode. `Mod+B` keeps meaning "show or
   hide the file explorer" in both orientations.

3. **Drag a sidebar to an edge.** Each sidebar gets a drag affordance (its header /
   title row) that starts a drag through the existing `dragDrop.ts` machinery, with
   left-edge and right-edge drop zones and a preview of where it will land. Dropping
   sets that sidebar's `dockSide`. Reordering within an edge is in scope if two sidebars
   share it.

4. **Collapsible workspace rail.** Give the rail the same collapse idiom the other two
   sidebars have: collapses to a `SIDEBAR_RAIL_WIDTH` icon rail (not to nothing), with a
   header icon that toggles it and a way back from the collapsed rail itself. Add the
   matching title-bar toggle and a registered action so it has a keybinding like its
   siblings.

5. **Detach to its own window.** A docked sidebar can be detached into a Tauri child
   window (menu item on its header + a registered action). A detached sidebar renders
   nothing in the shell and its slot collapses; re-docking (closing the window, or a
   "dock back" action) restores it to the edge and width it had. Persist which sidebars
   are detached so a relaunch reopens them.
   Note: the git sidebar already has a full standalone window (`GitApp`, label `git`).
   Decide whether "detach git" reuses that window or opens a panel-scoped one, state the
   choice in a comment, and do not end up with two ways to have the git panel in a
   window.
</task>

<reuse>
- `frontend/src/components/layout/AppShell.tsx` — the whole file is the island-geometry
  contract; read its header before changing the slots. Geometry lives here, not in the
  panels; islands have no border; an empty slot must not leave a gap.
- `frontend/src/store/layout/prefs.ts` — `UiPrefs`, `PanelWidths`, `PanelId`,
  `PANEL_BOUNDS`, `SIDEBAR_RAIL_WIDTH`, `DEFAULT_PREFS`, `sidebarsSwapped`,
  `collapsedWorkspaces`, and the partial-blob parse. `parseGitSectionOrder` is the
  reference for repair-don't-reject migration of a persisted array.
- `frontend/src/store/layout/index.ts` — `toggleSidebarsSwapped`, `toggleLeftSidebar`,
  `toggleGitSidebar`, `setPanelWidth`, and the debounced persistence behind them.
- `frontend/src/store/layout/state.ts`, `frontend/src/store/LayoutContext.ts`
  (`useAppStore`).
- `frontend/src/App.tsx` (~L1240-1345) — `verticalTabs()`, `leftPane()`, `gitPane()`,
  `rightPane()`, and the `<AppShell>` call. The long comment above `verticalTabs()`
  explains why the stacked column exists; update it to say why it no longer does.
- `frontend/src/components/layout/dragDrop.ts` — `beginDrag`, `registerDropZone`,
  `activeDrag`, `insertionIndex`, `Point`. `WorkspaceRail.tsx` and `TabStrip.tsx` are
  the two existing callers; follow their idiom. `frontend/src/components/layout/paneDrop.ts`
  is the reference for edge-proximity hit-testing and drop previews.
- `frontend/src/components/layout/WorkspaceRail.tsx` — rows, `toggleWorkspaceCollapsed`,
  the trailing `Splitter`.
- `frontend/src/components/layout/TerminalSidebar.tsx`,
  `frontend/src/components/git/GitSidebar.tsx` + `GitSidebarCollapsed` (the collapsed
  icon-rail idiom to copy for the workspace rail),
  `frontend/src/components/files/FileTree.tsx`, and `FilesRail` (the editor window's
  collapsed rail).
- `frontend/src/api/windows.ts` — `WindowContext`, `currentWindowLabel`,
  `GIT_WINDOW_LABEL`/`EDITOR_WINDOW_LABEL`/`MAIN_WINDOW_LABEL`, `openGitWindow`,
  `closeGitWindow`, `isGitWindowOpen`, `focusMainWindow`, `emitQuietly`/`listenLoudly`
  and the request/response event pairs (`onWorktreeWizardRequest`,
  `onOpenWorktreeRequest`). A detached panel is a new label + a new event pair here.
- `frontend/src/main.tsx` — one bundle, label-decides-root. A detached panel mounts a
  root here alongside `App`/`GitApp`/`EditorApp`.
- `frontend/src/commands/registry.ts` + `frontend/src/commands/keymap.ts` — every new
  toggle must be a registered action so the palette, the chord and the button are one
  code path (see `NavButton` in `TitleBar.tsx` for the pattern).
- `frontend/src/components/layout/TitleBar.tsx` — `PanelLeft`/`PanelRight` toggles and
  the `ArrowLeftRight` swap button, which this change makes obsolete or repurposes.
- Existing coverage: `store/layout/prefs.test.ts`, `store/layout/durability.test.ts`,
  `store/migrate.test.ts`, `components/layout/paneDrop.test.ts`.
</reuse>

<constraints>
- **The shell tree must not remount on a dock change.** `App.tsx` documents why the
  workbench body is rendered exactly once: the terminals hanging off it own live PTYs
  that do not come back. Moving a sidebar from one edge to the other must move the
  element, not recreate the subtree — and must not remount `MainSurface`.
- One migration, idempotent, in the existing repair-don't-reject style. A blob from an
  older build hydrates into the new shape; a blob from a newer build with an unknown
  sidebar id is dropped, not thrown on.
- Query context7 for the Tauri v2 window/webview APIs before writing any
  `WebviewWindow` / event code (`resolve-library-id` → `query-docs`). The existing
  `api/windows.ts` idioms — quiet emit, loud listen, label-based routing — are the
  pattern to extend; do not invent a second cross-window channel.
- Separation of concerns: dock state and its persistence live in `store/layout/`;
  `AppShell` composes geometry; sidebar components render content and know nothing about
  which edge they are on beyond a prop.
- Follow MASTER §7.1 (a keyboard-initiated geometry change is instant — a collapse
  animates because it carries information, a dock change triggered by a chord does not),
  §7.3.10 (a dragged thing tracks the pointer 1:1), §7.6, §10. Semantic tokens only;
  `tokenHygiene.test.ts` enforces it.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked rather than quietly widening or narrowing it.
</constraints>

<assumptions>
- "Detachable" means a real Tauri child window (the user's choice), not an in-window
  floating overlay. No floating-panel mode.
- Top/bottom docking is not in scope — left and right edges only.
- The editor window's file-tree column gets the same detach affordance only if it falls
  out for free; its width/split work belongs to Stream B.
</assumptions>

<out_of_scope>
- Docking to the top or bottom edge.
- Floating in-window panel overlays.
- Any new colour token, contrast change or restyling (Stream D).
- Terminal changes of any kind (Stream F).
- Privacy blur or background images (Stream E).
- New resize handles beyond the ones a moved sidebar needs to keep working
  (Stream B owns the resize gaps).
- Changing what any sidebar *contains*.
</out_of_scope>

<acceptance>
- With `ui.tabOrientation: "vertical"`, the file explorer and the git panel are two
  separate docked sidebars with independent widths and independent collapse state.
  Neither is nested inside the other's column.
- Dragging any of the three sidebars to the opposite edge docks it there, with a drop
  preview during the drag; the arrangement survives a reload and, in stacked mode, a
  switch away and back.
- A dock change does not kill a running terminal: open a terminal, run a long-lived
  process, move a sidebar across, confirm the process is still attached and the buffer
  intact. Assert the no-remount property in a test where you can, and state in the PR
  description how you verified it in the app.
- The workspace rail collapses to a `SIDEBAR_RAIL_WIDTH` icon rail with a visible way
  back, has a title-bar toggle and a registered action with a keybinding, and its
  collapsed state persists.
- Detaching a sidebar opens a window containing it and collapses its shell slot;
  closing that window re-docks it at its previous edge and width; detached state
  survives a relaunch.
- `store/migrate.test.ts` (or `prefs.test.ts`) covers: a blob with `sidebarsSwapped:true`
  migrates to the equivalent `dockSide` map; a blob with `false` migrates to the default;
  a blob already in the new shape is left alone (idempotent); an unknown sidebar id is
  dropped without throwing.
- A drop-target test covers left-edge vs right-edge resolution, mirroring
  `paneDrop.test.ts`.
- `cd frontend && npm run test` green; `npm run test:browser` green;
  `npx tsc --noEmit` clean; `cd src-tauri && cargo check` clean.
</acceptance>
```
</content>
