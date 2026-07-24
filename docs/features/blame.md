# Inline blame

## What it does

Annotates each line of the active editor file with who last touched it and why:
short oid, author, relative time, and the commit summary — rendered as dimmed
italic text trailing the code.

## When you'd use it

Reading unfamiliar code. Leave it on and it follows you from file to file.

## How to use it

Toggle it any of three ways:

- `Mod+Alt+B`
- The `Blame` button in the status bar (eye icon; the tooltip reads
  `Inline blame: on (click to disable)` or the reverse)
- The palette entry, whose label flips between `Enable inline blame` and
  `Disable inline blame`

That's the whole interface. There is no per-line click target, no "show this
commit" affordance, and no blame gutter — the annotation is decoration text
only.

An uncommitted line renders as `• You · Uncommitted` in the warning colour
rather than the normal muted grey.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Alt+B` | Toggle inline blame |

## How it works

The backend uses libgit2's `blame_file` with copy and move tracking explicitly
**off** — there is no `-C` / `-M` equivalent. It then reads the file from disk
for the line count and expands blame hunks into one entry per line, caching
commit metadata per oid because repeated hunks on the same commit are common and
revwalk lookups aren't free.

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

What *is* per-file: the decoration handles and the in-flight request
deduplication, both keyed by absolute path. Blame results themselves are **not
cached** — every time you activate a file it re-runs the full blame.

## Gotchas and limits

- **Failures are silent.** Files outside the repo, never committed, or
  gitignored all throw; the overlay swallows the error to `console.debug` and
  renders nothing. There is no toast and no UI hint distinguishing "no blame
  available" from "blame is off".
- **Binary and non-UTF-8 files error out** in the line-count read.
- **The file path must be absolute and literally prefixed by the repo
  workdir**, or you get `file is not inside repo: <path>`. Symlinked paths, or a
  `/var` versus `/private/var` mismatch on macOS, fail here.
- **Bare repos** return `bare repos can't be blamed`.
- **One retry, one frame.** If the Monaco model isn't loaded yet the overlay
  waits a single `requestAnimationFrame` and retries once, then gives up until
  the next editor change notification.
- **No viewport windowing and no line cap.** A 20,000-line file produces 20,000
  decorations in one call.
- **Blame only applies to file tabs.** It never appears in the diff, compare, or
  conflict panes.
- **Uncommitted lines always say `You`** regardless of the signature the backend
  returned for that hunk.
- The backend struct's doc comment claims uncommitted lines are skipped. They
  are not — the comment is stale; they are returned with an `uncommitted` flag.
