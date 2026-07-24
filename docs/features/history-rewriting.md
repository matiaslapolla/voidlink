# Merge, rebase, cherry-pick, revert, reset, stash, tags

## What it does

The history-changing half of the git suite. Merge, rebase, cherry-pick and
revert **shell out to the system `git`**; reset, amend, stash and tags run on
libgit2.

The split is deliberate, and documented in the source: porcelain operations
whose conflict mid-states libgit2 either doesn't model or models differently
from what users expect go through the real `git` binary.

## When you'd use it

Integrating a branch, replaying a commit, undoing something, or parking work.

## How to use it

### Merge and rebase

Right-click a branch row in the Branches pane:

| Item | Runs |
|---|---|
| `Merge <name> into current` | `git merge --no-edit <name>` |
| `Merge <name> (--no-ff)` | `git merge --no-edit --no-ff <name>` |
| `Rebase current onto <name>` | `git rebase <name>` |

All three fire immediately — **there is no confirmation.**

If the result contains conflicts you get a 6-second warning toast,
`<label> stopped on conflicts — resolve them, then continue.`, and every
conflicted path opens as a tab. See [conflicts](./conflicts.md).

### Cherry-pick, revert, reset

Right-click a commit in the History pane:

| Item | Runs |
|---|---|
| `Cherry-pick onto current` | `git cherry-pick <oid>` |
| `Revert commit` | `git revert --no-edit <oid>` |
| `Create tag here…` | libgit2 tag at that commit |
| `Reset (soft) to here` | soft reset |
| `Reset (mixed) to here` | mixed reset |
| `Reset (hard) to here` | hard reset, styled as destructive |

Cherry-pick and revert have **no confirmation**. Resets do — and a hard reset
asks twice:

1. `Hard reset to <sha>? This DISCARDS all uncommitted changes and cannot be undone.`
2. `Really discard all uncommitted work? Last chance.`

### Stash

Create from the archive icon in the Changes pane. The Stashes section lists
them, each with three hover buttons: `Apply (keep stash)`,
`Pop (apply and remove)`, and `Drop stash`. Drop confirms with
`Drop stash "<message>"? This cannot be undone.`

Clicking the stash label opens a compare tab of `stash@{n}^1 .. stash@{n}`.

### Tags

The Tags section's `+` prompts for `Tag name (created at HEAD)` with an
`Annotated tag (with message)` toggle; annotated tags get a second prompt for
the message. Per-tag hover buttons push to origin or delete locally.

## Keyboard shortcuts

None. Every operation in this document is click-only, and that is deliberate —
they rewrite history or move refs. The command palette does expose
`Undo last commit (soft)`.

## Gotchas and limits

- **No interactive rebase.** Nothing passes `-i`. Use a terminal.
- **No `--onto`.** `git_rebase(repo, onto)` is misleadingly named — the
  parameter is git's positional *upstream* argument, not `git rebase --onto`.
- **No `--skip`** during a conflicted operation. Continue or abort only.
- **Merge, rebase, cherry-pick, and revert never confirm.** Reset, undo,
  stash-drop, tag-delete, branch-delete, worktree-remove, and discard all do.
  Same sidebar, two different safety levels.
- **The palette's `Undo last commit (soft)` has no confirmation**, while the
  sidebar's `Undo commit` button for the same operation does.
- **Rebase can be started with a dirty tree.** There is no guard; you get git's
  own error in a toast.
- **The initial `rebase` and `cherry-pick` do not set `core.editor=true`** —
  only the `--continue` variants do. `merge` and `revert` use `--no-edit`. A
  rebase that wants an editor will block.
- **`git` is invoked bare, from `PATH`.** If it isn't there you get
  `failed to run git: <e>. Is git installed and on PATH?`
- **Reset mode is not validated.** Anything that isn't `soft` or `hard` silently
  becomes a mixed reset.
- **Amend rewrites the index tree**, not `git commit --amend` semantics over the
  working tree — unstaged changes are not included. A blank message keeps the
  original.
- **Undo on a root commit** fails with `no parent commit to undo to`.
- **Tags are never forced.** Re-tagging an existing name errors and there is no
  force affordance. Tag push only ever targets `origin`, and there is no
  delete-on-remote.
- **Tags are read from the general ref list**, not from a tag-specific command.
- **Stash apply and pop pass no options** — no `REINSTATE_INDEX`, so staged-ness
  is not restored. They are also indexed by **position**, and the list only
  refetches on the global git-refresh pulse, so indices shift after a pop or
  drop.
- **`git_stash_show` is dead code.** Clicking a stash opens a compare tab
  instead; the command exists but has no frontend caller. It would also fail for
  a stash with no `^1`.
- **The auto-stash created by branch switching is a different mechanism.** See
  [branches and sync](./branches-and-sync.md) — nothing ever pops it.
- **Conflict classification is an English substring match** on `CONFLICT`.
