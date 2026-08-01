# Command palette, file finder, and prompts

## What it does

Four overlays share one design: a portal, a text input that owns the keyboard,
and Escape to dismiss.

- **Command palette** (`Mod+K`) — every registered action, fuzzy-searchable.
- **File finder** (`Mod+P`) — fuzzy jump to any tracked file in the active repo.
- **Cheat sheet** (`Mod+Shift+/`) — see [keyboard shortcuts](./keyboard-shortcuts.md).
- **Prompt host** — the replacement for `window.prompt()`, which silently
  returns `null` in macOS WKWebView. Every "name this branch / stash / tag"
  flow routes through it.

## When you'd use it

The palette is the discovery surface: anything without a shortcut is still one
`Mod+K` away. The file finder is for jumping by name when you already know
roughly what the file is called.

## How to use it

### Command palette

1. `Mod+K`.
2. Type. Matching runs against the action's **label and group** — not its
   description.
3. `↑` / `↓` to move, `Enter` to run, `Esc` to close.

Disabled actions (`enabled()` returned false — usually "no repo open") stay in
the list, greyed out at 40% opacity, and `Enter` on one does nothing. That is
deliberate: seeing an action you can't use yet is more informative than the
action vanishing.

### File finder

1. `Mod+P`. Without a repo open you get the toast `Select a repository first`.
2. Type part of a path. Filename matches outrank directory matches.
3. `Enter` opens the file in the editor.

### Prompts

Prompt dialogs appear centred at 20vh with a single text field. `Enter`
confirms, `Esc` cancels, clicking the backdrop cancels. Some prompts add
checkbox toggles (stash, tag creation).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+K` | Toggle the command palette |
| `Mod+P` | Toggle the file finder |
| `Mod+Shift+/` | Toggle the cheat sheet |
| `↑` / `↓` | Move the highlight |
| `Enter` | Run / open / confirm |
| `Esc` | Close / cancel |

## How matching works

The scorer in `frontend/src/commands/CommandPalette.tsx`:

```ts
const idx = t.indexOf(q);
if (idx !== -1) return 1000 - idx;   // substring: earlier is better
// otherwise: ordered subsequence, minus the sum of the gaps
```

A direct substring scores 1000 minus its offset. Failing that, the query
characters must appear **in order**; the score is `100` minus the total gap, and
a result that goes negative is filtered out. No match returns `-1`.

The file finder adds one rule: if the substring hit starts after the last `/`,
it scores `2000 - (idx - slash)` instead, so `auth` prefers `src/auth.ts` over
`src/auth/index.ts`'s directory segment.

## Where actions come from

Actions live in a module-level signal in `frontend/src/commands/registry.ts`.
Two producers write to it:

- `frontend/src/App.tsx` re-registers the whole catalog from a `createEffect`
  whenever the active workspace or its repo root changes, so the closures always
  point at current state.
- `registry.ts` itself registers `git.commit-graph` at module load, because it
  needs no store closure — it just dispatches a window event.

`registerActions()` removes same-id entries then appends, so re-registration
reorders the list. With an empty query the palette shows actions in registration
order, unsorted.

## Gotchas and limits

- **Key handlers are bound to the `<input>`, not the container.** Click a row in
  the palette or file finder and the input loses focus — after which `Esc`,
  arrows, and `Enter` stop working. Click the input again or reopen.
- **The file finder only sees tracked files by default.** Its list comes from
  the git index, so a brand-new untracked file is invisible to `Mod+P` even
  though the file tree shows it. Toggle the eye button in the finder header
  (or `Alt+H`, or Settings → Interface → *Ignored files*) to walk the working
  tree instead: gitignored and untracked files — a repo's `.env` — become
  openable. The walk always skips `.git` and build/dependency directories
  (`node_modules`, `target`, `dist`, `build`, `.next`, `.turbo`, `.venv`,
  `venv`, `__pycache__`, `.cache`, `coverage`, `vendor`) and caps at 50k paths;
  anything tracked inside them still shows, since the index is unioned in.
  The setting is shared with the file tree, which lists ignored entries dimmed
  when it is on.
- **The file finder caps at 200 rows** in both the empty-query and filtered
  branches, with no "N more" indicator.
- **No `scrollIntoView`.** Arrowing past the visible window moves the highlight
  without scrolling the list.
- **`Mod+W` closes the active tab even with an overlay open** — it is a global
  binding and the palette does not intercept it.
- **An empty prompt value is treated as cancel.** `resolvePrompt` trims and
  resolves `null` for whitespace, so you cannot submit an empty string; clearing
  the stash message field aborts the stash.
- **Only one prompt at a time.** Opening a second resolves the first with
  `null`.
- **Overlay stacking**, lowest to highest: settings dialog `z-70`, palette and
  file finder and cheat sheet `z-80`, secret-scan dialog `z-90`, toasts `z-100`,
  prompt host `z-110`, context menus `z-9999`. Context menus render above
  everything, including toasts.
- **Toasts have no keyboard handling** — no Escape, no focus.
- **Toasts have an interruption budget.** A toast may declare a `source`, and
  two from the same source and kind collapse into one carrying a count (`×4`);
  the newest message and action win, and the dismissal window is refreshed so a
  burst does not vanish mid-way on the first push's deadline. `source` is a
  *cause* (`run:<id>`), not a category — the number has to mean "how many times
  did this one operation shout".

  A toast with no `source` never coalesces. Coalescing is a claim that two
  messages are the same news, and only the call site can make it.

  Independently, at most **four** toasts are on screen; past that the least
  severe and oldest is evicted, so a burst of successes can never push a failure
  off the stack — exactly what a fan-out produces when four legs pass and the
  fifth is the one that matters. The toast just raised is never the one evicted:
  a notice that appears and is instantly removed is indistinguishable from one
  that was never raised.

  Both rules are pure functions with unit tests in `commands/toast.ts`.
