# Themes

## What it does

Ten colour themes applied instantly across the whole app — UI, editor, and
terminal — and remembered across restarts.

## When you'd use it

Once, probably.

## How to use it

**Settings → Theme.** A two-column grid of cards, each previewing its own
palette: background, foreground, primary, and border. Arrow keys move between
cards; Enter or Space selects.

| Id | Label | Mode |
|---|---|---|
| `dark` | Default Dark | dark |
| `light` | Default Light | light |
| `github-dark` | GitHub Dark | dark |
| `github-light` | GitHub Light | light |
| `monokai` | Monokai | dark |
| `solarized-dark` | Solarized Dark | dark |
| `solarized-light` | Solarized Light | light |
| `nord` | Nord | dark |
| `dracula` | Dracula | dark |
| `one-dark` | One Dark | dark |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+,` | Open settings (then pick the Theme tab) |
| `←` `→` `↑` `↓` | Move between theme cards, while the grid has focus |

There is no shortcut that cycles themes or toggles light/dark. A
`toggleTheme()` function exists in the store but nothing in the UI binds it.

## How a theme is applied

Three things happen on `<html>`:

1. The `light` or `dark` class is toggled, driving `color-scheme` and the
   default token blocks.
2. `data-theme="<id>"` is set — **except** for `dark` and `light`, which have
   their attribute removed because they live at `:root` and `:root.light`.
3. The id is written to `localStorage["voidlink-theme"]`.

So dark themes select on `:root[data-theme="nord"]`, while light themes need
both: `:root.light[data-theme="github-light"]`.

The theme is loaded and applied at module import time, before the signal is even
created, specifically so there is no flash of the wrong palette on start.

## What a theme defines

Every theme block defines the same 34 custom properties, all in `oklch`:

```
--background --foreground --card --card-foreground --popover
--popover-foreground --primary --primary-foreground --secondary
--secondary-foreground --muted --muted-foreground --accent
--accent-foreground --destructive --success --warning --info --border
--input --ring --chart-1 … --chart-5 --sidebar --sidebar-foreground
--sidebar-primary --sidebar-primary-foreground --sidebar-accent
--sidebar-accent-foreground --sidebar-border --sidebar-ring
```

They reach Tailwind through an `@theme inline` block, which is why
`bg-popover`, `text-muted-foreground`, and `border-border` all follow the active
theme.

`--radius` and `--font-sans` are **not** part of a theme — they are defined once
globally.

## Gotchas and limits

- **Themes are not reset by `Reset to defaults`.** That button clears the
  settings store (`voidlink-settings`); the theme lives under a separate key.
- **`ThemeId` is effectively `string`.** The union collapses because the
  underlying field is typed `string`, so there is no compile-time narrowing.
- **An unknown theme id is silently ignored.**
- **The light/dark toggle loses your palette for four themes.** It pairs by name
  (`github-dark` ↔ `github-light`), so `monokai`, `nord`, `dracula`, and
  `one-dark` — which have no light counterpart — fall back to the plain
  `light` default.
- **Theme swatches use raw literal colour values on purpose.** Semantic tokens
  only resolve under the matching `data-theme`, so a token-driven swatch would
  paint every card in the *currently active* theme.
- **The theme grid's arrow navigation hard-codes two columns.** Changing the
  grid layout breaks up/down movement.
- Editor and terminal colours follow the theme's mode: Monaco switches between
  `vs` and `vs-dark`, and the xterm palette is rebuilt on the toggle.
