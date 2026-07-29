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

## Why the pane doesn't go black

A WebGL drawing buffer's contents are undefined after the compositor presents a
frame, and xterm only redraws rows it considers damaged. An idle terminal that
gets composited again — window blurred, app occluded, tab switched back — can
therefore come back as an empty buffer: the grid reads as completely black until
the shell happens to write something.

Two defences, because on some GPU/driver pairs the first one alone isn't enough:

- The WebGL addon is constructed with `preserveDrawingBuffer: true`, so the
  buffer survives compositing. It costs a little fill bandwidth per frame and
  touches nothing in the data pipeline.
- Regaining focus repaints. `focusin` on the pane (it bubbles, so it catches
  focus landing on xterm's hidden textarea), window `focus`, and
  `visibilitychange` each schedule a `clearTextureAtlas()` + full `refresh()` on
  the next animation frame — deferred, so the repaint lands after the window is
  actually on screen rather than on the frame about to be discarded.

Context loss is the third case: the addon is disposed, xterm falls back to the
DOM renderer, and the same repaint runs so the grid comes back immediately
instead of waiting for the next byte of output.

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

## The activity dot

**One** dot per terminal tab, in the tab's trailing slot. There used to be two —
a leading LED and a trailing mark, two lines apart in the same component, with a
comment claiming they answered different questions. They did not: both read the
same `busy` bit off the same poll, both rendered orange, and both pulsed. The
leading one is gone.

| What the shell is doing | Dot | Colour | Motion |
|---|---|---|---|
| Idle, and you are not looking at this tab | *(nothing)* | — | — |
| Idle shell, or a TUI open but not working, in the tab you are looking at | `idle` | green, no glow | still |
| A foreground process actively working — busy **and** producing output | `working` | green, glowing | pulsing |
| Something finished, or a program sent a notification, while you were elsewhere | `notify` | **cyan** | still |
| The shell exited non-zero | `failed` | red | still |

`notify` outranks `working`, and that ordering is the point of the whole design.
A TUI keeps its shell in the foreground for its entire life, so the busy signal
is live the whole time Claude Code is open — with the notification below it (where
the old blue `bell` sat, under `running`) a "I'm done, look at me" from inside a
live TUI could never be rendered. Which was exactly the event worth showing.

`failed` clears only on acknowledgement — closing the tab. Everything else clears
when you look at the tab. The same mark, from the same two sources, is what the
**sidebar row** shows: it used to run its own poll, its own notification flag, its
own orange bell icon and its own copy of the LED mapping, so the row and the tab
could disagree about the same shell for up to 1500 ms.

The full colour vocabulary, including the marks non-terminal tabs use (`dirty`,
`running`, `finished`, `stale`), lives in
`frontend/src/components/layout/StatusLed.tsx`. It is a closed set: adding one
means adding a `--<name>` token to `index.css` **and** to all eight blocks in
`themes.css`.

### Why output rate, and what it gets wrong

`busy` is `tcgetpgrp(master_fd) != shell_pid` — "is anything other than the shell
in the foreground". For `claude`, `vim`, or `lazygit` that is true from launch to
quit, so it cannot distinguish a build that is churning from a TUI merely sitting
open. Nothing about the alternate screen, the bell, or the title told us either.

So VoidLink windows the **bytes the PTY produces**: more than **256 bytes in a
500 ms window** turns output-active on, and **1500 ms of silence** turns it off.
`working = busy && outputActive`. `busy && !outputActive` is an idle TUI.

The tradeoff, stated rather than hidden: **a silent long-running command reads as
idle.** `sleep 60`, or a `curl` with no progress meter, produces no output, so it
gets the quiet focused-green dot rather than the pulsing one. Output is a proxy,
and this is the case it gets wrong. It was chosen over sampling the foreground
pid's CPU state because it needs no new IPC and no per-platform `/proc` reading,
and because the failure mode is "quiet dot" rather than "permanently wrong dot".

The 1500 ms silence threshold matches the process poll interval on purpose, so
the two clocks cannot disagree for longer than one tick.

### What counts as "finished"

The process poll samples every 1500 ms, which is coarse enough to invent events.
Two rules filter it:

- **Two samples minimum.** A command must be seen busy on two consecutive polls,
  with the same pid, before its exit counts. A 20 ms command that happens to
  straddle a tick used to be badged for a full interval. The flip side is
  unfixable from here and is the right answer anyway: a command that starts and
  ends between two ticks is invisible, and nobody wants a badge for `ls`.
- **Not a full-screen app.** If the terminal entered the alternate screen buffer
  at any point during the busy span, its exit raises nothing. Quitting `vim`
  while unfocused used to raise a green "finished" — you closed an editor, nothing
  completed.

### Notifications from inside the terminal

VoidLink registers OSC 9 (`ESC ] 9 ; body BEL`, iTerm2's convention) and OSC 777
(`ESC ] 777 ; notify ; title ; body BEL`, the urxvt/GNOME one). Either raises
`notify` and, if the tab is not being watched, one OS notification. A bell (BEL)
does the same, minus the message. This is what makes the cyan dot reachable from a
notification-capable TUI at all — a bell is easy to miss and many tools do not
send one.

The OS notification fires from one place, driven off the same signal the in-app
mark is, so the two cannot disagree. It used to fire from inside a sidebar row's
own poll, which meant no notification at all whenever the Terminals section was
collapsed.

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
- **One process poll per shell**, at 1500 ms, refcounted and shared by the tab
  strip, the pane layer and the sidebar row. The sidebar row does make one extra
  `pty_process_info` call on the same cadence for the cwd line, which is the one
  fact the shared watcher does not carry.
- **A silent long-running command reads as idle,** not working. See "Why output
  rate, and what it gets wrong" above.
- **A shell that exits non-zero keeps its tab.** A clean exit closes it as before;
  a failure has to be acknowledged, and closing the tab is the acknowledgement.
  Without that the red `failed` mark had nowhere it could ever be seen.
- **`exitCode` is `null` when the platform gives us no status** — a signal death,
  or a session already reaped. A `null` is treated as a clean exit.
- **System notifications only fire if permission was already granted.**
  VoidLink deliberately never calls `requestPermission()`.
- **A marked tab hides its close button until you hover it.** The trailing slot
  holds both, by design (a badge *and* an × reads as two controls) — but it means
  a permanently-`working` tab needs a hover before it can be closed by mouse.

## Manual QA

- [ ] **Exactly one dot per terminal tab.** Count them. There used to be two.
- [ ] Idle shell, tab **not** focused: the slot is **blank** — no grey dot.
- [ ] Idle shell, tab focused: a still green dot.
- [ ] `yes | head -c 1000000`: green and **pulsing** while it runs, then back to
      still green within ~1.5s of the last byte.
- [ ] `claude` (or `vim`, or `lazygit`) sitting at its prompt: **green, still** —
      not orange, not pulsing. This is the reported bug.
- [ ] Type into `claude` so it starts thinking: it goes to pulsing green, and
      back to still when it stops.
- [ ] `sleep 30`: reads as idle. Expected — see the gotcha.
- [ ] `ls`: no badge at all afterwards. Run it repeatedly; a tick-straddling run
      must not leave a mark.
- [ ] Switch to another tab, run `sleep 5 && echo done` in the first, wait: the
      first tab goes **cyan**. Switch to it: the cyan clears.
- [ ] Same, but alt-tab out of VoidLink entirely with the terminal tab in front.
      The badge still appears — it used to be dropped, because the tab counted as
      "visible".
- [ ] Open `vim`, switch to another tab, quit `vim`: **no** badge. Closing an
      editor is not a completion.
- [ ] `exit 1`: the tab stays and its dot goes **red**. `exit` (or `exit 0`)
      closes the tab as before.
- [ ] `printf '\033]9;build done\007'`: cyan dot, and an OS notification saying
      "build done" if you have granted permission.
- [ ] `printf '\033]777;notify;deploy;prod is live\007'`: same, body reads
      "deploy — prod is live".
- [ ] `printf '\a'` from an unfocused tab: cyan dot.
- [ ] Raise a notification from **inside** a running TUI (Claude Code finishing a
      turn while you are in another tab). The cyan dot appears even though the
      TUI still holds the foreground — this could not render before.
- [ ] Open the Terminals sidebar section. **The row and the tab show the same
      mark, at the same time.** They used to sample independently and could
      disagree by up to 1500ms.
- [ ] Collapse the Terminals section and repeat the "finished while unfocused"
      test: the OS notification still fires.
- [ ] Switch through all ten themes with a cyan dot on screen. It stays clearly
      distinct from the green `working` dot in each.
- **All PTYs are killed** on window close and on app exit.
