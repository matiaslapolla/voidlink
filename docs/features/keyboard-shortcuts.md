# Keyboard shortcuts

## What it does

Every global shortcut in VoidLink comes from one declarative table:
`frontend/src/commands/keymap.ts`. That table is the only source of truth — the
key handler reads it, the command palette derives each action's accelerator
label from it, and both the cheat sheet and **Settings → Keyboard** render it.
An accelerator shown in the UI is therefore always the chord that actually
fires.

`Mod` below means the platform modifier: `⌘` on macOS, `Ctrl` everywhere else.
VoidLink accepts **either**, on every platform, so muscle memory survives a
machine switch.

## When you'd use it

Press `Mod+Shift+/` any time you can't remember a chord. The overlay is
filterable, so typing `stack` or `⌘⇧` narrows it immediately.

## The full keymap

### App

| Shortcut | Action |
|---|---|
| `Mod+K` | Show all commands (command palette) |
| `Mod+Shift+/` | Keyboard shortcuts (this cheat sheet) |
| `Mod+,` | Open settings |

`Mod+/` also opens the cheat sheet, but only when focus is **outside** the
editor and terminal — bare `Mod+/` is Monaco's toggle-line-comment.

### File

| Shortcut | Action |
|---|---|
| `Mod+P` | Open file… (fuzzy finder over tracked files) |
| `Mod+S` | Save file |

`Mod+S` stands down while a terminal pane has focus, so `Ctrl+S` still reaches
the shell as XOFF.

### View

| Shortcut | Action |
|---|---|
| `Mod+B` | Toggle left sidebar |
| `Mod+J` | Toggle git sidebar |
| `Mod+\` | Swap left/right sidebars |
| `Mod+Alt+B` | Toggle inline blame |
| `Mod+Shift+D` | Toggle inline / split diff |

### Tabs

| Shortcut | Action |
|---|---|
| `Mod+W` | Close tab |
| `Mod+Shift+W` | Close window |
| `Mod+Shift+T` | Reopen last closed tab |
| `Mod+Alt+→` | Next tab |
| `Mod+Alt+←` | Previous tab |
| `Mod+Shift+]` | Next tab (alternate) |
| `Mod+Shift+[` | Previous tab (alternate) |

Tab navigation answers to both conventions: `Mod+Alt+Arrow` is what Safari and
Chrome use, `Mod+Shift+[`/`]` is what VS Code uses. Both fire.

`Mod+W` closes the **tab**, not the window. That takes a custom application
menu to achieve: Tauri's default menu binds `Cmd+W` to Close Window, and on
macOS a menu accelerator is resolved by AppKit before the key ever reaches the
page — so the window closed and the keymap never saw it. voidlink rebuilds the
menu without that accelerator and gives closing the window `Mod+Shift+W`
instead. See `src-tauri/src/menu.rs`.

### Workspace

| Shortcut | Action |
|---|---|
| `Mod+N` | New workspace |
| `Mod+Shift+→` | Next workspace |
| `Mod+Shift+←` | Previous workspace |
| `Mod+1` … `Mod+9` | Go to workspace 1–9 |

### Terminal

| Shortcut | Action |
|---|---|
| `Mod+T` | New terminal |
| `Mod+Shift+\`` | New terminal (alternate) |
| `Mod+Shift+R` | Repeat last terminal command |

`Mod+T` opens a terminal and `Mod+N` opens a workspace, matching cmux. The
older `Mod+Shift+\`` chord still works.

### Git

| Shortcut | Action |
|---|---|
| `Mod+Alt+R` | Refresh git status |
| `Mod+Shift+F` | Fetch from origin |
| `Mod+Shift+U` | Pull from origin |
| `Mod+Shift+H` | Open commit graph |
| `Mod+Shift+C` | Compare branches… |
| `Mod+Shift+G` | Open git window |
| `Mod+Shift+M` | Draft commit message with AI |

`Mod+Shift+C` stands down while a terminal has focus, because `Ctrl+Shift+C` is
copy in most Linux terminals.

### Stack

| Shortcut | Action |
|---|---|
| `Mod+Shift+N` | Stack: branch on top of current |

### AI

| Shortcut | Action |
|---|---|
| `Mod+Shift+A` | Toggle repo agent |

## Shortcuts that are not global

These are handled by the widget that owns them, not by the keymap:

- `Mod+Enter` inside the commit message box commits (see
  [git staging](./git-staging.md)).
- `Enter` / `Shift+Enter` in the repo agent composer sends / inserts a newline.
- `↑` `↓` `Enter` `Esc` inside the palette, file finder, ref picker, and prompt
  dialogs.
- Everything Monaco and xterm handle themselves — see the gotchas below.

## How the matcher works

`frontend/src/commands/keys.ts` holds the whole comparator:

```ts
export function matches(c: Chord, e: KeyEventLike): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if ((c.meta ?? false) !== meta) return false;
  if ((c.shift ?? false) !== e.shiftKey) return false;
  if ((c.alt ?? false) !== e.altKey) return false;
  return e.key.toLowerCase() === c.key.toLowerCase();
}
```

Two consequences worth internalising:

1. **`meta` is Cmd *or* Ctrl.** A binding written `{ meta: true, key: "b" }`
   fires on both `⌘B` and `Ctrl+B`, on every platform.
2. **Modifiers must match exactly.** `{ meta: true, key: "t" }` does *not* fire
   on `⌘⇧T`; that is a separate binding.

The listener is installed on `window` in the **capture** phase and calls
`preventDefault()` + `stopPropagation()` on a match. So a matched chord never
reaches Monaco, xterm, or any focused input.

## Scopes

Because the listener wins over everything, a binding that would take a key
Monaco or a shell needs declares a scope instead:

| Scope | Behaviour |
|---|---|
| `global` (default) | Always fires. |
| `outside-terminal` | Stands down while an xterm pane has focus. |
| `outside-text-surfaces` | Stands down in a terminal *or* the Monaco editor. |

Focus detection is a `closest()` check against `.xterm` and `.monaco-editor`.
When a binding stands down, the key falls through untouched.

## Gotchas and limits

- **Bare `Mod+<letter>` bindings shadow readline.** Because `meta` matches Ctrl,
  the pre-existing `Mod+K`, `Mod+P`, `Mod+W`, `Mod+T`, `Mod+B`, `Mod+J` and
  `Mod+\` chords swallow `Ctrl+K` (kill line), `Ctrl+P` (previous history),
  `Ctrl+W` (kill word), `Ctrl+T` (transpose), `Ctrl+B` (backward char),
  `Ctrl+J` (linefeed) and `Ctrl+\` (SIGQUIT) inside a terminal pane. On macOS
  you'd normally press `⌘`, so this mostly bites on Linux and Windows. Every
  binding added since carries `Shift`, `Alt`, or a scope specifically to avoid
  widening this.
- **`Mod+K` breaks Monaco's chord family.** Monaco uses `Ctrl+K` as a prefix for
  two-stroke chords (`Ctrl+K Ctrl+C`, `Ctrl+K Ctrl+0`, …). VoidLink takes the
  first stroke, so none of them are reachable in the editor.
- **No user remapping yet.** The keymap is structured to be serialisable — plain
  ids and chord objects, no closures — so a JSON keymap can be layered on later.
  The editor UI does not exist.
- **No chord sequences.** Every binding is a single combination.
- **No vim or emacs mode.**
- **A chord's `event.key` is the shifted character.** `Shift+/` reports `?` and
  `Shift+backquote` reports `~` on a US layout, so those bindings are declared
  with the shifted value and an unshifted alternate. Labels are mapped back to
  the physical key, which is why the sheet says `⌘⇧/` and not `⌘⇧?`.

## Adding a binding

1. Add the action id to `ACTION_IDS` in `frontend/src/commands/actionIds.ts`.
2. Register the action itself in the catalog in `frontend/src/App.tsx` (or, for
   store-independent actions, `frontend/src/commands/registry.ts`).
3. Add one `KeymapEntry` to `KEYMAP` in `frontend/src/commands/keymap.ts`.

Run `npm run test` in `frontend/`. The suite fails if two entries claim the same
chord, if one action appears in two entries, or if a binding points at an id
that isn't declared. In a dev build, an id that is declared but never actually
registered logs `[keymap] unknown-action: …` to the console.

Put a second chord for the same action in that entry's `alternates` array — not
in a second entry.
