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
   the 50 most recent commits — seeded from local branches, remote-tracking
   branches, tags and HEAD, so a commit that just arrived on `origin/main` is
   findable without making a local branch for it. When HEAD is detached, it is
   offered as `HEAD` with the commit it is sitting on. The picker opens with the
   current ref in the box, selected, so it can be edited rather than retyped;
   typing something it doesn't recognise and pressing Enter uses it as a raw
   revision expression.
3. Click a file in the tree to see its diff.

### Toolbar

| Control | Effect |
|---|---|
| `Swap base and head` | Reverses the comparison. |
| `Merge-base` toggle | On (default) = three-dot `base...head`, "changes since divergence". Off = two-dot direct diff. |
| `Ignore WS` toggle | Ignores whitespace-only changes. Per tab — see below. |
| `Inline` / `Split` | Diff render mode. Per tab, render-only — never refetches. |
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
| `Mod+W` | Close the compare tab |

`Mod+Shift+D` ("Toggle inline / split diff") no longer reaches a compare tab.
It flips the global `diffMode` pref the working-tree diff toolbar uses, and
compare tabs stopped reading that pref when diff mode became per-tab — use the
tab's own `Inline` / `Split` toolbar control instead.

Inside a ref picker: `↓` opens and moves down, `↑` moves back up and out of the
list, `Enter` commits the highlight or — with nothing highlighted — the raw
text, `Esc` closes and clears without reaching the tab behind it. A freshly
opened picker highlights nothing, so the first `↓` lands on the first item.

**The changed-file tree has no keyboard handling at all.** The design doc
specified arrow navigation, `Enter` to open, `/` to focus search, and Tab
cycling between panes; none of that shipped.

## Persistence

Compare tabs survive a reload. They are stored in
`localStorage["voidlink-compare-tabs"]` with `id`, `baseRef`, `headRef`,
`useMergeBase`, `selectedFilePath`, `treeMode`, and `treeFilter`. Reopening a
closed compare tab (`Mod+Shift+T`) gives it a fresh id.

The tree pane width (default 320, clamped 220–600) persists per tab.

`diffMode` and `ignoreWhitespace` persist per tab too, and only when set away
from their default (`"inline"`, `false`) — a tab that never touched either
control serializes exactly as it did before these existed, the same narrow-blob
convention the browser tab's `zoom` uses.

## Gotchas and limits

- **Unrelated histories silently degrade.** With merge-base on, if
  `merge_base()` fails the code falls back to the base commit's own tree — you
  get a two-dot diff with no indication that the toggle didn't apply.
- **Errors are routed to a picker by prefix.** The backend answers `base:`,
  `head:` or `repo:` at the *front* of the message and the UI anchors on that,
  so a ref named `origin/base-fix` in the head field highlights only the head
  field, and a repository that will not open highlights neither.
- **Very large files are capped.** A file past 20,000 stored lines, or a diff
  past 200,000 across all files, stops carrying line content and says so in the
  pane. The `+`/`−` counts keep counting past the cap, so the tree rows and the
  footer still report the real size of the change.
- **Renames and copies *are* detected** (`find_similar`), and a typechange is
  one delta rather than an add/delete pair sharing a path.
- **A stash compare includes its untracked files.** `stash@{N}^1..stash@{N}`
  cannot reach them — they live in a third parent — so this one pairing is
  widened to match `git stash show -u`. Any other pair of refs gets plain
  two-tree semantics.
- **Ignore-whitespace is a diff option, not a filter.** A whitespace-only change
  disappears from the file list entirely, exactly as `git diff -w` does, so the
  tree, the counts and the body always describe the same diff. A mode-only
  change survives it and renders an explanation rather than a blank pane.
- **Diff mode and ignore-whitespace are per compare tab**, deliberately not the
  global `diffMode`/`ignoreWhitespace` prefs the working-tree diff toolbar
  drives — those still exist and still apply there. `ignoreWhitespace` sits in
  the diff resource's key, so flipping one tab's toggle refetches exactly that
  tab; a shared global toggle would instead refetch every open compare tab at
  once, each re-running a full diff behind the same per-repo git mutex the
  compare payload budget (CMP-F10) exists to bound. `diffMode` is render-only
  and never touches the key, so switching it never refetches anything.
- **Compare tabs dedupe** on (base, head, merge-base). Ten clicks in the commit
  graph reuse one tab; a blank picker tab is exempt.
- **Folder expand/collapse survives a refetch**, because the state is keyed on
  the node rather than living in rows that are rebuilt on every pulse. Folder
  keys carry a trailing slash, so a commit that turns `swap` into `swap/` leaves
  two rows that can be collapsed and selected independently.
- **Compact folder chains are one non-splittable row.** A chain like `a/b/c` is
  collapsed into a single row you cannot expand segment by segment. The rule is
  that a folder with exactly one *folder* child merges into it, so
  `src/main/Foo.java` is one folder row `src/main/` and one file row. What does
  not happen is a folder swallowing the file underneath it — the file is what
  gets clicked. `a/b` and `a/c` also stay three rows, because `a` has two
  children and merging there would lose the fact that they are siblings.
- **Auto-select picks the first file in backend order**, which is not the sorted
  tree order.
- **Binary files render `Binary file — no diff preview.`**
- **No hunk staging in this pane** — see [git staging](./git-staging.md).
- Clicking a **root commit** from the commit graph or the sidebar diffs it
  against git's empty tree, which is what it introduced. Two other call sites
  (`EditorApp`, `MainSurface`) still build `<oid>^` from a bare SHA found in
  text and still fail on a root commit — they have no parent list to hand.
