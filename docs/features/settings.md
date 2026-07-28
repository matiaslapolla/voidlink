# Settings

## What it does

A modal dialog with eight tabs. Most read and write a single settings store
persisted to `localStorage["voidlink-settings"]`; **Stack** and **Git** write to
real git config instead — the active repo's `.git/config` or your global
`~/.gitconfig` — and **Keyboard** is read-only.

## How to use it

Open with `Mod+,`, the palette's `Open settings…`, or the gear in the title bar.
`Done` closes it; `Reset to defaults` restores the settings store.

## Tabs

### UI

| Setting | Options | Default | Effect |
|---|---|---|---|
| `Text size` | Small / Base / XL | Base | Sets the root font size to 14 / 16 / 18 px. |
| `Spacing` | Compact / Normal / Comfortable | Normal | Sets `data-density` on `<html>`, driving row padding, row gap, and section padding. |

### Theme

Ten palettes — see [themes](./themes.md).

### Terminal

Grouped into `Font`, `Cursor`, `Behavior`, and `Scroll`.

| Setting | Default |
|---|---|
| Font family (plus seven Nerd-Font presets) | a JetBrainsMono-first stack |
| Font size | 13 px |
| Line height | 1.2 |
| Letter spacing | 0 |
| Font weight / Bold weight | 400 / 700 |
| Ligatures | off |
| Cursor style / blink / width | block / on / 1 px |
| Min contrast | 1 |
| Bold is bright | on |
| macOS Option = Meta | off |
| Right-click selects word | off |
| Scrollback | 5000 lines |
| Sensitivity | 1× |
| Scroll on input | on |

### Keyboard

A read-only listing of every global shortcut, grouped, derived from the same
table that fires them. Rows whose binding is scoped show why underneath. See
[keyboard shortcuts](./keyboard-shortcuts.md).

Rebinding is not offered — the keymap is structured to allow it later, but the
editor UI is separate work.

### AI

Two command templates. See
[AI commit and agent](./ai-commit-and-agent.md).

### Git

Two stacked sections that look similar and do completely different things.

**Git configuration** reads your effective config cascade (system → global →
local, via libgit2 — never by shelling out to `git config`) and writes a
curated set of keys back to it:

| Group | Keys |
|---|---|
| Identity | `user.name`, `user.email` |
| Commit | `user.signingkey`, `commit.gpgsign` |
| Branching & sync | `init.defaultBranch`, `pull.rebase`, `push.default`, `push.autoSetupRemote`, `fetch.prune`, `rebase.autoStash` |
| Diff & merge | `merge.conflictstyle`, `diff.algorithm` |
| Core | `core.editor`, `core.autocrlf`, `core.filemode`, `core.ignorecase` |

Reads are unrestricted; **writes are restricted to that list and the restriction
is enforced in Rust**, not only in the UI. Anything else stays a job for
`git config` in a terminal.

A `Local` / `Global` segmented control at the top picks where writes land, and
the line under it names the file libgit2 resolved — `<repo>/.git/config` or
`~/.gitconfig`. With Global selected, every section header turns amber. With no
repository open, `Local` is disabled (with the reason on hover) and the global
cascade still renders.

Each row shows the effective value and, in words, where it comes from:

| Mark | Meaning |
|---|---|
| `default` | Set nowhere; git's own default is shown ghosted. |
| `from global` / `from system` | Set at another level. The value renders at 80% opacity — it is a fact about someone else's file. |
| `local` / `global` | Set at the scope you are editing. A `Clear` action removes it. |
| `local · overrides global` | Set here *and* lower down. The shadowed value is printed underneath. |
| `global · overridden by local` | Set here but beaten by a higher level — editing here will not change what git does. |

**voidlink identity overrides** is the second section and is *not* git config:
it lists repositories where voidlink commits under a different name, applied at
commit time from voidlink's own settings. See
[git staging](./git-staging.md#commit-author).

### Stack

Comma-separated trunk overrides for the **active repo**, stored in that repo's
`.git/config`. See [stacked PRs](./stacked-prs.md). Without a repo open it shows
`Select a workspace with a repo to configure its stack settings.`

### Brain

The vault path. See [brain vault](./brain-vault.md).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+,` | Open settings |
| `Esc` | Close |
| `Tab` / `Shift+Tab` | Move focus, trapped inside the dialog |

## Gotchas and limits

- **The settings dialog sits at `z-70`, below the palette and file finder at
  `z-80`.** Pressing `Mod+K` with settings open renders the palette on top of
  it.
- **`Reset to defaults` does not reset the theme** (separate storage key), the
  **Stack** tab, or the **Git** tab's config rows (neither is in the settings
  store — they are real git config).
- **The Git tab does not watch `.git/config`.** It reads when the tab opens and
  again after each write, so an edit made in a terminal meanwhile shows up only
  after pressing `Refresh`. The refresh button's tooltip says when it last read.
- **Global writes touch a file outside the repository** (`~/.gitconfig`, or the
  XDG file when git would use that one). The resolved path is printed under the
  scope switch at all times; there is no per-write confirmation.
- **The Escape handler is on the backdrop**, not the dialog. It works because
  keydown bubbles out of the dialog, but it is why clicking outside also closes.
- **The focus trap only handles `Tab`.** Initial focus lands on the first
  focusable element, which is the `UI` tab button.
- **Defaults are merged shallowly per group**, so a key persisted under an older
  schema and later removed from the defaults survives in `localStorage`
  indefinitely.
- **The whole settings object is re-serialised on every keystroke** into a text
  field.
- **Terminal settings apply live** to every open pane.
- The store key `density` is labelled `Spacing` in the UI.
