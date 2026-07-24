# Settings

## What it does

A modal dialog with seven tabs. Six read and write a single settings store
persisted to `localStorage["voidlink-settings"]`; **Stack** writes to the active
repo's `.git/config` instead, and **Keyboard** is read-only.

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
- **`Reset to defaults` does not reset the theme** (separate storage key) or the
  **Stack** tab (not in the settings store at all).
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
