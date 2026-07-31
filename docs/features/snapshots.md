# Workspace snapshots

## What it does

Saves a named picture of a worktree's open tabs, pane geometry and sidebar
layout to `localStorage`, and restores it later. It is a **UI layout**
feature — it touches no files and no git state.

## When you'd use it

Parking a context. "I had four files, two terminals, a compare tab and the
commit graph open in a split for the auth refactor" — save it as
`auth-refactor`, go do something else, restore it.

## How to use it

- **`Snapshot: manage saved snapshots…`** opens the snapshot manager: one list of everything
  saved for the current worktree, with save, restore, rename and delete. It is
  fully keyboard-navigable (`↑` `↓` `Home` `End` to move, `Enter` to
  restore, `F2` to rename, `Delete` / `Backspace` to delete).
- **`Snapshot: save current as…`** prompts for a name and saves without opening
  the manager.
- Per-snapshot `Snapshot: restore "<name>"` palette entries still exist for
  muscle memory. They are generated at runtime from user data and so, per the
  header comment in `commands/actionIds.ts`, are deliberately not declared
  static action ids. **Delete and rename are not in the palette** — they are
  destructive and belong next to what they act on, which a palette row cannot
  show.

Per-snapshot restore entries only appear for the **currently active**
worktree.

## The v2 format

```ts
interface WorkspaceSnapshot {
  version: 2;
  name: string;
  savedAt: number;
  tabs: SnapshotTabs;   // all ten kinds
  panes: unknown | null; // the serialized pane tree, claims as content keys
  active: string | null; // content key
  pinned: string[];      // content keys
  ui: SnapshotUi;
}
```

Two properties are load-bearing:

1. **Everything is addressed by content, never by tab id.** A key is
   `"kind:identifier"` — `file:/repo/src/main.ts`, `compare:main..HEAD`,
   `stack:feature-top`, `terminal:0`, `history:`. A restore mints fresh ids for
   everything it opens, so an id captured today names nothing tomorrow; a path
   or a pair of refs still does. The pane tree's group claims and per-group
   active tabs are rewritten into the same keys for exactly this reason.
2. **The format is versioned and migrated on read.** v1 held five of the ten
   tab kinds in five parallel top-level arrays and carried no `version` field
   at all. `migrateSnapshot` upgrades a v1 blob **in memory on the way in**, so
   saved snapshots survive the upgrade without a rewrite — and a snapshot that
   is read but never re-saved stays v1 on disk, harmlessly.

A v1 snapshot has no pane geometry, so it restores into the default single
group. That is the layout it was taken in: v1 predates pane groups entirely.

## What is captured

| Captured | Not captured |
|---|---|
| All ten tab kinds: files, terminals, diffs, compares, stacks, conflicts, previews, browsers, the commit graph, the timeline | Unsaved editor content |
| Terminal labels and cwds | Cursor and scroll positions |
| Compare tabs (both refs, merge-base flag, selection, tree mode, filter) | Terminal scrollback and running processes |
| Stack tabs (trunk + top branch) | The worktree's repo root |
| Browser tabs (last URL and title) | Sidebar widths |
| The pane split tree: orientation, ratios, per-group tab claims and active tab | Which workspace was active |
| Pinned tabs and the active tab, as content keys | Live activity signals (a bell that rang is not news tomorrow) |
| The UI flags: git sidebar collapsed, left sidebar collapsed, sidebars swapped, diff mode, git tab, ignore whitespace, sidebar tab | |

## How restore works

1. Look up the snapshot by name; a miss returns false and toasts
   `Snapshot "<name>" not found`.
2. Close every existing PTY, fire and forget.
3. Wipe the worktree's tabs, pins and active item — **deliberately without**
   pushing to the closed-tab history, so `Mod+Shift+T` cannot undo a restore.
4. Apply the UI flags.
5. Recreate every non-terminal kind with fresh ids, recording each one's
   content key.
6. Spawn terminals last, asynchronously — the rest of the surface is already
   interactive.
7. Rebuild the pane geometry, translating claims from content keys back to the
   ids just minted.
8. Re-pin and re-activate by content key, falling back to the first restored
   tab in render order.

## Keyboard shortcuts

None global. Inside the manager: `↑` `↓` `Home` `End`, `Enter`, `F2`,
`Delete` / `Backspace`, `Esc`.

## Gotchas and limits

- **"Sidebar state" is app-global, not per-worktree.** Restoring a snapshot
  mutates the sidebar and diff preferences for the whole app.
- **The recorded terminal cwd is not where the shell spawns.** Every restored
  terminal spawns in the *worktree's* directory, so restoring a snapshot into a
  different worktree cannot resurrect shells pointing at the old one. The
  recorded cwd stays on the session for context.
- **A restored terminal is a fresh shell.** Scrollback is gone and the UI says
  so — the tab's tooltip reads
  `new shell in <cwd>; scrollback was not restored` rather than leaving you to
  infer it.
- **If the worktree has no repo root, zero terminals are restored.**
- **Terminal and browser content keys are array indices**, so a pinned or
  active one re-binds by position, not identity.
- **Restore does not check that files still exist.** A deleted path is
  recreated as a tab pointing at nothing.
- **Re-saving under an existing name overwrites it with no confirmation.**
- **Snapshots are keyed by workspace id and never cleaned up.** Deleting a
  workspace orphans its snapshots in `localStorage` forever. They are also not
  keyed by repo, so pointing a workspace at a different repo makes its
  snapshots meaningless.
- **A corrupt entry is dropped, not the whole set.** The loader migrates each
  entry independently and discards the ones that fail, so one bad blob costs
  one snapshot rather than all of them.
- Storage key: `voidlink-snapshots`, shaped
  `Record<workspaceId, WorkspaceSnapshot[]>`.
