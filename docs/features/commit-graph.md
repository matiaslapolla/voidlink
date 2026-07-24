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

- **The graph tab does not survive a reload.** There is no persistence key for
  it, and `Mod+Shift+T` cannot reopen it — closing it doesn't push to the
  closed-tab history.
- **`Load more` resets to 200 on any remount**, because the limit is component
  state.
- **`Load more` is shown only when the returned count exactly equals the
  limit.** A repo whose total commit count happens to be a multiple of 200 shows
  a button that then loads nothing.
- **Ref chips can't tell a branch from a tag.** The remote-versus-local styling
  is inferred purely from whether the name contains `/`, so a local branch named
  `feature/x` renders with the cloud icon and remote styling. Tags look
  identical to branches. The code documents this as a known gap that would need
  a richer backend payload.
- **A lane whose target commit falls outside the fetched window runs off the
  bottom** unterminated. That is the intended railroad look, but it does mean
  the bottom of the graph is not a complete picture.
- **Clicking a root commit produces an error** — it opens `<oid>^ .. <oid>`, and
  `<oid>^` doesn't resolve.
- **Long ref names truncate** at 120 px.
- Commits with an empty message render as italic `(no message)`.
