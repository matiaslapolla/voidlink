# Commit graph

## What it does

A tab that renders the commit DAG as a railroad diagram: one row per commit,
coloured lanes for the branch structure, ref chips for the branches and tags
that point at each commit, and a ring on `HEAD`.

## When you'd use it

To see how branches actually relate — where something forked, what merged into
what — rather than the flat log in the sidebar's History section.

## How to use it

1. `Mod+Shift+H`, or the palette's `Open commit graph`. Without a repo open you
   get the toast `Open a repository first`.
2. Click a row to open a compare tab of that commit against its first parent.
3. `Load more` adds another 200 commits. `Refresh` re-fetches.

There is at most **one** graph tab per workspace — asking again focuses the
existing one. The tab is labelled `graph`.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+H` | Open commit graph |
| `Mod+W` | Close the tab |

The graph itself has **no keyboard handling** — no arrow navigation, no Enter,
no context menu.

## How the data is built

The backend walks refs first, then commits:

1. Iterate every reference that `is_branch()`, `is_remote()`, or `is_tag()`,
   take its shorthand, skip the literal `HEAD`, and peel it to a commit — so an
   annotated tag decorates the right dot. Names are sorted and deduplicated per
   commit.
2. Resolve `HEAD` separately for the `isHead` flag.
3. Revwalk with `TOPOLOGICAL | TIME` sorting, seeded from `HEAD`,
   `refs/heads/*`, and `refs/remotes/*`. Topological ordering guarantees
   child-before-parent, which the lane router depends on; time breaks ties
   newest-first.
4. Take `limit` commits (default 200).

## How lanes are assigned

`frontend/src/components/git/history/lanes.ts`, one forward pass. The state is
an array where **`lanes[k]` holds the oid that column `k` is currently waiting
to reach**.

For each commit, in the backend's topological order:

1. **Pick the dot column.** If some lane is already waiting for this commit, use
   it. Otherwise this is a branch tip nothing has referenced yet — take the
   first free column, appending one if needed.
2. **Converge.** Null out *every* lane waiting for this oid. That is how several
   children merging into one commit release their columns.
3. **Route the parents.** For each parent, in order:
   - If a lane already heads to that parent, reuse it — another child got there
     first.
   - Else if it's the **first** parent, it inherits this commit's own column.
     This is what keeps a branch's mainline in a straight vertical.
   - Else (second and later parents of a merge) take the first free column.
4. Trim trailing nulls so freed right-edge columns get reused.

A second pass turns that state into the segments drawn in the gap *below* each
row. A lane that just sprang from this commit's dot starts at the dot rather
than straight down; a lane converges onto the next dot only when the next row is
exactly the commit it was waiting for. The colour index is the column at the top
of the gap, so a lane keeps its colour while shifting sideways.

Geometry: 30 px rows, 16 px columns, 4 px dots. Straight lines when the top and
bottom columns match, otherwise a cubic S-curve. Five lane colours cycling
`--color-chart-1` … `--color-chart-5`.

## Gotchas and limits

- **`Load more` resets to 200 on any remount**, because the limit is component
  state, and it refetches the whole window rather than appending. The refetch is
  correct — libgit2's topological order is a function of the ref set, not of the
  limit, so the first 200 oids are a stable prefix of the first 400 — but it is
  redundant work. It no longer costs you your scroll position.
- **The seeded ref set is wide**: HEAD, local and remote branches, tags,
  stashes, notes, `ORIG_HEAD`/`MERGE_HEAD`/`REBASE_HEAD`/`CHERRY_PICK_HEAD`, and
  every other linked worktree's HEAD. A commit reachable only through a tag —
  `v1` on a branch since deleted — is in the graph, with its chip.
- **Rows are ordered and timestamped by committer time.** Author time is also
  carried but not displayed; showing it beside a committer-time ordering made a
  rebased history read newest-first with timestamps that went up and down.
- **A lane whose target commit falls outside the fetched window** is drawn to
  the bottom edge as a faded dashed stub, and the header says "more history
  below". Nothing is silently cut off.
- **The first parent does not always keep the mainline vertical.** When an
  earlier child already claimed the lane heading to that parent, this dot bends
  into it diagonally instead. Two children of one parent cannot both keep their
  column, and the one that got there first owns it.
- **The gutter is capped at 180 px.** Beyond ~10 concurrent lanes the columns
  overlap rather than squeezing the commit summary to nothing.
- **Windowed above 60 commits** — rows *and* gutter. Only the visible slice of
  the SVG is drawn, which is the half that matters: the gutter emits a `<path>`
  per lane segment and two `<circle>`s per commit, so windowing the rows alone
  would have moved the cost rather than removed it. The SVG keeps its full
  height and absolute coordinates, so the scrollbar stays honest and nothing is
  translated.

  The window is drawn **one row wider than the viewport on each side**, because
  a lane segment runs from row `i` to row `i+1`: drawn to exactly the visible
  rows, the graph would look severed at the top and bottom edges while
  scrolling. `gutterRange` in `lanes.ts` is that arithmetic, and it is unit
  tested — the measurement half needs a real browser and is not.

  What is *not* windowed is the fetch: `Load more` still walks from the tips, so
  the walk cost is unchanged. See below.
- **Long ref names truncate** at 120 px.
- Commits with an empty message render as italic `(no message)`.
