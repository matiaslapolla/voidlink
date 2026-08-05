# Project board

## What it does

A kanban board for the open project, stored as one markdown file per card under
`<repoRoot>/.voidlink/board/`. Columns are declared in a single `board.md`;
each card names its own column and position in its own frontmatter. Drag a card
between columns to move it — that is a file write, nothing more.

Every repository has its own board. There is no database, no index file, and
nothing shared between projects.

## When you'd use it

To keep the three things you are actually doing in this repo visible, in a
format you can also edit in the editor next to the board, or hand to an agent.

## Setup

None. The directory is created by the first card you add.

## The file format

```text
<repoRoot>/.voidlink/board/
  board.md                          ← which columns exist
  2026-08-04-wire-the-watcher.md    ← one card
```

`board.md`:

```markdown
---
columns: [Todo, Doing, Done]
---
Columns for this project's board. Rename, reorder or add one here; each card
names its column in its own frontmatter.
```

A card:

```markdown
---
id: 2026-08-04-wire-the-watcher
type: card
title: "Wire the watcher"
column: "Doing"
order: 1.5
labels: ["rust", "watch"]
created: "2026-08-04T10:11:12.000-03:00"
---
Whatever you want to say about it, in markdown.
```

Flat frontmatter, the same dialect the project brain uses — scalars and one
flow array, no YAML engine on either side.

### Why membership lives in the card and not in an index

An index file would be a second source of truth about where a card sits, and it
would be wrong the first time anything wrote a card *without* going through the
app — which is the entire point of storing cards as files. `board.md` is not an
index: it says which columns exist, so an empty column can, and says nothing
about what is in them.

A card whose `column:` names something `board.md` does not declare is **not**
dropped. It appears in the first column, marked, because the file is still on
disk and work silently vanishing from the board is the worst available outcome.

### Why `order` is a float

So that inserting a card between two others is their midpoint and rewrites
**one** file. If two cards ever end up sharing an order — concurrent writers, or
a hand edit — there is no midpoint to take, and that one drop renumbers the
destination column instead. That is the only case where a move costs more than
one write.

## How to use it

It is an **overlay**, not a tab. Open it from the command palette
(`Open board…`) or from the tab bar's `+` menu → `Board`; `ESC`, the close
button or a click on the scrim dismisses it.

1. With no repository open you get `Open a repository to see its board.`
2. With a repository and no cards yet: `This project's board has no cards.`
3. `New card` adds one to the first column.
4. Drag a card onto a column to move it to the end of it, or onto another card
   to drop it in front of that one.

### Which repository

The **workspace's repo root**, not the active worktree's path — same as the
brain, and for the same reason: a card about the project should not disappear
because you switched to the worktree you wrote it for.

## Concurrency

A card can be moved here, edited in the editor and rewritten by an agent at the
same time. Two mechanisms cover that:

- **Every read hands back a revision, and every write has to quote it.** Rust
  refuses a write whose revision no longer matches the file on disk. You get
  `“<card>” changed on disk — the board has been reloaded.` and the other
  writer's version survives intact.
- **A move re-reads the card immediately before writing it.** So an edit made
  while the board was merely *open* is not a conflict — it is picked up, and the
  move lands on top of it, body and title intact. The refusal is reserved for
  the window the app genuinely cannot close: between its own read and its own
  write.

External writes reach the board without a manual refresh: Rust watches
`.voidlink/board/` and broadcasts `voidlink://board-changed`. That is a separate
channel from the git pulse, because `.voidlink/` is normally gitignored — a
board write is dropped by the git filter, and if it weren't, every card moved
would wake every git surface to re-run `git status` for a change git cannot see.

## Gotchas

- **Nothing is committed.** Same explicit choice the brain makes: this writes
  inside the repo you are working in, and a commit made behind your back lands
  on your branch in the middle of your change. The write is the whole operation.
- **`.voidlink/` is normally gitignored**, which means by default the board is
  yours and stable across branches rather than shared. If you want the board
  committed and shared with the repo, remove `.voidlink/` from the ignore rules
  — nothing in the app stops you. The worktree wizard's one-time
  "`.voidlink/` is not gitignored" warning is about the *worktree defaults* it
  is saving, and fires only when you ask it to remember them; it is not a
  judgement about the board.
- **One board per repo.** No multiple boards, no cross-workspace aggregation.
- **No sync with GitHub Issues, Linear or anything else.** The file is the
  record.
- Cards have a title, a column, an order and labels. No assignees, due dates,
  checklists or attachments — the frontmatter is open, so adding a field is
  possible, but nothing in the app reads one.
