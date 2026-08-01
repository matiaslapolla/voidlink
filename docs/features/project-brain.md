# Project brain

## What it does

A read-mostly browser for the open project's own notes and decisions, stored as
markdown files under `<repoRoot>/.voidlink/brain/`. It lists entries, filters
them by type, fuzzy-searches titles and labels, renders the body as markdown,
and can capture one new note.

Every repository has its own brain. There is no global store, no configured
path, and nothing shared between projects.

## When you'd use it

To write down why you did something while it is still fresh, and to find it
again later without leaving the editor.

## Setup

None. The directory is created by the first note you save.

`.voidlink/` is the same per-repo directory the worktree wizard already uses,
and it is **normally gitignored** — which is the intended arrangement. Two
consequences worth knowing:

- Your brain does not appear or vanish as you switch branches, and it never
  shows up in a diff or a PR.
- It is not shared with anyone else on the repo. If you want it to be, remove
  `.voidlink/` from the ignore rules and commit it — nothing in the app stops
  you, but nothing in the app helps either (see *Gotchas*).

## How to use it

It is an **overlay**, not a tab. Open it from the command palette
(`Search brain…`) or from the tab bar's `+` menu → `Brain`; `ESC`, the close
button or a click on the scrim dismisses it.

1. With no repository open you get `Open a repository to browse its brain.`
2. With a repository and no entries yet:
   `No entries yet — capture one with Quick note.`
3. Filter by type, or type in the search box.
4. Click an entry to render it, in the same overlay.

### Which repository

The **workspace's repo root**, not the active worktree's path. Every worktree of
a project reads and writes the same brain — a note about the project should not
disappear because you switched to the worktree you wrote it for.

### Why it stopped being a tab

It was one of ten tab kinds until cut C2 of the
[2026-07-29 workbench audit](../specs/2026-07-29-workbench-100x.md). The
argument: a tab-strip slot is for something that *reports state*. A terminal
goes busy, a compare goes dirty, an agent run fails — an entry does none of
that, so it held a slot and a persistence key while saying nothing, and every
`+` on the strip pushed the tabs that did have something to say further along.

The audit proposed demoting it onto `QuickPick`, the shared fuzzy-picker
popover. That is the right shape for *searching* notes and the wrong one for
this surface, which also reads them and writes them — a popover list holds
neither a rendered markdown pane nor a form. So the demotion kept the surface
whole and only changed what contains it.

Old layout snapshots that recorded a Brain tab restore without one, and the
`voidlink-brain-tabs` storage key is deleted on first launch by the layout
migration (`store/migrate.ts`, v2 → v3).

### Entry types

Six, each mapping to a folder under `.voidlink/brain/`:

| Type | Folder |
|---|---|
| `decision` | `decisions/` |
| `shipped` | `shipped/` |
| `note` | `notes/` |
| `discovery` | `discoveries/` |
| `content` | `content/` |
| `training` | `training/` |

All six are read. Only `note` can be authored in-app.

### Quick capture

The only write path. It creates a **note**: `note` is the type that needs
neither a project nor a ticket to make sense, since the project is already
implied by which repo's brain you are writing into.

Title and at least one label are required, else
`Title and at least one label are required.` The id is
`<YYYY-MM-DD>-<slug>`, de-duplicated with `-2`, `-3`, … against existing note
ids.

**Saving writes the file and stops.** Nothing is staged and nothing is
committed. An earlier version of this surface wrote into a dedicated content
repository and committed in the same call, which was right there and wrong
here: a project brain lives inside the repository you are *working* in, where a
commit made on your behalf lands on your branch, mid-change, next to whatever
you had staged.

## Relationship to the `brain` CLI

**None.** `cli/` at the repo root is a standalone Node package that writes typed
entries into a personal `brain-kb` vault. It shares the six type names and the
frontmatter layout with this surface — an entry from either reads fine in the
other — but no code, no configuration, and no directory. The CLI never looks at
`.voidlink/brain`, and this surface never looks at the CLI's vault.

## Keyboard shortcuts

No dedicated chord. It is reachable from the command palette as
`Search brain…`, and `ESC` closes it.

## Gotchas and limits

- **Search never looks at entry bodies.** The list command deliberately skips
  reading them, so search scores only title, labels, and project.
- **There is no way to edit an existing entry.** The detail pane is rendered
  markdown; changing an entry means opening the file.
- **Only notes can be created.** The other five folders are read if something
  puts entries in them, but nothing in the app authors them.
- **Committing the brain is unsupported, not forbidden.** If you un-ignore
  `.voidlink/`, entries become branch-scoped and merge like any other file. The
  app will not help you with either.
- **A `project:` field in frontmatter is shown but redundant** — the repo is the
  project now. It is still parsed, so entries copied in from a vault render
  correctly.
- **Files without `---` frontmatter are silently dropped from the list**, but
  reading one directly errors with `No frontmatter found in <path>`.
- **Unknown folders read as `note`.**
- **Frontmatter parsing is hand-rolled, not YAML.** Only `title`, `project`,
  `ticket`, `created`, and `labels` are read, and `labels` must be a flow array
  (`[a, b]`) — a block list parses as empty.
- **The created timestamp hard-codes a `-03:00` offset.**
- **Saving does not refresh an open detail pane**, only the list.
- **Closing the overlay discards what you were reading.** There is no persisted
  state, which is the flip side of not being a tab: reopening lands on the
  unfiltered list.
- **Path traversal is rejected** at every IPC entry point with
  `Invalid entry path: <path>`.
