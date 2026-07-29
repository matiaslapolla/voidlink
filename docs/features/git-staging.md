# Staging, committing, and hunk-level apply

## What it does

The Changes pane of the git sidebar: file status, staging, discarding,
committing, amending, and stashing. Plus hunk-level staging and discarding from
the diff view — the equivalent of `git add -p` and `git checkout -p`.

All of it runs on libgit2. Nothing here shells out to a `git` binary.

Every command serializes per repository: one mutex keyed by the shared git dir,
held for the whole command, plus retry-with-backoff when an external `git`
process holds `index.lock`. A click that fans out into a dozen reads no longer
interleaves them inside libgit2's read-modify-write of the index.

## When you'd use it

The default loop: review what changed, stage the parts you want, write a
message, commit.

## How to use it

### Staging

- Click a file row in **Changes** to open its diff.
- Hover a row and click `+` to stage it, or the trash / undo icon to discard it.
  The icon is a trash can with title `Delete untracked file` when the file is
  untracked, and an undo arrow with title `Discard changes` otherwise.
- The `+` in the pane header is `Stage all`.
- In the **Staged** list, `-` unstages.

Staging a *deleted* file works because the backend checks whether the path
exists on disk: present → `index.add_path`, absent → `index.update_all`, which
re-reads the working tree rather than trusting an earlier answer (the old
`remove_path` raced the status read, so a file recreated in between was staged as
deleted).

### Hunk-level

Open a file's diff, hover a hunk header, and three buttons appear:

| Button | Effect |
|---|---|
| `Stage hunk` | Applies just that hunk to the index. |
| `Discard` | Reverse-applies it to the **working tree**. Confirms first. |
| `Copy` | Copies the hunk as a fenced markdown block, headed with the path and the `@@` line. |

Staging works by serialising the single hunk back into a unified patch and
handing it to libgit2's `apply` against `ApplyLocation::Index` — the same trick
`git add -p` uses internally. Discard builds the inverted patch and applies it
to `ApplyLocation::WorkDir`.

### Committing

1. Type into the commit box.
2. `Mod+Enter` inside the box, or click the button — it reads
   `Commit (n)` with the staged count.
3. Every commit runs through the [secret scan](./secret-scan.md) first.

Tick `Amend last commit` to amend instead. Amend pre-fills the box with the
previous commit's **summary line**.

`Undo commit` does a soft reset to `HEAD~1`, keeping the changes staged. It
confirms first:
`Undo the last commit? Its changes are kept and re-staged (soft reset to HEAD~1).`
It refuses when HEAD is a **merge** commit: resetting to the first parent throws
away the other side's history while keeping its content staged, which is not what
"undo" means. Use a reset to a specific commit, or revert the merge.

### Commit author

Below the amend row is a collapsed line reading `Commit as <name>`. Expanding
it shows where that name comes from and lets you change it. There are three
layers, narrowest first:

| Layer | Set from | Applies to |
|---|---|---|
| One-off override | `Change author…` in the commit box | The next commit only |
| Repository default | `Save for this repo` | Every commit in that repository |
| Git config | `git config user.name` / `user.email` | Everything else |

An override replaces **both** the author and the committer, which is what
`git -c user.name=… -c user.email=…` does — the useful behaviour when you are
switching between a work and a personal identity rather than committing
someone else's patch.

**This path never writes to your git config.** A repository default is stored
in voidlink's own settings and applied at commit time, so committing from the
command line in the same repository is unaffected. Review and remove saved
defaults under **Settings → Git**.

Editing `user.name` and `user.email` in git config itself *is* possible, but it
is a separate surface: the **Git configuration** section of
[Settings → Git](./settings.md#git), which writes real git config at a scope
you pick. The two sections sit next to each other and do different things —
one is a voidlink-side override, the other is your actual git config.

With no override and no `user.name` / `user.email` anywhere in the git config
cascade, the commit fails with a message that says so rather than libgit2's
raw `config value 'user.name' was not found`.

Amend follows the same rules with one difference: with no override it keeps
the amended commit's original author and committer, because fixing your own
commit should not reattribute it.

### Discarding everything

The trash icon on the **Changes** header (shown whenever anything has changed,
including an untracked-only tree) asks up to two questions: first about tracked
files — staged *and* unstaged edits revert to HEAD — then, separately, whether to
delete untracked files from disk. Declining both does nothing; it does not report
a discard that did not happen.

### Stashing

The archive icon opens a prompt with message `WIP` and two toggles:
`Keep staged changes in the index` (off) and `Include untracked files` (**on**).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Enter` | Commit — only while the commit message box has focus |
| `Mod+Shift+M` | [Draft the message with AI](./ai-commit-and-agent.md) |
| `Mod+J` | Toggle the git sidebar |
| `Mod+Alt+R` | Refresh git status |
| `Mod+Shift+D` | Toggle inline / split diff |

There is no *global* shortcut for stage, unstage, or push. The changed-file
list is its own keyboard surface, though — focus it (Tab into it, or `↓` from
the filter box) and:

| Key | Action |
|---|---|
| `↑` `↓` `PageUp` `PageDown` `Home` `End` | Move the cursor. The conflicts / staged / unstaged boundaries are invisible: the three lists are one surface. |
| `Space` | Stage an unstaged row, unstage a staged one, open a conflicted one |
| `Enter` | Open the row's diff (or the merge editor) |
| `Backspace` `Delete` | Discard an **unstaged** row — still behind its confirmation. Does nothing on a staged or conflicted row, matching the mouse UI, which offers no discard there. |
| `Esc` (in the filter box) | Clear the filter |

## The changed-file list

- **Filter box.** Fuzzy and path-aware — the same matcher the command palette
  and file finder use, so `btn` finds `src/components/Button.tsx` here for the
  same reason it does there. The matched characters are tinted. The list is
  **not** reordered by match score: a list that reshuffles as you type loses
  the one property that makes it scannable.
- **Two different emptinesses.** "The working tree matches HEAD" (good news)
  and "No changed file matches this filter" (a typo) are separate empty states
  with different icons and different sentences.
- **Windowed above forty rows** with `@tanstack/solid-virtual`, at a fixed 24px
  row. The height does *not* respond to the density setting, because the height
  is the virtualizer's size estimate.
- **Sticky sub-headings.** Scroll a hundred changed files and "Staged (12)" /
  "Changes (88)" stay put.

## Section order and freshness

- The git sidebar's seven sections render in an order you control: hover a
  section header and use the two arrows. The order persists globally (not per
  worktree) alongside the collapse state.
- The header's branch name, ahead/behind counts and dirty marker each declare
  their freshness. Live renders normally; refreshing pulses the *value* with
  the old number still underneath; stale drops to 60% opacity, says
  `Last read Nm ago` on hover, and grows a refresh button beside it. A stale
  ahead/behind rendered as if it were live is the failure that contract exists
  to prevent.

## Gotchas and limits

- **A file that is both staged and modified in the working tree appears once,
  as staged.** The status walk checks index state before worktree state and
  returns one bucket per file.
- **Ignored files are never listed.**
- **Discard-all asks about untracked files separately.** Tracked files (staged
  *and* unstaged) revert to HEAD; untracked files are a second, explicit
  confirmation, and declining both does nothing rather than reporting success.
  Deletion failures are reported, not swallowed.
- **Renames are downgraded to modifications for hunk staging.** Both sides of
  the generated patch use the new path; you can't stage half a rename, and the
  rename itself stays unstaged.
- **The inverted patch has no add/delete file headers.** Discarding a hunk of a
  newly-added or deleted file goes through a plain modification patch rather
  than a `/dev/null` one.
- **There is no "unstage hunk".** The backend supports a reverse apply, but no
  UI ever passes `reverse: true`.
- **Hunk actions exist only in the working-tree diff view.** The
  [branch compare](./branch-compare.md) pane renders the same diff component
  without them.
- **The diff view always shows the combined HEAD-to-worktree diff**, whether you
  opened the file from the Staged list or the Changes list.
- **`Ignore WS` can block a hunk action.** The remap from filtered hunk index
  back to raw index is keyed on `(oldStart, newStart)`; if that pair can't be
  found you get `Could not locate hunk in unfiltered diff. Disable Ignore WS and retry.`
- **No hooks, no signing, no message validation.** libgit2 does not run git
  hooks, so `pre-commit` and `commit-msg` never fire.
- **Bare repos are rejected** with `bare repositories not supported`.
- **Amend rewrites the index tree**, not the working tree — unstaged changes are
  not included. A blank message keeps the original. And because the amend
  checkbox only pre-fills the *summary*, amending a commit that had a body and
  then submitting the prefilled text **drops the body**.
- **Amend can run with nothing staged and an empty message.** That is
  deliberate — it is how you fix only a message.

## Manual QA checklist

Every item below is a regression that shipped once. None of them is covered by
an automated test end-to-end, because each needs a real repository in a state a
unit test cannot cheaply fake.

**Finishing a conflicted merge.** Merge a branch that conflicts, resolve the
files in the merge editor, then press Commit in the sidebar.
- The operation banner disappears after the commit. (It used to stay forever.)
- `git log --format=%p -1` shows **two** parents.
- `.git/MERGE_HEAD` and `.git/MERGE_MSG` are gone.
- Committing *before* resolving is refused with a message naming conflicts, not
  a corrupt commit.

**Stash apply after the list shifted.** Stash something, then stash something
else (or switch branches so the auto-stash pushes onto the stack), then apply the
first stash from the row it originally occupied.
- The right stash is applied, or you get "the stash list changed" — never the
  wrong one silently.
- Drop behaves the same way. This one is irreversible, so check it.

**A fresh `git init` repository renders.** Open a directory with a repo that has
no commits.
- The sidebar renders; no white panel.
- The header shows the branch git intends (`main`), no ahead/behind.
- History is empty rather than an error; the ref picker opens.
- Pull is disabled and says why.

**A rejected push shows red.** Push a branch whose remote has moved on (or
force-push someone else's commit onto it from a clone, then push).
- The push button does **not** turn green.
- The error appears in its own line, labelled as a push failure, and does not
  overwrite a commit error already on screen.
- After a *successful* first push of a new branch, ahead/behind starts working
  (an upstream was set).

**Staging updates the detached git window.** Open the git window
(`Open git window`), then stage a file in the workbench sidebar.
- The git window's Changes list updates without being touched.
- Same for unstage, stage-all, commit, checkout, tag push and the Remotes
  dialog's four actions.

**Mid-operation guards.** Start a rebase that stops on a conflict.
- Branch checkout / rename / delete / create are disabled and say why.
- The merge and rebase context-menu entries are replaced by the reason.
- Committing is refused with a message pointing at the banner's Continue.
- A hard reset is allowed, and afterwards the banner is gone.

**Keyboard discard.** Focus a **staged** row and press Backspace, then Delete.
- Nothing is discarded. (The mouse UI offers no discard on a staged row, so the
  keyboard must not either.)
- On an unstaged row both keys still confirm and discard.
