# Terminal

## What it does

Real PTY sessions, one per terminal tab, rendered with xterm.js. The Rust side
uses `portable-pty` 0.8; each session gets a UUID and lives in a `DashMap` for
the life of the process. Output streams back over a Tauri IPC `Channel` as raw
bytes, not as events.

## When you'd use it

For anything VoidLink's git UI doesn't cover — interactive rebase, `git bisect`,
running your test suite, or just being in a shell without leaving the window.

## How to use it

1. Open a repo in the workspace. **A terminal cannot be spawned without one** —
   the spawn action returns early if the workspace has no repo root.
2. `Mod+Shift+\``, the `+` in the terminal sidebar, or the `+` tab menu →
   `New terminal`.
3. The PTY opens at the workspace's repo root, running your `$SHELL` with
   `-l -i` (login + interactive). If `$SHELL` is unset it falls back to
   `/bin/sh`.
4. Kill it with the X on the tab or the sidebar row, or with `Mod+W`.

### Deep links in terminal output

The pane registers two link providers over the scrollback:

- **Paths** matching a closed whitelist of extensions, optionally with
  `:line`, open in the editor and reveal that line.
- **Commit SHAs** (`\b[0-9a-f]{7,40}\b`) open a compare tab of `<sha>^ .. <sha>`.
- **Branch names** returned by the local branch list check out that branch via
  the same safe-checkout flow as the sidebar.

### Drag and drop

Dropping a file — from the OS or from VoidLink's file tree — writes its
shell-quoted path plus a trailing space into the PTY. Quoting is bare for
`[\w@%+=:,./-]+`, single-quoted otherwise.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Mod+Shift+\`` | New terminal |
| `Mod+Shift+R` | Repeat the last command in the last-used terminal |
| `Mod+W` | Kill the active terminal (it is the active tab) |
| `Shift+Enter` / `Alt+Enter` | Newline instead of submit — writes `ESC CR` to the PTY |

Everything else goes to the shell: whatever the app's global keymap doesn't
take, xterm encodes and writes to the PTY. The one exception is the
`attachCustomKeyEventHandler` for `Shift+Enter`.

### Multiline input

xterm.js encodes `Shift+Enter` as a bare CR, indistinguishable from `Enter`, so
by default there is no way to type a second line. The pane intercepts it (and
`Alt+Enter`, which is only `ESC CR` when `macOptionIsMeta` is on) and writes
`\x1b\r` — the sequence Claude Code's own `/terminal-setup` configures in iTerm2
and VS Code, and the one Ink-based TUIs read as "newline".

In a plain shell this depends on the shell's keymap: zsh's emacs keymap binds
`^[^M` to `self-insert-unmeta`, so the line grows instead of running. **bash
leaves `\e\r` unbound**, so `Shift+Enter` does nothing there — use a trailing
`\` for line continuation. The chord is never recorded as a keystroke, so it
does not disturb `Mod+Shift+R`.

## Environment

The PTY environment is **cleared and rebuilt**, not inherited. When Tauri is
launched from Finder or the Dock it inherits a minimal `PATH`, and a login shell
that sees a pre-populated `PATH` only appends to it — so `claude`, `node`, and
mise-installed binaries resolve to stale system copies or not at all.

The fix: `env_clear()`, then re-export only these:

```
HOME USER LOGNAME SHELL LANG LC_ALL LC_CTYPE LC_MESSAGES LC_COLLATE
LC_NUMERIC LC_TIME LC_MONETARY TZ TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME
XDG_CACHE_HOME XDG_RUNTIME_DIR DISPLAY WAYLAND_DISPLAY SSH_AUTH_SOCK
```

plus `TERM=xterm-256color` and `COLORTERM=truecolor`. `PATH` is deliberately
dropped so `/etc/zprofile`'s `path_helper` and your shell rc files rebuild it
from scratch, exactly as Terminal.app would.

## Addons

| Addon | When | Why |
|---|---|---|
| `addon-fit` | always | Grid sizing against the container. |
| `addon-unicode-graphemes` | always | Unicode 15 width tables plus `Intl.Segmenter` clustering. Without it, Ink-based TUIs drift column-wise and render garbled. |
| `addon-webgl` | when WebGL2 probes successfully | GPU glyph atlas. Failure is silent by design — the pane must never blank. |
| `addon-ligatures` | opt-in via **Settings → Terminal → Ligatures** | Lazily imported. Off by default. |

`@xterm/addon-clipboard` and `@xterm/addon-web-links` are dependencies but are
**not loaded** — link handling is hand-rolled through `registerLinkProvider` to
sidestep the addon's data-pipeline hook.

## Resize

A `ResizeObserver` triggers a fit, debounced 150 ms, and `resize_pty` is only
invoked when the column or row count actually changed. Immediately after mount
the pane sends a corrective resize with the real dimensions, because the PTY is
opened at a hardcoded 80×24 — without that, a TUI launched in the first moments
renders at the wrong size.

Going from hidden to visible re-fits on the next animation frame and forces a
full refresh, because a `display: none → block` transition does not fire
`ResizeObserver`.

A `matchMedia('(resolution: <dpr>dppx)')` listener catches the window moving
between displays of different pixel density. The WebGL glyph atlas is built for
one DPR, so without this the grid stays blurry after the move; on change we
call `clearTextureAtlas()`, refresh, and re-arm the query for the new DPR.

## Scrolling

Three different things happen depending on what is on screen:

| State | Wheel behaviour |
|---|---|
| Normal buffer (a shell) | Scrolls xterm's own scrollback — 5000 lines by default, `Shift+PageUp` / `Shift+PageDown` do the same from the keyboard. |
| Alternate screen, app has mouse reporting on (lazygit, `vim` with `set mouse`) | Raw wheel events are forwarded; the app scrolls itself. |
| Alternate screen, no mouse reporting (most Ink/Ratatui TUIs) | VoidLink sends cursor keys — "alternate scroll". |

That last case is handled by our own `attachCustomWheelEventHandler`, not by
xterm. xterm's built-in fallback emits exactly **one** arrow key per wheel
event regardless of how far the wheel turned, and ignores `scrollSensitivity`,
which makes a full-screen TUI feel like it doesn't scroll at all. Ours
accumulates the true delta (pixel, line, and page delta modes), converts it to
whole rows against the measured row height, applies
**Settings → Terminal → Scroll sensitivity**, and sends that many
`ESC [ A`/`ESC [ B` — `ESC O A`/`ESC O B` when the app has requested
application cursor keys. One gesture is capped at 20 rows so a trackpad flick
can't flood the PTY.

## Gotchas and limits

- **Terminals always open at the workspace's repo root.** There is no per-cwd
  spawn API. Snapshot restore re-spawns at the repo root too, not at the cwd it
  recorded.
- **The tab title follows the foreground process.** While a command runs, the
  tab and the sidebar row show its name instead of `Terminal N`; the static
  label stays in the tooltip and returns when the process exits. The name is
  polled, so it lags a command's start by up to 1500 ms.
- **The process name is a heuristic, not `comm`.** It is the foreground
  process group's executable basename (`proc_pidpath` on macOS,
  `/proc/{pid}/exe` on Linux). When that is a runtime — `node`, `python`,
  `bun`, `env`, a shell — the first non-flag argv entry is used instead, so
  `node .../cli.js` reads as the package directory (`claude-code`) rather than
  `node`. argv comes from `sysctl kern.procargs2` on macOS and
  `/proc/{pid}/cmdline` on Linux. Windows reports no name at all.
- **cwd** comes from `proc_pidinfo(PROC_PIDVNODEPATHINFO)` on macOS and
  `/proc/{pid}/cwd` on Linux. The "busy" indicator, which uses `tcgetpgrp`,
  works on both.
- **Repeat-last-command tracks keystrokes, not history.** It records printable
  characters, handles backspace, resets on `Ctrl+C` / `Ctrl+U`, and snapshots on
  Enter. A command recalled with the up arrow is never recorded, so
  `Mod+Shift+R` will not repeat it. Failure reasons are
  `No terminal has been used yet` and
  `No previous command recorded for this terminal`.
- **Several app chords are taken before the shell sees them.** See the gotchas
  in [keyboard shortcuts](./keyboard-shortcuts.md) — `Ctrl+K`, `Ctrl+P`,
  `Ctrl+W`, `Ctrl+T`, `Ctrl+B`, `Ctrl+J`, and `Ctrl+\` are all swallowed.
  `Ctrl+C`, `Ctrl+D`, `Ctrl+Z`, `Ctrl+L`, `Ctrl+A`, `Ctrl+E`, `Ctrl+U`,
  `Ctrl+R`, and `Ctrl+S` reach the PTY.
- **The SHA link regex matches any 7+ hex-digit word**, so hashes and hex blobs
  in output become clickable.
- **Clicking a root commit's SHA link produces an error** — the compare tab asks
  for `<oid>^`, which doesn't resolve.
- **Two pollers run per terminal** at 1500 ms when both the sidebar row and the
  tab are mounted.
- **System notifications only fire if permission was already granted.**
  VoidLink deliberately never calls `requestPermission()`.
- **All PTYs are killed** on window close and on app exit.
