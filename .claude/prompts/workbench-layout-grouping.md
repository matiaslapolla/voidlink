<context>
VoidLink is a Tauri 2 + SolidJS desktop development workbench. Its main surface already
renders a recursive split tree of 1–4 pane groups per worktree, persisted, with
cross-group tab drag. That covers "put two things side by side" and nothing else:
there is exactly one way to organise tabs (which pane claims them), no way to name or
recall an arrangement, and a hard cap of four.

A developer running several agents across several worktrees needs more organisational
axes than "which rectangle is it in" — a labelled set of tabs that moves and collapses
as a unit, a saved arrangement recallable by name, and enough rectangles to hold a
review layout. This slice adds those axes without disturbing the invariant that makes
the current default work.

<task>
Add four grouping capabilities to the workbench, in four waves. Land each wave
complete — model, render, persistence, tests — before starting the next.

**Wave 1 — the tab-group model (riskiest, do first).**
A `TabGroup` is a named, coloured, orderable set of tab ids inside one pane group:
`{ id, label, color, collapsed, tabIds }`. Add it as a pure, DOM-free reducer in a new
`frontend/src/store/layout/tabGroups.ts` alongside `panes.ts` — create, rename,
recolour, collapse/expand, add/remove a tab, reorder groups within a strip, move a
whole group to another pane group, dissolve.

The load-bearing constraint is the interaction with `panes.ts`'s claim model: an empty
`tabIds` on the *first* `PaneGroup` means "every tab nobody else claimed"
(`resolveGroupTabs`, `panes.ts:104`), which is what makes the unsplit default identical
to today's workbench. Tab groups are a **second, orthogonal axis**: they order and
label tabs *within* whatever set a pane group resolved to. A tab in no tab-group renders
exactly as it does now. Moving a tab-group across pane groups must go through
`moveTabToGroup` for each member rather than writing `PaneGroup.tabIds` directly, so the
two models cannot disagree about who claims what.

Persist per worktree through the existing debounced path in
`store/layout/persistence.ts` under a new key, seeded and dropped from
`store/layout/state.ts` like every other per-worktree collection, and added to the
corrupt-blob quarantine list. Bump `LAYOUT_VERSION` in `store/migrate.ts` only if a
stored shape actually changes; a purely additive key does not need a step.

**Wave 2 — tab groups in the strip.**
Render groups in `components/layout/TabStrip.tsx`: a group header chip carrying the
colour dot, the label (double-click to rename inline), a disclosure triangle, and the
member count when collapsed. A collapsed group occupies one chip; its members are not
rendered. Extend the existing module-level drag payload so a tab can be dragged into or
out of a group and a whole group chip can be dragged to another pane group's strip —
do not add a second drag mechanism beside it. Signals from a collapsed group's members
must surface on the group chip via `store/activity.ts`'s `escalate()`, which is the
same rule that already carries a hidden pane's signal to the status bar: a collapsed
group must never be a place where activity goes to die.

**Wave 3 — named layout presets.**
A layout preset captures the pane tree, the tab-group structure, per-group active tabs
and the three panel widths — an arrangement, *not* the tabs' contents. This is a
different thing from `commands/snapshots.ts`, which restores a whole session; a preset
applies to whatever is currently open. Store presets per workspace, apply them to the
active worktree, and expose create/apply/rename/delete as palette actions registered in
`commands/registry.ts` with ids in `commands/actionIds.ts`. Applying a preset whose
groups reference tabs that are not open must degrade — place what exists, leave the
rest of the geometry empty with the existing empty state — never fail.

**Wave 4 — raise the cap and auto-grouping.**
Raise `MAX_GROUPS` (`panes.ts:47`) to 8. The reducer is already recursive, so the work
is in the render and the constraints: verify `MIN_RATIO` still yields a usable strip at
eight groups (and raise the floor if it does not), that `splitGroup` refusal messaging
still reads correctly, and that `components/layout/paneDrop.ts`'s edge zones stay
hittable in a narrower group. Then add auto-grouping: a per-worktree mode
(`off | kind | worktree`) that derives tab groups from `TAB_SPECS` kind
(`store/layout/tabs.ts:335`) or originating worktree instead of from manual assignment.
Derived groups are read-only — renaming or hand-editing one switches the worktree back
to `off` with the derivation materialised as manual groups, so the user is never
fighting a rule that keeps undoing them.

Update `docs/features/workspaces-and-tabs.md` — it documents the four-level container
model, the 1–4 cap and the drag/drop rules, all of which this changes — and
`docs/features/keyboard-shortcuts.md` for any new chord.
</task>

<reuse>
- `frontend/src/store/layout/panes.ts` — the split-tree reducer. `resolveGroupTabs`,
  `moveTabToGroup`, `splitGroup`, `pruneClosedTabs`, `serializePaneLayout` /
  `parsePaneLayout`, `MAX_GROUPS`, `MIN_RATIO`, `normalizeRatios`. Extend; do not fork.
- `frontend/src/store/layout/panes.test.ts` — 31 tests establishing the reducer's
  contract and the test idiom to follow for `tabGroups.test.ts`.
- `frontend/src/store/layout/persistence.ts` — the single guarded localStorage
  accessor, the debounced write path flushed on `pagehide`, the quarantine policy.
  Every new key goes through it.
- `frontend/src/store/layout/state.ts` — registry-driven seed/drop for per-worktree
  collections.
- `frontend/src/store/layout/tabs.ts` — `TAB_SPECS`, `TabKind`, `TAB_KINDS`. The
  source of kind metadata for Wave 4; do not hardcode a kind list.
- `frontend/src/components/layout/TabStrip.tsx` — the existing strip, its
  module-level drag payload, insertion caret and drop targets.
- `frontend/src/components/layout/paneDrop.ts` + `paneDrop.test.ts` — drop-zone
  geometry, already pure and tested.
- `frontend/src/components/layout/MainSurface.tsx` — draws the tree as strips plus
  measuring boxes, with panes in a flat absolutely-positioned layer above. **Keep that
  two-layer split**: rendering a pane inside its group remounts it, which costs a
  terminal its scrollback and a browser tab its child webview.
- `frontend/src/store/activity.ts` — `escalate()`, the pure "where must this signal
  appear" decision. Collapsed groups are a new hiding place; teach it, don't bypass it.
- `frontend/src/components/layout/Splitter.tsx` — the one resizable-seam primitive.
- `frontend/src/components/layout/emptyStates.ts` + `EmptyState.tsx` — the registry
  with a test asserting no two states share an icon or sentence. New empty states go
  here and keep that property true.
- `frontend/src/commands/registry.ts`, `actionIds.ts`, `keymap.ts` — palette actions
  and the single-source keymap. Accelerator labels are derived; never hand-type one.
- `frontend/src/commands/snapshots.ts` — the versioned session format. Read it to see
  what presets must *not* duplicate.
- `frontend/design-system/MASTER.md` — §7.1 (no animation on keyboard-initiated
  transitions), §7.5.3 (activity is never invisible; a signal's arrival costs no
  layout), §7.6 (no affordance that does nothing).
</reuse>

<constraints>
- Pure reducers first: every model change lands in a DOM-free module with tests before
  any component renders it. That is how `panes.ts` was built and why its edge cases are
  checkable without a shell.
- Separation of concerns: reducers hold no Solid primitives, components hold no
  persistence, `persistence.ts` is the only module that touches localStorage.
- Reuse before invent — grep before adding a util, a drag mechanism, a fuzzy scorer or
  an overlay. `commands/QuickPick.tsx` and `commands/fuzzy.ts` already exist.
- Before calling any Monaco, xterm, Tauri or `@tanstack/solid-virtual` API, query
  context7 (`resolve-library-id` → `query-docs`). Pinned: `solid-js` ^1.9.7,
  `@tauri-apps/api` ^2.10.1, `@tanstack/solid-virtual` ^3.13.32, TypeScript ~5.9.3
  under `erasableSyntaxOnly` — no constructor parameter properties, no enums.
- Verify with `npm run build` (which runs `tsc -b`) from `frontend/`. Plain
  `npx tsc --noEmit` at the frontend root compiles nothing: the root tsconfig is
  `"files": []` plus project references. That vacuous check hid eleven real errors once
  already.
- Persisted-state compatibility is non-negotiable: a blob written by the current build
  must still load. New fields are additive with defaults; a shape change needs a step in
  `store/migrate.ts`'s ordered `STEPS` list plus a migration test.
- Build exactly these four waves. Make routine calls yourself; check in only where two
  readings would mean materially different work. If a premise here looks wrong, say so
  in one sentence and continue as asked rather than quietly widening or narrowing scope.
</constraints>

<assumptions>
- Tab groups live inside a pane group, not across panes — a group whose members are
  split across two panes has no coherent strip to render in.
- Presets are per workspace and applied to the active worktree; they carry no tab
  contents, so applying one is cheap and non-destructive.
- Eight is the new cap. It is a number, not a principle — if the render makes eight
  unusable, land six and say why.
- Group colours come from existing design tokens, not a new palette.
</assumptions>

<out_of_scope>
- A free-form grid or drag-anywhere canvas. The tree stays a tree.
- Syncing layouts across machines or windows. Geometry is per worktree, local.
- Detaching a pane group into its own OS window.
- Changing the workspace or worktree models in `store/layout/workspaces.ts`.
- Editor-window split groups (`components/editor/editorGroups.ts`) — a separate model
  in a separate window; leave it alone.
- Any change to `commands/snapshots.ts`'s format or `SNAPSHOT_VERSION`.
- Reworking the status bar segment registry.
- Touching the git sidebar, the editor module or the settings dialog.
</out_of_scope>

<acceptance>
- `frontend/src/store/layout/tabGroups.test.ts` covers: create/rename/recolour/dissolve;
  add and remove a tab; reorder groups; move a whole group between pane groups; a tab in
  no group is unaffected; closing the last member removes the group; a group referencing
  a closed tab id renders no ghost; serialize → JSON → parse round-trips; a malformed
  blob parses to null rather than half-applying.
- `panes.test.ts` extended for eight groups: split to the cap, refusal at the cap,
  ratios normalise, `MIN_RATIO` respected, collapse on removal.
- A preset test: apply to a worktree missing half the referenced tabs → places what
  exists, geometry intact, no throw.
- An `activity.test.ts` case: a signal on a tab inside a collapsed group escalates to
  the group chip; the same tab in a hidden pane group still escalates to the status bar.
- `emptyStates.test.ts` still passes — no two states share an icon or sentence.
- `store/migrate.test.ts` passes; if a step was added, a v_N→v_N+1 case over a realistic
  blob asserts identical hydration plus idempotency.
- `npm run build` and `npx eslint .` clean from `frontend/`; `npm test` green (run the
  whole frontend suite — it is fast and the store is shared surface).
- Launch the app and confirm by hand: create a group, collapse it, drag it to a second
  pane, save and apply a preset, split to eight. Say explicitly in the summary whether
  this was done — several prior waves shipped verified statically only.
</acceptance>
