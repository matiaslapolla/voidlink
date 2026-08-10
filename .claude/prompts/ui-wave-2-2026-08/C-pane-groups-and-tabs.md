# Stream C — a split is a tab you can close

Branch: `feat/pane-groups`, cut from `feat/five-sidebars`. Merge after G.

```text
<context>
VoidLink's workbench has a per-worktree pane tree (`store/layout/panes.ts`): a
recursive split whose leaves are `PaneGroup`s, each claiming a set of tab ids.
It has one load-bearing default — an empty `tabIds` on the *first* group means
"every tab nobody else claimed" — which is what makes an unsplit worktree
identical to the workbench before splits existed.

The model works but it is invisible and it is global. Testing surfaced two
consequences:

  • Closing the last tab in a pane leaves the empty pane sitting there. There
    is a close affordance (`ui.close-pane`), but it lives in a chord and a
    status-bar tooltip; the user found it by finding it missing.
  • A split belongs to the whole worktree, so there is no way to have two
    different arrangements and switch between them. The user's ask: a split
    should live *inside* a tab — open the tab, get the split; close the tab,
    the split is gone.

So splits become a tab kind. `TabKind` already has eleven members and a strict
per-kind contract (`TabKindSpec`: serialize, deserialize, restore, equals,
label, closedSnapshot). A twelfth — `panegroup` — whose payload is its own
`PaneNode` makes a split a first-class, nameable, closable, persistable object,
and makes "Add to split pane" a tab context action with somewhere to put things.

Two smaller asks ride along, both about the strip: a tab should be renameable
and its label should take a colour. `tabGroups.ts` already has exactly this for
group chips — label, `TAB_GROUP_COLORS` (the five chart tokens), F2-to-rename,
double-click-to-rename. This is that, per tab.
</context>

<task>
1. Add a `panegroup` tab kind. Its payload is a `PaneNode` — a nested split
   whose leaves claim tab ids the way today's tree does. Implement the full
   `TabKindSpec` for it: serialize, deserialize, restore, equals, label,
   closedSnapshot. Read the doc comments on that interface first; each field
   states an invariant that is easy to break (restored tabs keep their
   persisted id; `equals` is not id equality).

2. Render it. Opening a `panegroup` tab shows its nested split, each pane with
   its own strip. A tab inside a pane group is a real tab in the registry — the
   pane group claims it, exactly as a `PaneGroup` claims one today.

3. Make panes closable with a visible control, and make an emptied pane
   collapse. `removeGroup` and `pruneTabs` in `panes.ts` already implement the
   collapse rule and refuse to remove the last group; find out why the empty
   pane survives in practice and fix that, rather than adding a second rule
   beside the one that already exists.

4. Add a tab context-menu action **"Add to split pane"**. It moves the tab into
   a pane group — a new one if none is targeted, an existing one if the user
   picks it — and opens that pane group with the tab focused inside it.

5. Tab rename and label colour, working identically under horizontal and
   vertical tab orientation: F2 and double-click to rename, a colour submenu
   using `TAB_GROUP_COLORS`. Both persist. A renamed tab keeps its custom label
   until the user clears it; clearing restores the kind's derived label.
</task>

<reuse>
- `frontend/src/store/layout/panes.ts` — `PaneNode`, `PaneGroup`,
  `singleGroupLayout`, `groupList`, `resolveGroupTabs`, `moveTabToGroup`,
  `removeGroup`, `prune`, `collapse`, `pruneTabs`, `normalizeRatios`,
  `newPaneId`, `serializePaneLayout`, and the tab-id remapping used by
  snapshots. This module is pure and DOM-free and already recursive — a
  `panegroup` payload is a `PaneNode`, so it is *this* type, not a parallel one.
- `frontend/src/store/layout/tabs.ts` — `TabKind`, `TabTypes`, `TabKindSpec`,
  `TabStorage`, `TabRestoreContext`, `isEditorKind`, and the eleven existing
  specs (lines ~496–680) as worked examples. `closedSnapshot` / `ClosedTab` is
  what makes reopen-closed-tab work; a pane group that cannot be reopened is a
  regression.
- `frontend/src/store/layout/tabGroups.ts` — `TabGroup`, `TAB_GROUP_COLORS`,
  `DEFAULT_TAB_GROUP_COLOR`, `moveTabGroupToPane`, and above all its header
  comment stating the **orthogonal-axis rule**: `panes.ts` answers "which
  rectangle is a tab in", `tabGroups.ts` answers "how is a strip arranged". A
  `panegroup` tab must not become a third claim model. Say in a comment which
  axis it is on.
- `frontend/src/store/layout/index.ts` — `closePaneGroup` (~line 1475),
  `moveTabToPaneGroup`, `splitPaneGroup`, `focusedGroupByWorktree`.
- `frontend/src/components/layout/MainSurface.tsx` — the split renderer and its
  ~120px minimum-pane floor (pixels live here; `panes.ts` stays fractions-only).
- `frontend/src/components/layout/TabStrip.tsx` — `TabContextMenu`,
  `TabGroupContextMenu`, `TabOverflowMenu`, and the group chip's existing rename
  (`onRenameTabGroup`, the F2 handler, the swapped `<input>`, the "a chip being
  renamed is a text field, not a grip" comment). Per-tab rename is that, moved
  down a level — do not write a second inline-rename widget.
- `frontend/src/components/layout/paneDrop.ts` and `dragDrop.ts` — hit testing
  and drop zones, including the priority ordering that lets a sidebar drop win
  over a pane split.
- `frontend/src/components/ui/Menu.tsx` — the roving-tabindex menu every context
  menu in the app is now an adapter over.
- `frontend/src/components/layout/Splitter.tsx` — one splitter, already handling
  pointer capture, 1:1 tracking, 8/32px keyboard steps, Home/End,
  double-click-reset and disabled-with-reason. Nested splits use it.
- Tests to extend rather than replace: `panes.test.ts`, `tabs.test.ts`,
  `tabGroups.test.ts`, `durability.test.ts`, `TabStrip.browser.test.tsx`.
</reuse>

<constraints>
- **Persistence repairs, never rejects.** A blob written by an older build has
  no `panegroup` tabs; a blob from a newer one may name a kind this build lacks.
  Both must hydrate. `tabs.ts`'s `deserialize` contract already says a malformed
  entry costs one tab and not the boot — a nested tree makes that easier to
  violate, so test a corrupt nested payload explicitly.
- Arrays, not Sets, in anything persisted. `JSON.stringify(new Set())` is `{}`.
- **The workbench body must never remount** — live PTYs hang off it. A terminal
  tab moved into a pane group must keep its PTY and its scrollback. This is the
  single highest-risk property in the stream; prove it with a browser test that
  moves a live terminal tab into a pane group and asserts the terminal's DOM
  node survives.
- `panes.ts` stays pure and DOM-free. Pixel decisions stay in `MainSurface` /
  `paneDrop`.
- Follow `frontend/design-system/MASTER.md`: §7.1 keyboard-initiated geometry is
  instant, §7.6 no layout shift and every disabled control states a reason, §10
  AA contrast — a coloured tab label still has to be readable.
- No raw colour literals in `src/components/**` (`tokenHygiene.test.ts` fails
  over it). Tab label colours come from `TAB_GROUP_COLORS`, which are existing
  chart tokens every theme defines.
- Solid, not React: props are getters, never destructured; no dependency arrays.
- Build exactly this stream. Do not suppress native context menus or add menus
  to non-tab surfaces — that is Stream D, and it edits the same file. Do not
  touch the sidebars, the board, or the CSS background layer. If a premise here
  looks wrong, say so in a sentence and continue as asked.
</constraints>

<assumptions>
- A `panegroup` tab's default label is "Split 1", "Split 2", … per worktree,
  renameable through the same mechanism as any other tab.
- Nesting is allowed one level deep only for now: a pane group may not contain
  another pane group tab. Enforce it in the store and disable the "Add to split
  pane" row inside a pane group with that reason (§7.6).
- Closing a `panegroup` tab does not close the tabs inside it. They fall back to
  the worktree's first pane group, which is what `closePaneGroup` already does
  and for the stated reason: a pane going away must never take a terminal with
  it.
- Per-tab colour is stored on the tab, not derived from its kind, and survives a
  rename.
</assumptions>

<out_of_scope>
- Right-click menus outside the tab strip, and suppressing the native webview
  menu (Stream D).
- Sidebar docking or detaching (Streams A, B).
- Detaching a pane group into its own window.
- Nested pane groups more than one level deep.
- Auto-grouping modes (`AutoGroupMode`) gaining a pane-group derivation.
- Snapshots gaining a new format — they already remap tab ids through content
  keys; keep that working, do not extend it.
</out_of_scope>

<acceptance>
- A `panegroup` tab opens, shows a nested split, splits further, and survives a
  reload with its ratios, its claims and its focused pane intact.
- Closing a pane inside a pane group collapses the split; closing the last pane
  closes nothing (the last group is never removable).
- Closing the last tab in a pane no longer leaves an empty pane behind. A unit
  test in `panes.test.ts` that fails on today's `main`.
- "Add to split pane" appears in a tab's context menu, moves the tab, and opens
  the pane group with it focused. Disabled with a reason where it cannot apply.
- Tab rename via F2 and double-click, and label colour, both working and both
  persisted, under horizontal *and* vertical orientation. Vertical is where wave
  1's layout bugs lived, so assert it explicitly.
- Browser test: a live terminal tab moved into a pane group keeps its DOM node.
  jsdom zeroes `getBoundingClientRect`, so anything geometric only proves
  something in the browser project (`fileParallelism: false`, real Chromium).
- Unit tests: `panegroup` round-trips through serialize/deserialize/restore;
  a corrupt nested payload costs one tab and not the boot; `equals` dedupes on
  open; `closedSnapshot` reopens a closed pane group.
- `npm run test`, `npx vitest run --project browser`, `npx tsc --noEmit`,
  `npx eslint .` clean; `npm run build` succeeds.
</acceptance>
```
