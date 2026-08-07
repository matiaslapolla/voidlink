# Stream B — Close the pane-resize gaps

```text
<context>
VoidLink has exactly one resize handle component — `Splitter` — with pointer capture,
keyboard resize, double-click reset and a documented disabled state. The workbench's
pane split tree and the three shell sidebars use it. Three places still do not, and
they are the three the user actually hits: the stacked disclosures in the left sidebar,
and the editor window's file-tree column and its editor-group split.

The fix is not "add resizing" — it is "route the remaining hardcoded extents through the
control that already exists", so every resizable edge in the app behaves identically and
persists identically.
</context>

<task>
Make these resizable with `Splitter`, with widths/heights persisted alongside the
existing panel widths:

1. **TerminalSidebar stacked sections** — the Files / Terminals / Agents disclosures
   currently divide the sidebar's height implicitly. Give each adjacent open pair a
   horizontal (`axis="y"`) handle so the user can decide how much height each gets.
   A collapsed section has nothing to resize: render its handle disabled with a reason
   (MASTER §7.6), do not omit it.
2. **Editor window file-tree column** — `EditorApp`'s `<aside>` is pinned at `15rem`
   with a width transition. Replace the constant with a persisted, splitter-driven width,
   keeping the collapse-to-`SIDEBAR_RAIL_WIDTH` behaviour and its transition. Suppress
   the transition during a pointer drag via `Splitter`'s `onDragStateChange` — the same
   reason the workbench sidebars do.
3. **Editor group split fraction** — `EditorApp`'s `splitFraction` should be persisted
   rather than reset per session, and its handle should be `Splitter` if
   `EditorGroupsView` is still using a hand-rolled one.

Every new bound goes in the same table as the existing ones, not inline in a component.
</task>

<reuse>
- `frontend/src/components/layout/Splitter.tsx` — `Splitter`, and read its header before
  writing anything: it documents the five properties (hit area, 1:1 tracking, clamping
  from total delta, keyboard resize, double-click reset) a new caller must not lose.
  `islandGapPx()` / `forgetIslandGap()` if a handle sits in a canvas gap.
- `frontend/src/store/layout/prefs.ts` — `PanelWidths`, `PanelId`, `PANEL_BOUNDS`,
  `SIDEBAR_RAIL_WIDTH`, `UiPrefs`, `DEFAULT_PREFS`, and the partial-blob parse at the
  bottom of the file. New extents go here, in `PANEL_BOUNDS`-shaped entries, so the
  clamp the splitter applies and the clamp hydration applies are the same one.
- `frontend/src/store/layout/persistence.ts` — `STORAGE_KEYS`, `readJson`, `writeJson`.
- `frontend/src/store/layout/index.ts` — `setPanelWidth` and the debounced write behind
  it (~L1696). Extend it; do not add a second persistence path.
- `frontend/src/components/layout/TerminalSidebar.tsx` — the existing `Splitter` at ~L232
  and the section disclosures driven by `state.sidebarSections`.
- `frontend/src/EditorApp.tsx` — the `<aside>` (~L995), `treeVisible()`,
  `splitFraction`/`setSplitFraction`, `EditorGroupsView` (~L1113).
- `frontend/src/components/layout/MainSurface.tsx` (~L1090-1170) — the reference for
  ratio↔px arithmetic when a gap sits between panes. Copy the approach, not the code.
- Existing coverage: `frontend/src/store/layout/prefs.test.ts`,
  `frontend/src/store/layout/durability.test.ts`,
  `frontend/src/components/layout/Splitter.test.tsx`.
- `frontend/src/test/setup.ts` documents the pointer-capture shim every Splitter render
  test needs — read it before writing one.
</reuse>

<constraints>
- Zero new resize implementations. If `Splitter` cannot express a case, extend `Splitter`
  and update its header comment; do not write a second `mousemove`/`mouseup` pair.
- Persisted geometry is repaired, never rejected: a blob written by an older build must
  hydrate with the new keys at their defaults, matching how `parseGitSectionOrder` and
  the partial-blob parse already behave.
- Follow MASTER §7.1 (keyboard-initiated geometry changes are instant), §7.6 (a disabled
  handle states its reason in `title` + `aria-disabled`).
- Semantic tokens only; `tokenHygiene.test.ts` enforces it.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked.
</constraints>

<assumptions>
- The vertical-tabs right column (files stacked over git) is deliberately excluded here:
  Stream C splits those into two independent sidebars, which removes the shared edge
  rather than giving it a handle.
- Git sidebar accordion sections stay as they are — the user did not ask for them.
</assumptions>

<out_of_scope>
- Per-section height handles inside `GitSidebar`.
- The vertical-tabs right column layout.
- Sidebar docking, detaching, or dock-side changes (Stream C).
- Any colour, spacing or token change (Stream D).
- Changing existing defaults for `panels.rail`, `panels.sidebar`, `panels.gitSidebar`.
</out_of_scope>

<acceptance>
- Dragging each new handle resizes 1:1 with the pointer, clamps without a jump when
  dragged past the bound and back, and settles at the clamp on release outside the range.
- Arrow keys step 8px, Shift+arrow 32px, Home/End hit the bounds, double-click restores
  the default — on every new handle.
- Every new size survives a reload and, in stacked mode, a switch away from the view and
  back.
- A collapsed section's handle renders disabled with a `title` giving the reason.
- Unit tests in `frontend/src/store/layout/prefs.test.ts` cover: new keys default when
  absent from a persisted blob, and out-of-range persisted values clamp to the new bounds.
- A render test asserts the disabled-handle case for a collapsed section.
- `cd frontend && npm run test` green; `npx tsc --noEmit` clean.
</acceptance>
```
</content>
