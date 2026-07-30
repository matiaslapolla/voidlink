# Branches, safe checkout, and sync

## What it does

The Branches pane and the sidebar header: listing and filtering branches,
switching with an automatic stash, creating, renaming and deleting branches, and
fetch / pull / push against a remote. Remotes themselves are managed from a
separate dialog.

## When you'd use it

Everyday branch movement. The one thing worth knowing before you start is that
**switching branches with a dirty tree auto-stashes and never restores** — see
below.

## How to use it

### Switching branches

Click any branch row. That calls `git_safe_checkout`, which:

1. Reads the current branch (or the literal `detached`).
2. Checks whether the tree is dirty, counting untracked files.
3. If dirty, creates a stash named
   `voidlink-auto: pre-switch from <from> → <branch>` with
   `INCLUDE_UNTRACKED`.
4. Resolves `refs/heads/<branch>`, does a **safe** checkout, and moves `HEAD`.

If it stashed, you get a 5-second toast:
`Switched to <name>. Auto-stashed your changes — restore with \`git stash pop\`.`

`KEEP_INDEX` is deliberately **not** used. With it, staged changes stay in the
index and the imminent checkout overwrites them — silently losing staged work.
There is a regression test pinning this.

Checking out also bumps the branch in a per-repo MRU list
(`voidlink-branch-mru` in `localStorage`, capped at 50), which is what orders
the branch list and the compare-tab ref picker.

### Creating, renaming, deleting

- The branch-plus icon prompts `Branch name (created at HEAD, no switch)`.
  Creation does **not** switch to the new branch.
- Hover a local branch for rename (pencil) and delete (X) icons. Both are hidden
  for remote-tracking rows; delete is also hidden for the current branch.
- Deleting an unmerged branch fails with
  `branch '<name>' is not fully merged — force to delete anyway`. The UI detects
  that substring and offers a second confirm, `Force-delete anyway?`.

### Fetch, pull, push

The sidebar header has icons for fetch, pull, manage remotes, refresh, and
collapse. The ahead/behind pill (`↑n` / `↓n`) opens a compare tab against the
upstream.

- **Fetch** uses the remote's configured refspecs, exactly like a bare
  `git fetch`. Toast: `Fetched from origin`.
- **Pull** always runs `git pull --ff-only`. Merge and rebase modes exist in the
  API and the backend but no UI path reaches them.
- **Push** always pushes `refs/heads/<current>:refs/heads/<current>` to
  `origin`.

### Remotes

The cloud icon opens a `Remotes` modal with add / set URL / rename / remove. Add
is two sequential prompts: name, then URL.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+F` | Fetch from origin |
| `Mod+Shift+U` | Pull from origin |
| `Mod+Alt+R` | Refresh git status |
| `Mod+J` | Toggle the git sidebar |

There is no shortcut for push, checkout, or branch creation. Push is a
destructive-ish network operation; leaving it click-only is intentional.

## Authentication

Push and fetch go through libgit2 and share one credential callback that tries,
each **once**:

1. `ssh_key_from_agent` with the username from the URL, defaulting to `git`.
2. `userpass_plaintext("x-access-token", $GITHUB_TOKEN)`.

Then it hard-fails with
`git auth failed: set GITHUB_TOKEN or configure SSH agent`. Each method is tried
at most once so a failure surfaces a clear error instead of looping.

**`git pull` and tag push do not use this path.** They shell out to the system
`git` and rely on your configured credential helper. So pull can succeed while
push fails, or the reverse.

## Gotchas and limits

- **Nothing ever pops the auto-stash.** The backend's own doc comment describes
  an `auto_pop` parameter that does not exist in the signature. Switch back and
  your work is still in the stash list — run `git stash pop`, or use the Stashes
  pane.
- **Checkout errors are not toasts.** They render as red text under the branch
  filter box.
- **Push errors render under the commit box**, not as a toast.
- **Push cannot force.** No `--force`, no `--force-with-lease` — a diverged
  branch just errors. It *can* set upstream (only when absent; it never
  clobbers an existing one).
- **`origin` is hard-coded** for the repo header's remote URL, for push, and for
  tag push. **Fetch is not**: with no remote named it fetches every configured
  remote, and prunes.
- **New branches get no upstream.** `git_create_branch` creates the ref only.
- **A deleted upstream ref reads as "unknown", not as "no upstream"** — the row
  shows `?` when `branch.<name>.remote`/`.merge` still name one whose ref is
  gone.
- **`origin/HEAD` is filtered out of the branch list.** It is a symbolic pointer
  at the remote's default branch, not a branch: it could never be checked out,
  and its context menu used to offer a merge that silently operated on
  `origin/main` under a misleading name.
- **The unborn branch is listed.** A fresh `git init -b main` shows `main` with
  no commit behind it.
- **Deleting a branch is refused during a rebase, merge or cherry-pick**, in the
  backend rather than only by a disabled button — HEAD is detached during a
  rebase, so the "is this branch checked out?" guard does not fire and the
  replayed commits would be reachable only from the reflog.
- **The "is it merged?" test compares against every branchy ref**, not just
  `HEAD`, and skips only the branch itself and its own remote counterparts.
- **Conflict detection after a pull asks the index for unmerged paths**, not
  git's prose, so it is locale-independent.
- **`git_checkout_branch`, the non-stashing variant, is called by `StackTab`.**
- **Remotes:** URLs and names are validated before they reach libgit2, which
  otherwise accepts any string as a URL. Adding a remote fetches it immediately
  — without that, adding one produced no visible change at all. Removing one
  warns that every branch tracking it loses its upstream.
- **The Remotes dialog is reachable only from the workbench sidebar.** The
  standalone git window has no fetch, pull, push or remotes controls.
- **Branch filtering is fuzzy** (substring first, then in-order subsequence);
  the branch list is sorted HEAD-first, then by MRU, then alphabetically.
- **The branch context menu is attached to every row, including remotes** — so
  `Merge origin/foo into current` is offered and works, even though checking out
  that same row does not.
