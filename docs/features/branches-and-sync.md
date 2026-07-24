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
- **Clicking a remote-tracking branch fails.** The list includes remotes and
  their rows are clickable, but safe checkout only resolves `refs/heads/<name>`,
  so `origin/foo` becomes `refs/heads/origin/foo` and errors. There is no
  detached-HEAD or create-tracking-branch path.
- **Checkout errors are not toasts.** They render as red text under the branch
  filter box.
- **Push errors render under the commit box**, not as a toast.
- **Push cannot force, cannot set upstream, and cannot push to a
  differently-named remote branch.** No `--force`, no `--force-with-lease`, no
  `-u`.
- **`origin` is hard-coded** for the repo header's remote URL, for fetch, for
  push, and for tag push.
- **New branches get no upstream.** `git_create_branch` creates the ref only.
- **The "is it merged?" test for delete compares against `HEAD`**, not against
  the branch's upstream, despite the doc comment saying otherwise. A branch
  merged into `origin/main` but not into your current branch reads as unmerged.
- **Conflict detection after a pull is an English substring match** on
  `CONFLICT` in git's combined output. Under a non-English locale a conflicted
  pull is reported as a plain failure.
- **`git_checkout_branch`, the non-stashing variant, still exists** and is
  registered and exposed on the TS API, but nothing in the UI calls it.
- **Branch filtering is fuzzy** (substring first, then in-order subsequence);
  the branch list is sorted HEAD-first, then by MRU, then alphabetically.
- **The branch context menu is attached to every row, including remotes** — so
  `Merge origin/foo into current` is offered and works, even though checking out
  that same row does not.
