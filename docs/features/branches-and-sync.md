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

### The ahead/behind chip on a branch row

A row carries `↑n ↓n` when there is something to count against. **What it counts
against depends on the kind of row**, and the row's tooltip always spells it out
in full — `origin/feat is 2 ahead of and 0 behind local feat`.

- **A local branch** is counted against its **upstream**, as it always has been.
  A zero side is hidden: `main` in sync draws nothing, because most local rows
  most of the time have nothing to report and `↑0 ↓0` on all of them is noise.
- **A remote-tracking branch** is counted against the **local branch of the same
  name** — `origin/feat` against `feat`. The question it answers is "have I
  pulled what is up there, and have I pushed what is down here": the local row's
  question from the other side, so the *remote* row is the subject. `↑` is what
  the remote has that you do not (pull it); `↓` is what you have that the remote
  does not (push it). Both sides are always shown, zero included, because on a
  remote row "you have pulled everything" is precisely the answer you opened the
  Remote disclosure to get.
- **A remote-tracking branch with no local branch of that name shows no chip at
  all** — not a zero, not a dash. There is nothing to compare it to, and `↑0 ↓0`
  there would claim to be in sync with a branch that does not exist.

The name match handles slashes: `origin/feature/x` is compared to local
`feature/x`, not to a local `x`. The remote prefix is stripped by matching the
repository's configured remotes, so a remote whose own name contains a slash
works too.

Under the hood this is `AheadBehind { ahead, behind, against }`, and it is
**nullable on the row** — that is what keeps "nothing to compare against" and
"compared, and level" apart. It is also cheap in the right way: the walk is only
run for a remote branch that *has* a local counterpart, and identical tips
short-circuit without a walk. On a repository with 500 remote branches, the cost
scales with how many branches **you** have checked out, not with how many your
colleagues have pushed.

A branch whose upstream is configured but unresolvable still shows `?`
(`aheadBehindUnknown`) — a walk that could not complete must never be drawn as
`0/0`.

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
  `origin`. It reports *how* it failed, not only that it did — see below.

### When a push is rejected

`git_push` answers a `PushOutcome`, and its `failure` field is one of
`non-fast-forward`, `auth` or `other`. Everything about the force-push surface
hangs off that classification:

- `non-fast-forward` comes from libgit2's own `NotFastForward` error code (it
  checks fast-forwardability against the advertised remote head and refuses
  before uploading a pack), or from a server rejection whose reason contains
  `non-fast-forward` / `fetch first` once separators are stripped.
- Everything else — a missing remote, a transport error, a pre-receive hook, a
  ref lock, an exhausted credential callback — is `auth` or `other`.

Only `non-fast-forward` shows the recovery panel under the commit box:

```
✗ origin rejected the push — origin/feat has commits your branch does not.

  [ Fetch and rebase ]   [ Force push (with lease) ]
```

**Fetch and rebase is the first offer** — `git pull --rebase`, with the usual
conflict routing into conflict tabs. **Force is the second**, and it is disabled
until a lease is held.

### Force-push, and what "with lease" means here

Force-push exists in exactly one place: that panel. It is not beside Push, not
in an overflow, not on a context menu. The rejection is what proves the branches
diverged, so the button only exists in the moment it is the answer.

On mounting, the panel fetches the rejecting remote and reads
`refs/remotes/<remote>/<branch>`. That oid is the **lease**. Force stays disabled
until it lands, and it goes disabled again **two minutes later**
(`LEASE_TTL_MS`), with a `Fetch again` link. The expiry is not about the remote —
the remote can move a millisecond after the fetch, and only the re-check below
covers that. It is about the lease still describing something the user actually
looked at.

The confirm names the remote, the branch, how many commits stop being reachable
(`behind`, after the fetch), and the oid being overwritten.

`git_push_force_with_lease` then re-checks before pushing: it fetches that one
branch with pruning, compares the result against the lease, and **refuses** if
the remote moved, if the branch is gone, or if no lease was supplied. A refusal
is the feature working — it names both oids and re-takes the lease so you can
see what changed.

**The race window is real and is not closed.** libgit2 has no
`--force-with-lease` primitive: native git puts the expected old oid in the
ref-update line so the *server* does the compare-and-swap, and libgit2's push API
gives no way to set that field. So the comparison happens client-side, and
anything that lands on the remote between the re-check's ref advertisement and
receive-pack applying our update is overwritten unseen. That is one fetch round
trip plus the push connection — a fraction of a second, not zero. Nothing in the
UI says "safe" about it.

(The advertisement is read via a fetch rather than `Remote::list()` on the push
connection, which would be one round trip tighter: `list()` in git2 0.19 builds
a slice from the null pointer libgit2 returns when a remote advertises no refs,
which aborts the process under debug assertions. A safety check that can crash
is not a safety check.)

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
each **once**, in the order git itself would:

1. `Cred::credential_helper` against the default config cascade — `osxkeychain`,
   `gh auth`, `git-credential-manager`, whatever `credential.helper` names.
2. `ssh_key_from_agent` with the username from the URL, defaulting to `git`.
3. `userpass_plaintext("x-access-token", $GITHUB_TOKEN)`.

Then it hard-fails with `auth::AUTH_EXHAUSTED_MESSAGE`. Each method is tried at
most once so a failure surfaces a clear error instead of looping. That message
is a constant rather than a literal because `push.rs` classifies a failure as
`auth` by it: libgit2 reports an error raised *inside* a callback with a generic
code, so the string is the only discriminator — and it only works as one while
exactly one place writes it.

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
- **Force-push is unreachable except from a rejection.** There is no plain
  `--force` anywhere, and the leased force is only offered under a
  `non-fast-forward` failure. Push *can* set upstream (only when absent; it
  never clobbers an existing one).
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
