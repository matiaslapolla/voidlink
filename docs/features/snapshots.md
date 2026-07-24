# Workspace snapshots

## What it does

Saves a named picture of a workspace's open tabs and sidebar layout to
`localStorage`, and restores it later. It is a **UI layout** feature — it
touches no files and no git state.

## When you'd use it

Parking a context. "I had four files, two terminals, and a compare tab open for
the auth refactor" — save it as `auth-refactor`, go do something else, restore
it.

## How to use it

All three entry points are in the command palette; there are no buttons and no
shortcuts.

- `Snapshot: save current as…` — prompts for a name
  (`Name this snapshot of tabs, terminals, and sidebar state`), then confirms
  with a toast.
- `Snapshot: restore "<name>"` — one palette entry per saved snapshot, with a
  description reading `n files · n terminals · n compares`.
- `Snapshot: delete "<name>"` — deletes immediately, **no confirmation**.

Restore and delete entries only appear for the **currently active** workspace.

## What is captured

| Captured | Not captured |
|---|---|
| Open file paths | Unsaved editor content |
| Terminal labels and cwds | Cursor and scroll positions |
| Diff tab paths | Terminal scrollback and running processes |
| Compare tabs (both refs, merge-base flag, selection, tree mode, filter) | The workspace's repo root |
| Stack tabs (trunk + top branch) | Sidebar widths |
| Pinned tabs and the active tab, as content keys | Which workspace was active |
| Seven UI flags: git sidebar collapsed, left sidebar collapsed, sidebars swapped, diff mode, git tab, ignore whitespace, sidebar tab | Conflict, history, preview, and brain tabs |

## How restore works

1. Look up the snapshot by name; a miss returns false and toasts
   `Snapshot "<name>" not found`.
2. Close every existing PTY, fire and forget.
3. Wipe the workspace's files, terminals, diffs, compares, stacks, pins, and
   active item — **deliberately without** pushing to the closed-tab history, so
   `Mod+Shift+T` cannot undo a restore.
4. Apply the seven UI flags.
5. Recreate files, diffs, compares, and stacks with fresh ids.
6. Spawn terminals last, asynchronously.
7. Re-pin and re-activate by content key, falling back to the first tab in
   order file → terminal → diff → compare → stack.

## Keyboard shortcuts

None.

## Gotchas and limits

- **The palette description over-promises.** It says "tabs + terminals +
  sidebar state", but VoidLink has nine per-workspace tab kinds and snapshots
  cover five. **Conflict, history (commit graph), preview, and brain tabs are
  silently dropped on save** — and on restore they are neither cleared nor
  restored, so they survive as orphans while pins and the active item are reset.
- **An active preview, conflict, history, or brain tab records as no active
  tab.**
- **"Sidebar state" is app-global, not per-workspace.** Restoring a snapshot
  mutates the sidebar and diff preferences for the whole app. The source
  acknowledges this.
- **The recorded terminal cwd is ignored.** Every restored terminal spawns at
  the workspace's repo root — there is no per-cwd spawn API. If the workspace
  has **no repo root, zero terminals are restored**.

  (The Spanish manual's section 14 says a restored terminal comes back in its
  original directory. It does not.)
- **Terminal content keys are array indices**, so a pinned or active terminal
  re-binds by position, not identity.
- **Restore does not check that files still exist.** A deleted path is recreated
  as a tab pointing at nothing.
- **Re-saving under an existing name overwrites it with no confirmation.**
- **Deleting a snapshot has no confirmation.**
- **Snapshots are keyed by workspace id and never cleaned up.** Deleting a
  workspace orphans its snapshots in `localStorage` forever. They are also not
  keyed by repo, so pointing a workspace at a different repo makes its snapshots
  meaningless.
- **Corrupt storage loses everything silently** — the loader swallows parse
  errors and returns an empty set.
- Storage key: `voidlink-snapshots`, shaped
  `Record<workspaceId, WorkspaceSnapshot[]>`.
