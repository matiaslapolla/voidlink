# Stream A — five sidebars, one name each

Branch: `feat/five-sidebars`. Merge first.

```text
<context>
VoidLink is a Tauri v2 + SolidJS desktop workbench. A previous wave replaced a
single global `sidebarsSwapped: boolean` with a per-sidebar dock model
(`store/layout/dock.ts`), which made three panels independently dockable:
`workspaces`, `files`, `git`.

Three ids was one too few, and testing exposed both symptoms:

  1. The file explorer sidebar has the terminals list and the agents dashboard
     stacked underneath it. That is not a design — it is `TerminalSidebar`, a
     single column that happens to contain three unrelated sections, and it is
     what the `files` dock id actually points at under horizontal tabs.
  2. The same panel is called "Files" in one placement and "Explorer" in the
     other, because under vertical tabs a *different* component
     (`FilesSidebar`) renders it. A panel that renames itself when you change
     an unrelated preference reads as two panels.

The user wants five peers — workspaces, explorer, terminals, git, agents — each
with its own edge, width, collapse and detachability. That is the dock model
doing what it was built for; the three-id list is the only thing stopping it.

A third, smaller complaint rides along: in the git sidebar every section row
(Changes, Branches, Worktrees, …) spans the panel's full width, so there is no
strip of panel left to grab, and the sidebar cannot be dragged from anywhere in
its body.
</context>

<task>
1. Grow `SidebarId` from three ids to five: `workspaces | explorer | terminals |
   git | agents`. Rename the `files` id to `explorer` as part of this — see
   the migration note in <constraints>.

2. Split `TerminalSidebar` into two sidebars. `TerminalsSidebar` renders the
   terminals list; `AgentsSidebar` renders `AgentDashboard`. Neither renders
   the file tree. `FilesSidebar` becomes the *only* explorer, rendered
   identically under both tab orientations.

3. Give all five ids the full dock treatment: an entry in `DEFAULT_DOCK_SIDE`,
   `DEFAULT_DOCK_ORDER`, `SIDEBAR_PANEL`, `SIDEBAR_LABEL`, a `PanelId` with
   bounds in `PANEL_BOUNDS`, a `SidebarGrip` and `SidebarMenuButton` in its
   header, and a slot in `AppShell`.

4. Settle the naming. "Explorer" is the canonical user-facing word, everywhere
   the panel is named: the sidebar header, `SIDEBAR_LABEL`, the title-bar
   toggle's `aria-label` and `title`, the command palette rows, and the
   detached window title.

5. In `GitSidebar`, inset the section rows so the panel keeps a grabbable
   margin down both edges. Pick one horizontal inset and apply it to every
   section, not per-section padding that drifts.
</task>

<reuse>
- `frontend/src/store/layout/dock.ts` — `SidebarId`, `SIDEBAR_IDS`,
  `DEFAULT_DOCK_SIDE`, `SWAPPED_DOCK_SIDE`, `DEFAULT_DOCK_ORDER`,
  `parseDockSide`, `parseDockOrder`, `parseDetachedSidebars`, `sidebarsOnSide`,
  `moveInDockOrder`, `mirrorArrangement`, `slotOrder`. Every one of these is
  already written against an id *list* rather than three hardcoded names —
  growing the list is most of the work, not a rewrite.
- `frontend/src/store/layout/prefs.ts` — `SIDEBAR_PANEL` (line 126),
  `PANEL_BOUNDS`, `SIDEBAR_RAIL_WIDTH`, `UiPrefs`. The `PanelWidths` record
  needs two new panel ids.
- `frontend/src/components/layout/SidebarDock.tsx` — `SIDEBAR_LABEL`,
  `SidebarGrip`, `SidebarMenuButton`, `SidebarDockOverlay`. The two new
  sidebars get the same header furniture; do not write a second grip.
- `frontend/src/components/layout/TerminalSidebar.tsx` — the source of both new
  components. Its terminals section (LED slots, `watchTerminal`,
  `forgetTerminalHistory`, `forgetPtySize`, `tabMark`) moves to
  `TerminalsSidebar` intact.
- `frontend/src/components/files/FilesSidebar.tsx` and
  `components/files/FilesPanel.tsx` — `FilesPanel` / `FilesRail` are already
  the shared implementation both placements render. Keep that; delete the
  second placement, not the sharing.
- `frontend/src/components/layout/AppShell.tsx` — the slot composition and the
  `slotOrder` flex trick. Read its comment about rendering every slot once in
  a fixed DOM position before touching it.
- `frontend/src/components/layout/TitleBar.tsx` — `panelOn` / `collapsedOn` /
  `toggleOn` / `labelOn` resolve the two toggle buttons by dock side. With five
  panels a side can hold several; decide what the button means then and say so
  in its `title`.
- `frontend/src/store/layout/dock.test.ts` — the existing repair tests are the
  template for the migration tests.
- `frontend/src/components/git/GitSidebar.tsx` — `GIT_SECTION_KEYS` ordering and
  the section header buttons (the `w-full flex items-center` rows).
</reuse>

<constraints>
- **The `files` → `explorer` rename is a persisted-state migration.**
  `parseDockSide`, `parseDockOrder` and `parseDetachedSidebars` all repair
  rather than reject, and they must keep doing that: a blob containing `files`
  must come back as `explorer` at the same edge and position, not be dropped as
  an unknown id. `parseDockSide` already takes a `legacySwapped` argument for
  exactly this kind of one-way translation — follow that shape. Also migrate
  the `sidebar` panel-width key if you rename it; a user who resized their
  explorer must not find it back at the default.
- **The workbench body must never remount.** Live PTYs hang off it. `AppShell`
  renders every slot once at a fixed DOM position and expresses dock changes as
  `slotOrder` flex values precisely so a preference change cannot tear down a
  terminal. Two more slots must not become two more reasons to re-render the
  tree. Prove it: a browser test that moves a sidebar across edges and asserts
  the workbench element is the same node afterwards.
- Follow `frontend/design-system/MASTER.md`. §7.6: every disabled control states
  a reason in its `title`. §7.1: a keyboard-initiated geometry change is
  instant. §10: AA contrast.
- No raw colour literals in `src/components/**` — `tokenHygiene.test.ts` fails
  the build over it. The two new sidebars take `bg-sidebar` like their siblings.
- Solid, not React: no `useEffect`, no dependency arrays, props are accessed as
  getters and never destructured.
- Build exactly this stream. Detach lifecycle, pane groups and context menus are
  separate branches and will conflict if you touch them. Make routine calls
  yourself; check in only where two readings mean materially different work.
</constraints>

<assumptions>
- Default arrangement for the five: `workspaces` and `explorer` on the left,
  `git` on the right, `terminals` and `agents` on the left below the explorer —
  i.e. `DEFAULT_DOCK_ORDER = [workspaces, explorer, terminals, agents, git]`
  with `git` the only right-edge default. This reproduces today's screen for an
  existing user as closely as five independent panels can.
- `agents` and `terminals` are both detachable in principle; Stream B owns the
  windows. This stream only has to make `canDetachSidebar` answer honestly for
  them, which today it does from `SIDEBAR_WINDOW_LABEL`.
- The git section inset is `px-2`, matching the panel padding already used
  elsewhere in that file, unless a smaller one is needed to keep the section
  labels from wrapping.
</assumptions>

<out_of_scope>
- Opening the new sidebars in their own OS windows (Stream B).
- Any change to `TabStrip.tsx` or the pane tree (Stream C).
- Right-click menus (Stream D).
- Removing "Compare branches" from the git sidebar footer (Stream G) — leave
  that button exactly where it is.
- Colour-token work; the new sidebars use the tokens that exist.
- The board (Stream F).
</out_of_scope>

<acceptance>
- Five sidebars render, each with its own header, grip, menu, width, collapse
  state and splitter. The explorer contains a file tree and nothing else.
- The panel is called "Explorer" in every user-visible string. Grep the repo for
  a user-facing `"Files"` and justify any that survives.
- A localStorage blob written by the current `main` (containing `files` in
  `dockSide`, `dockOrder` and `detachedSidebars`) hydrates with the explorer at
  the edge, position and width it had. Unit test in `dock.test.ts`.
- A blob naming an id this build does not know is repaired, not thrown on.
- Unit tests: the migration above; `sidebarsOnSide` with five ids across both
  edges; `moveInDockOrder` and `mirrorArrangement` over five.
- Render test: `TerminalsSidebar` renders no file tree; `AgentsSidebar` renders
  no terminals list.
- Browser test (`.browser.test.tsx`): dragging a sidebar to the opposite edge
  re-docks it *and* the workbench element is identity-equal before and after.
  jsdom zeroes `getBoundingClientRect`, so this only proves anything in the
  browser project.
- `npm run test`, `npx vitest run --project browser`, `npx tsc --noEmit`,
  `npx eslint .` all clean, and `npm run build` succeeds.
</acceptance>
```
