# Settings

## What it does

A modal dialog with nine tabs. Most read and write a single settings store
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
| `Tabs` | Horizontal / Vertical | Horizontal | Which way every pane's tab strip runs, in the workbench and the editor window alike. Vertical also **relocates the file explorer** — see below. |
| `Tab column` | 140–400 px | 200 px | Width of the vertical strip. Only shown while `Tabs` is Vertical. Clamped on read, because the settings file is hand-editable and a 4 px strip is a window with no visible way back. |

#### What Vertical does to the layout

The switch is a layout mode, not a skin. A vertical strip is a third
navigation column at the left edge of the window, behind the workspace rail
and the file tree, and three parallel vertical lists at one edge is one more
than the eye scans. So under Vertical:

- The **file explorer moves to the right column**, above the git panel. The
  left edge then answers *which thing am I looking at* (workspaces, then tabs)
  and the right edge answers *what is in this repo* (its files, then its
  changes). Both placements render the same `FilesPanel`.
- The **left sidebar goes away**. Neither of its other two sections is lost:
  the terminals list is a second rendering of the terminal *tabs*, which the
  vertical strip already shows with full labels rather than 140 px of them,
  and `Compare branches` is a row in the `+` menu and an action in `Mod+K`.
  The repo picker is on the workspace rail.
- `Mod+B` keeps meaning **show or hide the file explorer**, wherever it is —
  the binding names an intent, not a screen edge.
- The strip's `+` menu, group mark and overflow chevron move to a footer row
  along the column's bottom edge, which is the same place in the strip's own
  reading order.

### Theme

Ten palettes — see [themes](./themes.md).

### Editor

The only pane rendered from a **schema** rather than hand-placed:
`store/settingsSchema.ts` holds one entry per setting — dotted id
(`editor.fontSize`), type, constraints, default, description and section — and
the defaults, the parse, the controls, the search and the JSON view's
validation are all derived from it. Adding a setting is one entry there.

Thirteen sections: `Font`, `Indentation`, `Wrapping`, `Display`, `Scrolling`,
`Folding`, `Cursor`, `Suggestions`, `Highlighting`, `Editing`, `Save`,
`Keybindings`, `Language servers`.

Three things sit above the sections:

| Control | What it does |
|---|---|
| Search box | Fuzzy-matches id, label, description **and enum members** — typing `relative` finds `editor.lineNumbers`, `deepIndent` finds `editor.wrappingIndent`. Matched characters are highlighted, using the same scorer as `Mod+K`. |
| `Modified (n)` | Shows only the settings that differ from their default. Disabled, with the reason on hover, when nothing does. |
| `Controls` / `JSON` | Switches between the controls and the text view. |

A changed setting grows a small reset button next to its label; the tooltip
names the default it would return to. `Reset to defaults` in the footer still
resets the whole store.

**Per-language overrides** live at the bottom of the pane: pick a Monaco
language id, add settings to override, and those values win for buffers in that
language only. Keys are language ids (`typescript`, `rust`), not file
extensions. The dropdown lists every language a buffer in this app can be in,
plus any language already carrying an override.

**The JSON view** is a Monaco editor over the same store — not a copy of it.
Edits apply as you type; a change made with a control rewrites the buffer under
the cursor. It uses VS Code's dotted form:

```jsonc
{
  "editor.fontSize": 13,
  "editor.wordWrap": "off",
  "[rust]": { "editor.tabSize": 4 }
}
```

Completion, hover text and inline validation come from a JSON Schema generated
from the same table the controls are drawn from, registered through
`monaco.json.jsonDefaults` — so it cannot drift from the GUI. **Malformed JSON
is refused out loud**: an inline error bar names the line and the store is left
untouched until the text parses. A value that parses but is not valid (an enum
member that no longer exists, a font size of 400) is not an error — it falls
back to its default or clamps into range, exactly as a blob loaded from
localStorage does.

Every editor setting applies to the running editor. See
[editor and preview](./editor-and-preview.md#settings).

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

### AI — parked

The tab is **disabled and labelled "coming soon"** while the surface is
reworked. It stays focusable rather than `disabled` so a keyboard user lands on
it and is told why, per §7.6's no-silent-disabled-control rule; the reason is
on the face of the tab and in its tooltip.

Nothing was deleted: `AiPane` and everything under it — the agent roster, the
provider keys, the two command templates — is still mounted on a branch `tab()`
can no longer reach, so re-enabling it is deleting one `disabledReason` prop.
Values already saved are still read and still used; they simply cannot be
edited from this dialog in this build.

See [AI commit and agent](./ai-commit-and-agent.md) for what those settings do.

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

### Help

A one-line-per-capability index of what the app does, grouped into shell and
navigation, editing, terminals, git, beyond git, and where your data lives.

It exists because every other answer to *what is this thing* lives outside the
binary — these twenty-six reference pages — and someone who has just opened
Settings is not going to go and read them.

Two rules keep it honest, and both are why it is a component rather than a
markdown blob:

- **No hardcoded shortcuts.** Every chord comes from `shortcutLabel`, which
  reads the same table that fires the binding, so a rebinding or a platform
  difference cannot make the page lie. An action with no chord renders no key.
- **It claims only what ships.** Nothing aspirational, nothing behind a flag.
  The AI row says the settings pane is parked, because it is.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+,` | Open settings |
| `Esc` | Close |
| `Tab` / `Shift+Tab` | Move focus, trapped inside the dialog |

`Mod+K` → `Go to setting…` asks for a name and opens the Editor pane filtered
to it, with the filter box focused — the same fuzzy match the box itself runs,
so `font size`, `fontSize` and `editor.fontSize` all land in the same place.

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
  indefinitely. The **editor** group is the exception: it goes through the
  schema, which validates and clamps as well as filling. Unknown keys still
  survive the round-trip there — deliberately, so an older build opening a newer
  build's config does not eat fields.
- **The JSON view edits `localStorage`, not a file.** There is no
  `~/.voidlink/settings.json`; import, export, sync and profiles do not exist.
- **Per-language overrides are global, not per workspace.** `[rust]` means every
  Rust buffer in every repo.
- **The whole settings object is re-serialised on every keystroke** into a text
  field.
- **Terminal settings apply live** to every open pane.
- The store key `density` is labelled `Spacing` in the UI.
