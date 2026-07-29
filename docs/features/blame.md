# Inline blame

## What it does

Two surfaces over one blame:

1. **The whole-file overlay.** Every line of the active editor file annotated
   with who last touched it and why — short oid, author, relative time, commit
   summary — as dimmed italic text trailing the code.
2. **The caret-line chip** in the editor's own status bar: author, relative
   date, short oid for the line the cursor is on. Click it to open that commit.

## When you'd use it

Reading unfamiliar code. Leave it on and it follows you from file to file.

## How to use it

Toggle it either way:

- `Mod+Alt+B`, in the editor
- The palette entry, whose label flips between `Enable inline blame` and
  `Disable inline blame`

There used to be a `Blame` chip in the **workbench's** status bar. It is gone,
and it never worked: in the default detached mode the workbench hosts no Monaco
at all — the editor is its own window and the chunk is not even fetched — so
clicking it flipped a signal, wrote `localStorage`, asked the controller for the
active path, got `null`, and returned. A light switch wired to no bulb. The
`view.toggle-blame` command was already scoped to `window: "editor"`; the status
bar was the one entry point that leaked.

While blame is on, the editor's status bar carries a chip for the caret line:

| Chip | Meaning |
|---|---|
| *(absent)* | Blame is off, or this line has no entry |
| `Blame…` | A `git_blame_file` is in flight |
| `No blame` | git could not blame this file. The reason is in the tooltip |
| `<author> · Uncommitted` | The line is not committed yet |
| `<author> · <when> · <oid>` | Clickable — opens the commit |

Clicking opens a compare tab at `<oid>^..<oid>` with the file preselected, the
same route the git sidebar's commit rows and a SHA clicked in a terminal take.
Compare is a workbench surface, so from the detached editor window the request
travels over and the workbench comes forward.

An uncommitted line renders as `• <author> · Uncommitted` in the warning colour
rather than the normal muted grey.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Alt+B` | Toggle inline blame |

## How it works

The backend uses libgit2's `blame_file` with copy and move tracking explicitly
**off** — there is no `-C` / `-M` equivalent. It then expands blame hunks into
one entry per line, caching commit metadata per oid because repeated hunks on the
same commit are common and revwalk lookups aren't free.

It also reads the file from disk, but *only* to size the output `Vec`, and it
counts newline bytes rather than decoding the text. That read used to be
`read_to_string` whose error aborted the whole command, so a non-UTF-8 file got
no blame even though `blame_file` had already succeeded. Both a failed read and
a missing hint are now non-fatal.

Commit summaries are truncated at 80 characters with an ellipsis, because
Monaco's inline decoration width is limited and long subjects look noisy.

On the frontend, `blameOverlay.ts` is a module-level singleton, not a component.
Each annotation is a zero-width decoration range at the line's max column with
an `after` content injection, so the text trails the code instead of pushing it
rightward.

## State scope

**Global, and persisted.** One signal shared by the status bar, the palette
action, and the keybinding, stored in `localStorage["voidlink-blame-enabled"]`.
Turning it on annotates every file you visit, and it survives restarts.

Blame is broadcast on `voidlink://blame-enabled`, so turning it on in one window
turns it on in every window. The state used to be read once at module eval with
no `storage` listener, which meant the editor window and the workbench could
disagree indefinitely.

What *is* per-file: the decoration handles, the in-flight request dedup, and the
result cache — all keyed by absolute path.

### The result cache

`refreshBlameFor` is called on every controller notification: every keystroke
(100ms debounced) and **twice** per save. Each call used to be a full
`git_blame_file` plus a rebuild of every line's decoration, so saving one
character in a 5k-line file meant three whole-file blames.

Results are now cached under `<refs epoch>:<model version>`:

- **refs epoch** is bumped by the git-refs pulse — commit, checkout, rebase,
  amend, including one performed in another window. That is also what fixes
  blame going stale: committing the open file used to leave the annotations
  reading `• You · Uncommitted` until you switched tabs and back.
- **model version** is Monaco's version id, read only while the buffer is
  *clean*. A dirty buffer reuses whatever is cached for the current epoch (the
  annotations ride along with Monaco's own decoration tracking as lines shift,
  and re-blaming mid-edit would answer about the file on disk anyway). Saving
  flips dirty off at a new version id — exactly one new key, so exactly one
  blame per save however many times the controller notifies.

A repo head oid would be the more literal key. It would also cost an extra IPC
per check to learn what the refs pulse already reports for free.

## Gotchas and limits

- **A failure is named, not silent.** Files outside the repo, never committed,
  or gitignored still throw; the message is kept and surfaces as a `No blame`
  chip whose tooltip carries git's own wording. "No blame available" and "blame
  is off" are now distinguishable — off has no chip at all.
- **The file path must be absolute and literally prefixed by the repo
  workdir**, or you get `file is not inside repo: <path>`. Symlinked paths, or a
  `/var` versus `/private/var` mismatch on macOS, fail here.
- **Bare repos** return `bare repos can't be blamed`.
- **One retry, one frame.** If the Monaco model isn't loaded yet the overlay
  waits a single `requestAnimationFrame` and retries once, then gives up until
  the next editor change notification.
- **No viewport windowing and no line cap.** A 20,000-line file still produces
  20,000 decorations — but only once per actual git change, not once per
  keystroke.
- **Blame only applies to file tabs.** It never appears in the diff, compare, or
  conflict panes.
- **Uncommitted lines name the signature git2 returned**, falling back to `You`
  only when it is empty. They used to be hardcoded to `You`, which was a lie in
  a worktree with a per-repo `user.name`.
- **The chip shows the caret line only.** The overlay is what annotates every
  line; there is still no blame gutter, no per-line age ramp, and no re-blame at
  the parent commit.
- **A root commit's compare tab has an empty base.** `<oid>^` does not resolve.
  Same behaviour as the terminal's SHA links.

## Manual QA

- [ ] Turn blame on in the editor (`Mod+Alt+B`). Annotations appear, and the
      status bar gains a chip for the caret line.
- [ ] Move the caret line by line. **The chip follows** — author, relative date,
      short oid — and it does so without any new `git_blame_file` (watch the
      devtools IPC log, or add a `console.count`).
- [ ] Click the chip. A compare tab opens on that commit, with the file
      preselected. From the detached editor window the workbench comes forward.
- [ ] Put the caret on a line you just edited but have not committed. The chip
      reads `<your name> · Uncommitted` and is not clickable.
- [ ] Open a gitignored or brand-new file. The chip reads `No blame` and the
      tooltip explains why. Turn blame off: the chip disappears entirely — that
      is the distinction.
- [ ] **Commit the open file** (from the git panel, without touching the editor
      tab). The annotations and the chip refresh in place — no tab switch
      needed. This was the stale-after-commit bug.
- [ ] Open a 5k-line file, blame on, and save it (`Mod+S`) a few times.
      **At most one `git_blame_file` per save**, and none at all while typing.
- [ ] Type without saving: the annotations shift with the lines and no blame is
      re-run.
- [ ] Toggle blame in the editor window while the workbench is also open. Both
      windows agree.
- [ ] Split the editor so two groups show the same file. Both carry the
      annotations.
- [ ] Blame a file with non-UTF-8 bytes in it. It still annotates.
