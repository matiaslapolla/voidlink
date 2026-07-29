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

Every theme block names **both**: `:root.dark[data-theme="nord"]`,
`:root.light[data-theme="github-light"]`. That is a specificity requirement, not
a style choice — a bare `:root[data-theme="…"]` is 0-2-0, exactly the same as
`:root.light` in `index.css`, and `themes.css` is `@import`ed first, so on a tie
the light block won. Any moment where the class and the attribute disagreed
painted light tokens under a dark theme.

The theme is loaded and applied at module import time, before the signal is even
created, specifically so there is no flash of the wrong palette on start. A
pre-paint inline script in `frontend/index.html` gets in earlier still: it sets
the mode class *and* `data-theme` from `localStorage`, so frame one is already
the right palette. It carries its own copy of the light-theme id list
(`light`, `github-light`, `solarized-light`) because it runs before any module
can be imported — keep it in step with `mode: "light"` in `store/theme.ts`.

## Crossing windows

voidlink runs up to three webviews (workbench, git, editor) and each is its own
JS context. Mutating `<html>` and writing `localStorage` only changes the window
that did it, so `applyTheme` also broadcasts the new id on
`voidlink://theme-changed` and every root subscribes via
`bridgeThemeAcrossWindows()` in `main.tsx`.

The payload carries the sending window's label. A window drops its own echo
(Tauri delivers a global emit back to the sender), and a window *applying* a
remote change does not re-broadcast — the `source` guard removes the self-hop,
not a two-window ping-pong.

Without this the editor window kept whatever theme it opened on: it is reused
rather than recreated, it hydrates once at module eval, and it has no theme UI of
its own.

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
- Editor and terminal colours follow the theme's mode. Monaco gets exactly two
  registered theme names, `voidlink-dark` and `voidlink-light`, both derived from
  the live CSS tokens — stock `vs` / `vs-dark` are only the inheritance floor.
  The xterm palette is rebuilt on the toggle.
- **Only the active mode's Monaco theme carries colours.** The other name is
  registered as a `base`-only placeholder. It has to be registered (a surface
  created mid-switch must not name an undefined theme) but it must not carry the
  active theme's hexes, or a stale `setTheme` during the Monaco chunk load paints
  a light body under a dark floor.

## Manual QA

- [ ] Open the editor in its own window. Toggle the theme in the workbench
      (title bar sun/moon). **The editor window repaints in the same frame** —
      body, gutter, widgets. It used to stay on its original theme forever.
- [ ] Same test with a **same-mode** change: Settings → Theme, `monokai` →
      `dracula`. Both windows' editors move to the new hexes. Leave the
      **Settings → JSON pane** open while doing it; that embedded editor has to
      move too (it used to track only the mode, which does not change here).
- [ ] Set `solarized-light`, quit, relaunch. **The first painted frame is
      light.** Watch for a dark flash — that is the pre-paint script failing to
      set `data-theme`.
- [ ] Repeat for `github-light` (a light theme whose id is not `"light"`) and for
      `nord` (a dark theme that is not `"dark"`).
- [ ] Open a diff tab and a merge editor, switch theme: both follow.
- [ ] Switch theme *while* the editor window is still loading Monaco (toggle
      immediately after opening it on a cold start). The editor must land on the
      theme you ended on, with a matching body and floor — never a light body in
      a dark shell.
- [ ] With both windows open, toggle the theme from each in turn. No flicker, no
      oscillation, no double-apply.
