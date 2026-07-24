# Stacked PRs

## What it does

Graphite-style stacked branches: each branch records a parent, the stack is
discovered by walking those pointers up to a trunk, and the whole chain can be
replayed onto a moved trunk (**restack**) or pushed to GitHub as one PR per
branch (**submit**).

## When you'd use it

When a change is too big for one PR and you want reviewable slices that each
build on the last.

## Where the metadata lives

Entirely in `.git/config`. No refs, no notes, no sidecar file.

| Key | Meaning |
|---|---|
| `branch.<name>.parent` | This branch's parent in the stack. |
| `branch.<name>.parentbase` | The parent tip this branch was last replayed onto. |
| `branch.<name>.prnumber` | The GitHub PR number, once submitted. |
| `voidlink.stack.trunks` | Repo-level, comma-separated trunk overrides. |

The trunk set is the union of the built-in defaults `main`, `master`,
`develop`, `trunk`, whatever is in `voidlink.stack.trunks`, and the symbolic
target of `refs/remotes/origin/HEAD`.

Because it is all plain config, you can inspect and repair a stack by hand:

```bash
git config --get-regexp '^branch\..*\.(parent|parentbase|prnumber)$'
git config --unset branch.feature/x.parent   # untrack
```

## How to use it

### Starting a stack

With no stack, the sidebar's Stack section shows `Not on a stack.` and a button
`Start stack on top of current`. That prompts for a name and creates a child
branch off the current one.

`Mod+Shift+N` (`Stack: Branch on top of current`) does the same thing from
anywhere.

### Working in a stack

The sidebar shows the chain bottom-up, `◉` marking `HEAD`, `└` marking the
trunk, `↑n` for commits ahead of the parent, and the bare PR number when one
exists. `Open tab` opens the full stack workspace.

In the stack tab each row has `Switch`, `Branch` (create a child here),
`Restack`, and an overflow menu with `Copy branch name` and
`Untrack from stack`.

### Restacking

When a parent moves, the sidebar shows `Parent moved — needs restack.` and the
tab shows a `needs restack` badge. `Restack all` replays every branch onto its
parent's current tip.

Restack is **100% in-memory libgit2** — no `git` binary, no working-tree
mutation. Per branch:

- No recorded parent → error.
- `parentbase` already equals the parent tip → skipped,
  `parentbase matches parent tip`.
- Merge base already equals the parent tip → skipped, `branch already on parent`
  (and `parentbase` is written).
- Otherwise each commit is replayed with an in-memory `cherrypick_commit`,
  preserving the original author.

**On conflict, nothing is mutated.** No ref moves, no index is written, no
`CHERRY_PICK_HEAD` appears. You get the conflicting commit and the list of
paths, and the run stops at the first conflicted branch.

On success the branch ref is moved with reflog message `voidlink: restack`; if
it is the current branch a **force** checkout brings the tree forward.

### Submitting

`Submit stack` creates or updates one draft PR per branch, top-down. It needs
`GITHUB_TOKEN` exported in the environment — that is the only auth path; no
keychain, no `gh` CLI, no `.netrc`.

For each branch it lists open PRs with that head, then either `PATCH`es the
existing one (updating `base` when it drifted) or `POST`s a new draft PR titled
with the branch name verbatim. Every PR body gets an identical footer between
sentinel comments:

```
**Stack** (top → bottom):

- `feature/c`
- `feature/b`
- `feature/a`

_managed by voidlink — edits inside this block are overwritten_
```

### Trunk overrides

**Settings → Stack** takes a comma-separated list under `Overrides`. The
built-in defaults and `origin/HEAD` always apply on top of whatever you set.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+N` | Stack: branch on top of current |

`Stack: restack all`, `Stack: submit to GitHub`, and
`Stack: open stack workspace` are palette-only. Restack rewrites branch refs and
submit hits the network — neither should be one accidental keystroke away.

## Gotchas and limits

- **Restack refuses to run at all with a dirty tree**, aborting the whole
  command with
  `working tree has uncommitted changes — commit or stash before restacking`.
  The UI surfaces that as a raw error toast rather than per-branch results.
- **The conflict banner in the stack tab is wrong.** It claims the working tree
  now holds a partial cherry-pick with conflict markers. It does not — restack
  is in-memory. The per-path "resolve" buttons therefore open a conflict tab on
  a file with no index stages and no markers, which immediately reports itself
  fully resolved. Resolve stack conflicts in a terminal and re-run restack; the
  banner says as much in its footer.
- **There is no "continue restack".** The design doc promised one; only
  `Dismiss` shipped.
- **Untracked files can be clobbered.** The dirty check excludes untracked
  files, but the post-restack checkout of the current branch is a **force**
  checkout.
- **Submit never pushes.** An unpushed branch surfaces as
  `422 — branch likely not pushed to origin yet`. Push first.
- **Submit is GitHub-only.** The origin URL must parse as a GitHub remote;
  GitLab and Bitbucket are rejected.
- **A branch without a `parent` key fails the entire submit**, not just its own
  row, with `branch '<name>' is not in a stack`.
- **Only open PRs are considered.** A branch whose PR was closed is treated as
  PR-less, so submit tries to create a new one and usually gets a 422.
- **`prnumber` is only written for created and updated PRs.** A pre-existing,
  correctly-based PR reports `no change` and stays badge-less.
- **`git_stack_create_branch` can leave an orphan.** The branch is created
  before the trunk guard runs, so naming a new stack branch `develop` creates
  the branch and *then* errors with
  `'develop' is a trunk — refusing to record it as a stack child`.
- **A stack that never reaches a trunk gets a synthetic one.** The bottom-most
  recorded parent is surfaced as the trunk, so the UI can show a "trunk" that
  isn't one.
- **A branch with two tracked children produces two stacks** that share their
  lower half — one per leaf.
- **A cycle in the parent pointers** aborts with
  ``stack contains a cycle at branch `x` — fix `.git/config` manually``. Depth is
  capped at 50.
- **Drift detection has two disagreeing sources.** `needsRestack` compares
  `parentbase` against the parent tip; the sidebar uses "commits behind parent"
  as a proxy. If `parentbase` was never written, drift is invisible to the
  former.
- **Several source comments are stale**, describing the module as read-only
  scaffolding and restack/submit as unimplemented. They shipped.
