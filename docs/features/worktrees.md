# Worktrees

## What it does

Lists the repo's git worktrees with live status badges, creates a new one for a
branch, opens any of them as a VoidLink workspace, and removes them. It shells
out to `git worktree` for everything.

## When you'd use it

To have two branches checked out at once — reviewing a PR while your feature
work stays untouched, or running a long build against `main` while you keep
editing.

## How to use it

The **Worktrees** section of the git sidebar. It is **collapsed by default**, so
the badges are invisible until you open it.

### Creating

1. Click `New worktree`.
2. Enter a branch name at the prompt
   `Branch for the worktree (existing or new)`.
3. The directory path defaults to `.worktrees/<slug>` **inside** the
   repository, and the field is editable if you want it elsewhere. A branch
   `feature/x` in `/repos/app` produces `/repos/app/.worktrees/feature-x`.
   Slashes in a branch name collapse to dashes so the worktree stays one
   directory deep.
4. Afterwards you're asked `Open worktree "<branch>" as a new workspace?` —
   accepting creates a new workspace pointed at that directory.

### Workspace naming

Picking a repository for a workspace renames it after that repository: the
remote's repo name when there is one (`git@github.com:me/voidlink.git` →
`voidlink`), otherwise the root folder's basename. The remote wins because a
linked worktree at `.worktrees/feature-x` would otherwise be labelled
`feature-x`.

This only ever replaces a name **VoidLink** invented — `Workspace 3`, or the
initial `Main`. Rename a workspace yourself (double-click it in the rail) and
that name is kept, including through later repo changes.

Keeping worktrees inside the repository means one place to find them and one
directory to delete, and it survives moving the repo. It does depend on
`.worktrees/` being ignored — an unignored directory here would turn every
linked worktree into untracked files in `git status`. The wizard checks the
repo's ignore rules and, when the rule is missing, offers a one-click
`Add .worktrees/ to .gitignore` before you create anything.

Whether the branch is treated as existing or new is decided client-side against
the **local** branch list, then dispatched as:

| Case | Command |
|---|---|
| New branch | `git worktree add -b <branch> <path>` |
| Existing branch | `git worktree add <path> <branch>` |

### Status badges

Each row shows, in order:

| Badge | Meaning |
|---|---|
| Primary-coloured dot instead of the folder icon | This is the current worktree. |
| `●` in warning colour | Uncommitted changes. |
| `↑n` in success colour | n commits ahead of upstream. |
| `↓n` in destructive colour | n commits behind upstream. |
| `?` in muted colour | Its status could not be read — the directory may be gone or on an unmounted volume. **Not** the same as clean. |
| `missing` in destructive colour | Git would prune it: the directory no longer exists. Opening is disabled. |
| Lock icon (a button) | The worktree is locked. Click to unlock it. |
| `main` badge | The first worktree git reports. |

Dirty state comes from `git status --porcelain` run **inside that worktree**;
ahead/behind from
`git rev-list --left-right --count @{upstream}...HEAD`, also inside it. Every
enrichment call is best-effort — a failure leaves the field at its default and
never breaks the listing.

### Removing

All three entry points — the X on a sidebar row, the rail's context menu, and
the palette's `Remove current worktree…` — run the same flow, in
`commands/worktreeRemove.ts`. It confirms with
`Remove worktree "<label>"? Its directory will be deleted.`, runs
`git worktree remove <path>`, then a best-effort `git worktree prune` whose
failure is surfaced as a warning rather than dropped.

If git refuses, the reason decides what is offered:

| Refusal | What happens |
|---|---|
| Uncommitted work | Asks before `--force`. |
| Locked | Offers to `git worktree unlock` first, then retries. |
| Anything else (permissions, a main working tree, a missing directory) | Reports the error. Force is **not** offered, because it cannot help. |

Every exit emits a refresh pulse, so the other surfaces stop listing a worktree
that is gone.

## Keyboard shortcuts

No dedicated chords, but the command palette (`Mod+K`) carries the whole set:
`New worktree…`, `Next worktree`, `Previous worktree`, and
`Remove current worktree…`.

## Gotchas and limits

- **Two branches that slugify the same collide.** `feature/x` and `feature-x`
  both land on `.worktrees/feature-x`, and the resulting
  `path already exists: <path>` is unrecoverable from the UI. Edit the
  Directory field to break the tie.
- **A remote-only branch is treated as new.** The existence check only looks at
  local branches, so `origin/feature/x` gets `worktree add -b feature/x`, which
  creates a fresh local branch off `HEAD` instead of a tracking branch off the
  remote.
- **`main` is positional, not semantic.** It is whichever record
  `git worktree list --porcelain` emits first, which is the main working tree —
  not "the worktree on the `main` branch". The badge text is a coincidence.
- **Ahead/behind is against `@{upstream}`**, not against the main worktree's
  branch. No upstream means a silent `0/0`, which the UI renders identically to
  "in sync" because zero-valued badges are hidden.
- **Listing costs 2N+1 subprocesses** — one `worktree list` plus a `status` and
  a `rev-list` per worktree. The per-worktree half runs concurrently, capped at
  8 at a time, and concurrent callers share one round trip. It still re-runs on
  every git-refresh pulse, and there is no cache.
- **Opening a worktree as a workspace does not switch to it explicitly.** It
  adds a workspace and sets its repo root. From the standalone git window it is
  forwarded to the workbench, which is the only window with a rail.
- **No `worktree move` and no `worktree repair`.** `list`, `add`, `remove`,
  `unlock` and `prune` are exposed; the rest are not.
- **Porcelain is parsed without `-z`**, so a path containing a newline splits
  into a phantom row.
- **Creating one re-lists everything** just to return the new row, re-running
  the whole enrichment pass.
