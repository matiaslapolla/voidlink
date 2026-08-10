# UI wave 2 — August 2026

Eighteen asks from testing wave 1, cut into seven streams. Each stream file is a
paste-ready prompt for a fresh agent with no prior context.

## Streams

| # | File | Covers | Depends on |
|---|------|--------|------------|
| A | `A-five-sidebars.md` | Each panel is its own dockable sidebar (workspaces, explorer, terminals, git, agents); stop renaming Files→Explorer; git section rows stop eating the drag edge | — |
| B | `B-detach-lifecycle.md` | Detached parts close without crashing, come back collapsed, re-attach; stacked mode pulls everything home | A |
| C | `C-pane-groups-and-tabs.md` | `panegroup` tab kind with a nested split; panes closable; "Add to split pane"; tab rename + label colour | A |
| D | `D-context-menus.md` | Kill the webview's native menu; app menus on the surfaces that need one | C |
| E | `E-chrome-and-appearance.md` | Traffic lights actually aligned; Monaco theme stops inverting; background image + transparency actually visible | — |
| F | `F-board-cards.md` | Board cards open in the real editor; inline rename, labels, date | — |
| G | `G-layout-reset-and-compare.md` | Reset layout keeps workspaces and tabs; Compare branches moves out of the git sidebar into the `+` menu | A |

## Merge order

```
A → B → G → C → D → E → F
```

A first: it changes `SidebarId` from three ids to five, which B, C's dock-aware
strip and G's git-sidebar edit all build on. D after C: both rewrite parts of
`TabStrip.tsx`, and C's is structural. E and F touch disjoint files (CSS +
window chrome; board) and can be merged whenever, but they are last so a
conflict in them never blocks the layout work.

Wave 1's lesson, worth repeating: run the merges yourself and re-verify on the
merged branch. Two of wave 1's real bugs — a new component missing a token
another stream introduced, and a mock factory missing an export a third stream
started importing — were invisible to every isolated agent and only appeared
after the merge.

## Locked decisions

Answered before the streams were written. An agent must not relitigate these.

- **Pane groups are a real new tab kind.** Not a close button bolted onto
  today's per-worktree tree. A `panegroup` tab owns its own `PaneNode`. (C)
- **"Detached parts" means sidebars *and* the editor and git windows.** All
  three close cleanly, come back collapsed, and re-attach. (B)
- **A board card opens in the real editor**, not in a second editor built
  inside the board. The board gains inline title rename and label chips only. (F)
- **Native context menus are suppressed globally**, with `import.meta.env.DEV`
  keeping Inspect Element alive in development, and real app menus added on the
  surfaces that have something to offer. (D)
- **The canonical name is "Explorer"**, in the sidebar header, the title-bar
  tooltip, the command palette and the detached window title. Wave 1 shipped
  "Files" in some places and "Explorer" in others; one name, chosen once. (A)

## Worktrees

```sh
git worktree add .worktrees/five-sidebars      -b feat/five-sidebars
git worktree add .worktrees/detach-lifecycle   -b feat/detach-lifecycle
git worktree add .worktrees/pane-groups        -b feat/pane-groups
git worktree add .worktrees/context-menus      -b feat/context-menus
git worktree add .worktrees/chrome-appearance  -b fix/chrome-appearance
git worktree add .worktrees/board-cards        -b feat/board-cards
git worktree add .worktrees/layout-reset       -b fix/layout-reset-and-compare
```

Each worktree needs `frontend/node_modules` — symlink it rather than
reinstalling seven times:

```sh
ln -s ../../../frontend/node_modules .worktrees/<dir>/frontend/node_modules
```

Remove the symlink before `git worktree remove`, or the remove walks into it.
