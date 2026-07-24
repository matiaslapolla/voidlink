# Conflict resolution

## What it does

Detects an in-progress merge, rebase, cherry-pick, or revert; surfaces the
conflicted files; and gives you a per-conflict-block resolver with
`Accept ours` / `Accept theirs` / `Accept both`, plus a raw-text escape hatch.

## When you'd use it

Whenever a merge, rebase, cherry-pick, revert, or pull stops on conflicts. The
git sidebar routes all of those into this flow automatically, opening one tab
per conflicted path.

## How to use it

### The operation banner

When an operation is in progress, a banner appears at the top of the git
sidebar reading `<Operation> in progress`, plus `· conflicts` when there are
any. It has two buttons:

- `Continue` — runs the operation's `--continue`. **Hidden entirely for
  merges**, because merge has no `--continue`; finishing a merge is just a
  commit. If conflicts remain, Continue instead warns
  `Resolve all conflicts first, then continue.` and auto-opens every remaining
  conflicted file.
- `Abort` — always available.

For a merge with no conflicts, the text `Commit to finish.` appears where
Continue would be.

### The conflict tab

Each conflicted file opens as its own tab showing:

- A header with the file name, full path, and an `n unresolved` counter.
- One card per conflict block: `Conflict i / n · lines a–b`, side-by-side
  `Ours (<label>)` and `Theirs (<label>)` panes, and a
  `Common ancestor (base)` pane when diff3 markers are present.
- Three buttons per block: `Accept ours`, `Accept theirs`, `Accept both`.
- A collapsed `Raw file (advanced — edit conflict markers manually)` textarea.
- A reset button, `Reset to working-tree version`.

Once every block is resolved, the cards are replaced by
`All conflict markers resolved. Review the file and stage.` over a full-file
textarea.

`Mark resolved & stage` writes the buffer to disk and adds the path to the
index — staging a previously-conflicted path is what clears the conflict, so
there is no separate resolve step. Then go back to the banner and press
`Continue` (or commit, for a merge).

## Keyboard shortcuts

None. There is no shortcut to open a conflict tab, to accept a block, or to
continue an operation. Conflict tabs close with `Mod+W` like any other tab.

## How detection works

Operation kind is read from marker files under the git directory, in this fixed
order:

| Marker | Reported as |
|---|---|
| `MERGE_HEAD` | `merge` |
| `rebase-merge/` or `rebase-apply/` | `rebase` |
| `CHERRY_PICK_HEAD` | `cherry-pick` |
| `REVERT_HEAD` | `revert` |

Because `MERGE_HEAD` is tested first, a revert or cherry-pick that also leaves
`MERGE_HEAD` reports as a merge.

Conflicted *paths* come from a separate status walk filtering
`is_conflicted()`, returning repo-relative paths, sorted.

## Gotchas and limits

- **Resolution is marker-driven, not index-driven.** The UI parses `<<<<<<<`,
  `|||||||`, `=======`, and `>>>>>>>` out of the working-tree text. The
  ours/theirs/base blobs are fetched from the index but are **never used** by
  the accept buttons — only the working-tree content seeds the buffer.

  Consequence: a **delete/modify** conflict, an **add/add** conflict, a
  **binary** file, or any conflict written without markers presents as
  `0 unresolved` and drops straight to the resolved pane. Those need a terminal.
- **Malformed markers are silently skipped.** A `<<<<<<<` with no matching
  `>>>>>>>` just advances the parser, so an unresolvable region can be reported
  as fully resolved.
- **Label parsing is a fixed slice** — exactly 7 marker characters plus a space.
  It falls back to `ours` / `theirs` when that yields nothing.
- **The buffer is only re-seeded on explicit reset.** An external change to the
  file on disk won't show up.
- **`Mark resolved & stage` does not advance the operation.** You must return to
  the banner.
- **The conflict impls use `Repository::open`, not `discover`** — the repo path
  has to be the exact repo root, unlike most of the git surface.
- **Bare repos** return `bare repos can't have conflicts` /
  `bare repos can't be resolved`.
- **No `--skip`.** The banner offers only Continue and Abort.
- **`--continue` runs with `-c core.editor=true`** so it can't block waiting for
  an editor. The *initial* rebase does not, so a rebase that wants an editor
  will hang.
- **Conflict classification is an English substring match** on `CONFLICT` in
  git's combined stdout+stderr. Under a non-English locale a conflict is
  misreported as a plain failure.
- **The stack tab's conflict banner is wrong about the working tree.** It says
  the tree "now contains the partial cherry-pick with conflict markers", but
  restack uses an in-memory cherry-pick and mutates nothing — so the per-path
  buttons open a conflict tab on a file with no index stages and no markers,
  which immediately reports itself resolved. See
  [stacked PRs](./stacked-prs.md).
