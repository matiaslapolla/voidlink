# Branch compare

## What it does

A tab that diffs any two refs and shows the changed-file tree plus a per-file
diff pane. Runs on libgit2 — `diff_tree_to_tree` with 3 lines of context.

Both refs go through `revparse_single`, so anything git can resolve works:
branch names, tags, full or short SHAs, `HEAD~3`, `origin/main^`,
`stash@{0}^1`.

## When you'd use it

"What's on this branch that isn't on main?" — and any variation. It is also the
surface behind clicking a commit, a stash, or an ahead/behind badge, all of
which just open a compare tab with the refs pre-filled.

## How to use it

1. Open one of:
   - `Mod+Shift+C`, or the palette's `Compare branches…`
   - the tab bar's `+` → `New branch compare`
   - the terminal sidebar's `Compare branches` button
   - a file tree context menu's `Compare with <default branch>`
   - the sidebar's ahead/behind pill, a stash label, or a commit row
2. Pick a **Base** and a **Head** ref. Each picker searches branches, tags, and
   the 50 most recent commits; typing something it doesn't recognise and
   pressing Enter uses it as a raw revision expression.
3. Click a file in the tree to see its diff.

### Toolbar

| Control | Effect |
|---|---|
| `Swap base and head` | Reverses the comparison. |
| `Merge-base` toggle | On (default) = three-dot `base...head`, "changes since divergence". Off = two-dot direct diff. |
| `Refresh diff` | Re-runs the diff. |

### Changed-file tree

- `Filter files…` — plain case-insensitive substring, not fuzzy.
- Tree / flat-list toggle.
- Status letters: `A` added, `D` deleted, `M` modified, `R` renamed,
  `C` copied.
- The footer shows the file count and the `+`/`−` totals.
- Single-clicking a folder collapses it; a filter force-opens everything.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+C` | Compare branches… (stands down inside a terminal) |
| `Mod+Shift+D` | Toggle inline / split diff |
| `Mod+W` | Close the compare tab |

Inside a ref picker: `↓` opens and moves down, `↑` moves up without opening,
`Enter` commits the highlight or the raw text, `Esc` closes and clears.

**The changed-file tree has no keyboard handling at all.** The design doc
specified arrow navigation, `Enter` to open, `/` to focus search, and Tab
cycling between panes; none of that shipped.

## Persistence

Compare tabs survive a reload. They are stored in
`localStorage["voidlink-compare-tabs"]` with `id`, `baseRef`, `headRef`,
`useMergeBase`, `selectedFilePath`, `treeMode`, and `treeFilter`. Reopening a
closed compare tab (`Mod+Shift+T`) gives it a fresh id.

The tree pane width (default 320, clamped 220–600) persists too, but **globally**
— one width shared by every compare tab.

## Gotchas and limits

- **Renames are never detected.** `find_similar` is not called anywhere in the
  backend, and `diff_tree_to_tree` does not detect renames by default. The `R`
  and `C` status icons exist but will not fire for a compare diff — a rename
  shows up as an add plus a delete. The design doc promised otherwise.
- **Unrelated histories silently degrade.** With merge-base on, if
  `merge_base()` fails the code falls back to the base commit's own tree — you
  get a two-dot diff with no indication that the toggle didn't apply.
- **Errors are routed to a picker by regex.** The backend prefixes messages with
  `base:` or `head:`, and the UI decides which picker to highlight by testing
  `/\bbase\b/i` and `/\bhead\b/i` against the message. A ref literally named
  `base` or `head` mis-highlights.
- **No caps on diff size.** The entire tree diff, including every line, is
  materialised and sent over IPC. A huge diff is unbounded.
- **The tab does not react to `voidlink:refresh-git`.** Branches created
  elsewhere won't appear in the ref picker until the tab remounts.
- **The diff mode and ignore-whitespace settings are global**, not per compare
  tab.
- **Compact folder chains are one non-splittable row.** A chain like `a/b/c` is
  collapsed into a single row you cannot expand segment by segment. Only
  folders with exactly one folder child collapse — a folder with one file child
  does not.
- **Auto-select picks the first file in backend order**, which is not the sorted
  tree order.
- **Binary files render `Binary file — no diff preview.`**
- **No hunk staging in this pane** — see [git staging](./git-staging.md).
- Clicking a **root commit** from the commit graph opens `<oid>^ .. <oid>`,
  which cannot resolve and produces a `base: could not resolve …` error.
