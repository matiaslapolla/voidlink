# Stream G — reset less, and move Compare where it belongs

Branch: `fix/layout-reset-and-compare`, cut from `feat/five-sidebars`. Merge third.

```text
<context>
Two small, unrelated corrections.

**1. Reset layout is too broad.** Settings → UI → "Reset layout" calls
`resetLayoutStorage()`, the escape hatch for a pane tree with a group nobody can
reach or a panel width dragged to zero. Its own help text promises it "clears
the pane tree and panel sizes only — settings, themes, provider keys and saved
snapshots all survive it." In practice it also takes the user's workspaces and
their open tabs, which is not a layout reset, it is starting over. The button's
copy is the correct specification; the implementation should match it.

**2. Compare branches is in the wrong place.** It sits pinned in the git
sidebar's footer, and its own code comment already concedes the point: "Compare
is a destination rather than a view of repo state." Everything else in that
sidebar is a live view of the repository; Compare opens a tab. It belongs in the
`+` new-tab menu with the other things that open tabs.
</context>

<task>
1. Scope `resetLayoutStorage()` to what its help text claims: pane trees, panel
   widths, collapse states, dock arrangement, tab-strip orientation. Workspaces,
   worktrees, open tabs and the tab registry survive it. Update the help text if
   your scope ends up differing from it — the two must agree when you are done.

2. Remove the pinned "Compare branches" footer button from the git sidebar and
   add Compare as a row in the `+` new-tab menu, opening the same tab through
   the same action.

3. Leave the *upstream* compare where it is. `openUpstreamCompare` is a
   different affordance on a different object (the current branch's relationship
   to its upstream, with a real disabled reason when there is no upstream), and
   it belongs next to the branch it is about.
</task>

<reuse>
- `frontend/src/store/layout/persistence.ts` — `resetLayoutStorage()` (line 379)
  and `STORAGE_KEYS`. The fix is which keys it clears; the key table is right
  there and is the thing to reason from.
- `frontend/src/components/settings/SettingsDialog.tsx` — the reset button and
  its two-step confirm (~line 515), and the help copy at ~line 2323 that states
  the contract.
- `frontend/src/components/git/GitSidebar.tsx` — the pinned footer (~lines
  743–755) with `actions.openCompareTab(props.worktreeId)`, and
  `openUpstreamCompare` (~line 490) which stays. Note that Stream A adds
  horizontal insets to this file's section rows; you are branched from it, so
  build on that rather than reverting toward `main`.
- `frontend/src/store/layout/index.ts` — `openCompareTab`. The menu row calls
  the same action the footer button did; do not write a second path.
- The `+` new-tab menu — find it in `frontend/src/components/layout/TabStrip.tsx`
  and match how its existing rows are declared, including their icons and
  accelerators.
- `frontend/src/commands/registry.ts` / `commands/actionIds.ts` — if Compare has
  a registered action, the menu row runs it; if it does not, register one so the
  row and the palette agree.
- `frontend/src/store/layout/durability.test.ts` — the persistence invariants.
  The reset scope belongs in this file's family of tests.
</reuse>

<constraints>
- Reset must stay a real escape hatch: after it, a corrupt pane tree, a
  zero-width panel or an unreachable dock arrangement is gone. Narrowing the
  scope must not narrow it to the point of no longer fixing the thing it exists
  for. State in a comment which keys it clears and why each one is layout.
- Persistence repairs, never rejects. A blob written before this change still
  hydrates.
- Follow `frontend/design-system/MASTER.md` §7.6: the `+` menu row states what
  it does; a disabled variant states why.
- No raw colour literals in `src/components/**` (`tokenHygiene.test.ts`).
- Solid, not React.
- Build exactly this stream. Two small fixes, not a refactor of either file —
  `GitSidebar.tsx` is ~4000 lines and is not yours to reorganise. If you notice
  unrelated dead code, mention it; do not delete it.
</constraints>

<assumptions>
- "Layout" for reset purposes means: pane layouts per worktree, focused group,
  panel widths, sidebar collapse flags, dock side/order/detached, tab
  orientation and vertical tab width. Everything else — workspaces, worktrees,
  tabs of every kind, the MRU, nav history, pins, snapshots, tab groups —
  survives. If a key is genuinely ambiguous, keep it and say so in the comment.
- The Compare row goes in the `+` menu near the other tab-opening destinations
  (Mission Control, Timeline, Board), not at the top with new file / new
  terminal.
</assumptions>

<out_of_scope>
- Any other change to the git sidebar's sections, ordering or contents.
- Changing what the compare tab itself does or looks like.
- A per-section reset, or an undo for reset.
- Touching the pane tree model (Stream C) or the sidebar dock model (Stream A)
  beyond reading them.
- Snapshots.
</out_of_scope>

<acceptance>
- With three workspaces, a dozen open tabs and a two-way split: Reset layout
  flattens the split and restores default widths, and every workspace and every
  tab is still there afterwards. Unit test in the `durability.test.ts` family
  that fails on today's `main`.
- The settings help text and the actual behaviour agree, checked against each
  other in the test's assertion message or a comment.
- "Compare branches" is gone from the git sidebar footer and present in the `+`
  menu, opening the same tab.
- The upstream-compare button is untouched, including its disabled reason when
  the branch has no upstream.
- `npm run test`, `npx tsc --noEmit`, `npx eslint .` clean; `npm run build`
  succeeds.
</acceptance>
```
