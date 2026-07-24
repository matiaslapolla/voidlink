# Brain vault browser

## What it does

A read-mostly browser for a local `brain-kb` vault — a git-cloned directory of
markdown entries with YAML-ish frontmatter. It lists entries, filters them by
type, fuzzy-searches titles and labels, renders the body as markdown, and can
capture one new note.

## When you'd use it

To look something up from your second brain without leaving the editor, and to
jot a quick note while the context is fresh.

## Setup

**Settings → Brain → Path** — point it at the vault directory, or use
`Browse…`.

This is a **separate setting from the `brain` CLI's own config**. The CLI reads
its path from `--vault-path`, then `$BRAIN_VAULT_PATH`, then
`~/.config/brain/config.json`. Neither side reads the other, so the two have to
be pointed at each other by hand. The settings pane says as much.

## How to use it

1. Open a Brain tab from the tab bar's `+` menu → `Brain`. There is one Brain
   tab per workspace.
2. With no path set you get
   `Set a vault path in Settings → Brain to browse your second brain.`
3. Filter by type, or type in the search box.
4. Click an entry to render it.

### Entry types

Six, each mapping to a folder:

| Type | Folder |
|---|---|
| `decision` | `decisions/` |
| `shipped` | `shipped/` |
| `note` | `notes/` |
| `discovery` | `discoveries/` |
| `content` | `content/` |
| `training` | `training/` |

### Quick capture

The only write path. It creates a **note** — and only a note, because `note` is
the one type with no project or ticket validation, so the CLI's contract can be
mirrored narrowly on the client.

Title and at least one label are required, else
`Title and at least one label are required.` The id is
`<YYYY-MM-DD>-<slug>`, de-duplicated with `-2`, `-3`, … against existing note
ids. Saving writes the file and commits it with message `register: note <id>`.

## The `brain` CLI

`cli/` at the repo root is a standalone Node package, relocated from its own
repository. It owns the **contract** — the zod schemas, the type-to-folder map,
and the id/frontmatter builders. The Tauri backend and the Brain tab each keep a
narrow hand-synced copy for reading and note-only writing.

```
brain add --type <t> --title "..." [flags]
brain add --json '<json>'
brain search <query>
```

It writes markdown into the vault, then `git add` + `git commit` scoped by
pathspec. **Commit only — it never pushes**, deliberately. If the git step
fails, it deletes the file so a retry doesn't burn an id.

## Keyboard shortcuts

None. There is no palette action and no keybinding that opens the Brain tab.

## Gotchas and limits

- **Search never looks at entry bodies.** The list command deliberately skips
  reading them, so in-app search scores only title, labels, and project. The
  CLI's `brain search` is different — it substring-matches the whole raw file,
  including frontmatter.
- **There is no way to edit an existing entry.** The detail pane is rendered
  markdown. The backend has a save command and its doc comment mentions "in-app
  edits", but that half is not wired to any UI.
- **Only notes can be created.** The other five types must go through the CLI.
- **The vault path must be the root of its git repository**, or saving fails
  with `Vault path … is not the root of its git repository … — point Settings →
  Brain at the repo root`.
- **Files without `---` frontmatter are silently dropped from the list**, but
  reading one directly errors with `No frontmatter found in <path>`.
- **Unknown folders read as `note`.**
- **Frontmatter parsing is hand-rolled, not YAML.** Only `title`, `project`,
  `ticket`, `created`, and `labels` are read, and `labels` must be a flow array
  (`[a, b]`) — a block list parses as empty.
- **The created timestamp hard-codes a `-03:00` offset.**
- **Saving does not refresh an open detail pane**, only the list.
- **Path traversal is rejected** at every IPC entry point with
  `Invalid entry path: <path>`.
