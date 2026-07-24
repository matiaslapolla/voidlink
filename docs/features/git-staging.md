# Staging, committing, and hunk-level apply

## What it does

The Changes pane of the git sidebar: file status, staging, discarding,
committing, amending, and stashing. Plus hunk-level staging and discarding from
the diff view — the equivalent of `git add -p` and `git checkout -p`.

All of it runs on libgit2. Nothing here shells out to a `git` binary.

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
exists on disk: present → `index.add_path`, absent → `index.remove_path`.

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

### Discarding everything

The trash icon on the **Changes** header confirms with
`Discard ALL changes in the working tree? Tracked files revert to HEAD. This cannot be undone.`

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

There is no global shortcut for stage, unstage, or push.

## Gotchas and limits

- **The commit path does not create merge commits.** `git_commit` builds its
  parent list from `HEAD` alone and never reads `MERGE_HEAD`. The operation
  banner tells you `Commit to finish.` during a merge, but committing that way
  produces a single-parent commit and leaves `MERGE_HEAD` in place. Finish
  merges from a terminal.
- **A file that is both staged and modified in the working tree appears once,
  as staged.** The status walk checks index state before worktree state and
  returns one bucket per file.
- **Ignored files are never listed.**
- **`Discard all` never deletes untracked files**, even though the backend
  supports it — the UI hard-codes `includeUntracked: false`. Untracked files
  must be deleted individually.
- **Per-file deletion failures during discard-all are swallowed**, and only
  files are removed — an untracked *directory* survives.
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
