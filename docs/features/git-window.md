# Git window

## What it does

Opens the git surface as a **separate OS window** — its own entry in the
window list, its own position, its own space. The same split Cursor uses
between its agent surface and its editor: two windows, one app, one process.

The window hosts Changes, Branches, Worktrees, Stack, Stashes, History and
Tags as a nav-plus-detail layout, with Compare branches pinned at the bottom.
These are the *same components* the git sidebar renders — the difference is
that they get a whole window instead of a 300px column.

## When you'd use it

- You have a second display and want git permanently visible on it.
- You're reviewing a large diff and the sidebar is too narrow for the tree.
- You want the workbench window to be nothing but editor and terminal.

The sidebar does not go away. Both surfaces work at once and stay in sync.

## How to use it

| Route | How |
|---|---|
| Keyboard | `Mod+Shift+G` |
| Palette | `Mod+K` → `Open git window` |
| Git sidebar | The panel icon in the header row |

All three call the same command, which **focuses** the window if it is already
open rather than making a second one. There is only ever one git window.

Close it like any window (`Mod+Shift+W`, or the red traffic light). Closing it
does not disturb the workbench — in particular it does not touch your running
terminals, which belong to the main window.

## How the two windows stay in sync

Two webviews are two JavaScript contexts. They cannot share a Solid store, so
exactly two things cross the gap, both as Tauri events:

1. **Which repository is active.** The workbench owns that decision — it has
   the rail and the worktree switcher — and broadcasts it on every change. The
   git window is a pure consumer: it never picks a repo, so the two cannot
   disagree. On open it asks for a fresh broadcast, because it may have
   started after the last one.
2. **"Refs changed."** Commit in one window and the other refetches. This
   re-broadcasts the in-process `voidlink:refresh-git` pulse across the window
   boundary, with a source label so a single commit doesn't ping-pong forever.

Everything else the git window shows it reads straight from the Rust git
commands, which are stateless and window-agnostic, so there is nothing else to
synchronise.

The git window creates a layout store because the panes it reuses call
`useAppStore()`, but that store is built with `persist: false`. Only the
workbench writes layout state to `localStorage`; if both windows wrote the same
keys, the last writer would silently clobber the other's open tabs.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+G` | Open (or focus) the git window |
| `Mod+Shift+W` | Close the focused window |

The keymap in the git window is the workbench's keymap minus anything that
needs an editor or a terminal — those surfaces don't exist here.

## Gotchas and limits

- **It follows the workbench; it does not lead.** There is no repo picker in
  the git window. With no repository open in the main window it shows
  "Open a repository in the main voidlink window" and stays empty.
- **Closing the main window closes everything.** The main window owns the PTYs
  and quitting it tears down the app. Close the git window first if you only
  meant to dismiss git.
- **Compare tabs opened here are not persisted.** The git window's store is
  read-only by design, so a compare you open in it is gone on restart. Compare
  tabs opened from the workbench still persist as before.
- **Its capability set is narrower than the workbench's.** The git window's
  webview has no `core:webview:*` grants (it never spawns browser tabs) and no
  filesystem write grants. See `src-tauri/capabilities/git-window.json`.

## See also

- [Git staging](./git-staging.md) — the Changes pane, including commit identity
- [Branch compare](./branch-compare.md) — what the bottom button opens
- [Commit graph](./commit-graph.md) — the History section
