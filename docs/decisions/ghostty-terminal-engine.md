# Decision — should VoidLink's terminal run on Ghostty's VT engine?

**Recommendation: no. Stay on xterm.js, and spend the migration's first week on
the three pain points instead.** Of the three defects the terminal actually has,
one is already fixed, one is fixable inside xterm with an API we are already
licensed to use (`allowProposedApi` is on), and only the third — WebKitGTK
stutter under addons that hook the data pipeline — is genuinely xterm's model
leaking. libghostty-vt would not fix that third one either, because it does not
ship a renderer: the stutter is a *painting* problem in a webview, and adopting
libghostty-vt hands us the painting rather than solving it.

The migration plan is written out below anyway, in full and in phases, because
"no" is only worth reading if the "yes" it rejected was costed. It is gated on a
single throwaway spike (Phase 0) with a named kill criterion. If that spike comes
back better than expected, the fork to take is **WASM in the webview** — decided
on bytes-per-frame across the Tauri IPC boundary, which is stated with its
numbers in §3.

---

## 1. What we have

Every row cites the file and symbol it was read from. Nothing is in this table
that could not be pointed at.

### 1.1 The PTY layer (survives either way — this is not a VT-engine decision)

| Capability | Where it lives |
|---|---|
| Spawn a shell with an initial winsize | `src-tauri/src/lib.rs` — `create_pty` (L242), `portable_pty::CommandBuilder` (L267) |
| Write bytes to the shell | `src-tauri/src/lib.rs` — `write_pty` (L432); called from `TerminalPane.tsx` at five distinct sites (data, wheel, Shift+Enter, drops, repeat-last) |
| Resize the winsize | `src-tauri/src/lib.rs` — `resize_pty` (L445), `portable_pty::PtySize` |
| Attach/detach a pane to a live session | `pty_subscribe` (L477) / `pty_unsubscribe` (L502), returning `PtyAttachment { token, replay_bytes }` (L473) |
| Session registry and output fan-out | `PtyStore` (L43), `PtyChannels` (L194), `PtySink` (L61) |
| Shell exit with status | `pty-exit:<sessionId>` (L368), `PtyExitPayload` (L221), `reap_exit_code` (L235) |
| Foreground-process poll | `pty_process_info` (L1136) |
| **Byte-level scrollback + replay on re-attach** | `SCROLLBACK_CAP_BYTES = 512 KiB` (L48), `PtySink::push` (L119), `attach` (L151), `build_replay` (L169), `REPLAY_PROLOGUE` (L88), `resync` (L98) |

The last row is the one a VT engine touches. The backend today retains **raw
bytes** and replays them into a fresh emulator; it does not know what a terminal
is. `REPLAY_PROLOGUE` and `resync` exist precisely because replaying a
mid-stream cut into a stateless parser is unsound — a problem that disappears if
the engine lives in the backend and *is* the retained state (see §3.2), and
persists unchanged if the engine lives in the webview.

### 1.2 What xterm.js provides today

| Capability | Citation |
|---|---|
| Escape-sequence parsing, grid, scrollback, reflow | `new Terminal({...})`, `TerminalPane.tsx` L261 |
| Rendering (DOM default, WebGL opt-up) | `webgl2Available()` L942; `new WebglAddon(true)` L370; `preserveDrawingBuffer` rationale L360–369 |
| GL context-loss recovery + re-fit | `addon.onContextLoss` L374–388 (measured 198 vs 177 columns at dpr 1 between the two renderers) |
| Glyph-atlas invalidation | `repaint()` → `webglAddon?.clearTextureAtlas()` L428 |
| DPR change handling | `watchDpr` L453, `onDprChange` L444 |
| Repaint on focus / visibility regain | `repaintSoon` L474, `onVisibility` L482 |
| Container measurement → grid reflow | `FitAddon`, `refit()` L338 (refuses to fit while `display:none`, L336–337) |
| Grid→winsize serialisation | `publish()` L314, `term.onResize` L329, debounce `RESIZE_DEBOUNCE_MS = 150` L36 |
| Grid-size memory across remounts | `commands/terminalSize.ts` — `rememberGridSize` (L61), `sizeForPty` (L73), `lastGridSize` (L86), persisted under `voidlink-terminal-grid` (L21) |
| Unicode 15 widths + grapheme clustering | `UnicodeGraphemesAddon` L289, `term.unicode.activeVersion = "15-graphemes"` L290 |
| Ligatures (lazy, opt-in) | `ensureLigatures` L527, dynamic `import("@xterm/addon-ligatures")` L530 |
| Keyboard encoding + IME | xterm's hidden textarea; `attachCustomKeyEventHandler` L692 overrides only Shift/Alt+Enter → `ESC CR` |
| Mouse reporting + alt-scroll override | `attachCustomWheelEventHandler` L649; reads `term.modes.mouseTrackingMode` and `term.modes.applicationCursorKeysMode` L650/L671; `MAX_WHEEL_LINES = 20` L639 |
| Selection + clipboard | xterm built-in. **Nothing in `frontend/src` imports `@xterm/addon-clipboard`** (grep: the only reference is `vite.config.ts` L23) |
| Web links | **Not used.** `@xterm/addon-web-links` likewise appears only in `vite.config.ts` L22 |
| Deep links (path:line, SHA, branch) | `buildLinkProvider` L962, `buildBranchLinkProvider` L1014, `PATH_LINE_REGEX` L123, `SHA_REGEX` L128, `BRANCH_CHAR` L1006 — built on `term.registerLinkProvider`, deliberately *not* an addon (L491–494) |
| Bell | `term.onBell` L794 |
| Alt-screen detection | `term.buffer.onBufferChange` L801 → `noteTerminalAltScreen` (`store/terminalWatch.ts` L276) |
| OSC 9 / OSC 777 notifications | `term.parser.registerOscHandler(9|777)` L816–823, field unwrapping in `oscNotificationBody` L55 |
| OSC 133 semantic prompts | `term.parser.registerOscHandler(SEMANTIC_PROMPT_OSC)` L843; `store/semanticPrompt.ts` — `SEMANTIC_PROMPT_OSC = 133` (L34), `parseSemanticPrompt` (L58), `commandIsNews` (L134), `commandFailed` (L145); consumed by `noteSemanticPrompt` (`terminalWatch.ts` L334) |
| Replay gate on the input path | `replaying` L603, `replayBytesTotal` L605, `endReplay` L607, 3 s fail-open `replayGuard` L613 |
| Output-rate activity signal | `outputChannel.onmessage` L748 → `noteTerminalOutput` (`terminalWatch.ts` L239) |
| Keystroke recording / repeat-last-command | `term.onData` L616 → `recordKeystroke` (`commands/terminalHistory.ts` L31); `markActive` (L53), `repeatLastCommand` (L66) |
| 16-slot ANSI palette, per-theme | `DARK_THEME` L130, `LIGHT_THEME` L157, `DARK_BG`/`LIGHT_BG` L114–115, `palette()` L191, live swap effect L580 |
| Palette token-hygiene exemption | `frontend/src/tokenHygiene.test.ts` — `EXEMPT = new Set(["terminal/TerminalPane.tsx"])` L42, with the reason stated L34–41 |
| File drops onto the shell input line | `registerDropZone` L911, `getCurrentWebview().onDragDropEvent` L864, `injectPaths` L200, `quoteForShell` L954 |
| Settings surface | `TerminalSettings` (`store/settings.ts` L38–56), `DEFAULTS.terminal` (L419–449), `updateTerminal` (L639), dialog section `TerminalPane` (`components/settings/SettingsDialog.tsx` L1147–1223) |

### 1.3 Two findings from the inventory, unrelated to Ghostty

- **`@xterm/addon-web-links` and `@xterm/addon-clipboard` are dead dependencies.**
  Declared in `frontend/package.json` (L24, L28) and named in the `vendor-xterm`
  manual chunk (`vite.config.ts` L22–23), imported by nothing in `frontend/src`.
  Severity LOW, confidence *reading*. Removing them is a two-line change that
  does not need this decision.
- **We have no accessibility story at all today.** `screenReaderMode` is never
  set (grep over `frontend/src/components/terminal/`: no match), and with the
  WebGL renderer active the grid is canvas pixels. This matters below: the
  "libghostty has no screen-reader mode" risk is not a regression from a good
  state, it is a regression from nothing. Severity MEDIUM, confidence *proven*
  by the grep.

---

## 2. What libghostty-vt gives, and what it does not

Every API name below was retrieved from context7 during this task, against
`/websites/libghostty_tip_ghostty` (the C API) and `/ghostty-org/ghostty`
(`src/config/Config.zig`). Nothing here is from memory.

### 2.1 What it genuinely is

A terminal instance is created with `ghostty_terminal_new(allocator, &terminal,
opts)` taking `GhosttyTerminalOptions { .cols, .rows, .max_scrollback }`; bytes
are fed with `ghostty_terminal_vt_write(terminal, data, len)`; geometry changes
with `ghostty_terminal_resize(terminal, cols, rows, cell_width_px,
cell_height_px)` — note that it wants **pixel cell dimensions**, which is more
than `resize_pty` currently carries.

Drawing is a *snapshot* protocol, not a callback protocol. You create a render
state with `ghostty_render_state_new(allocator, &state)`, refresh it from the
terminal with `ghostty_render_state_update(state, terminal)`, and then read it:

- `ghostty_render_state_get(state, key, out)` with keys from
  `GhosttyRenderStateData` — `GHOSTTY_RENDER_STATE_DATA_COLS`, `_ROWS`,
  `_DIRTY`, `_ROW_ITERATOR`, `_COLOR_BACKGROUND`, `_COLOR_FOREGROUND`,
  `_COLOR_CURSOR`, `_COLOR_PALETTE`, `_CURSOR_VISUAL_STYLE`, `_CURSOR_VISIBLE`,
  `_CURSOR_BLINKING`, `_CURSOR_PASSWORD_INPUT`, `_CURSOR_VIEWPORT_X/_Y`.
- Rows via `ghostty_render_state_row_iterator_new` /
  `ghostty_render_state_row_iterator_next` / `ghostty_render_state_row_get`,
  with `GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY`, `_CELLS`, `_SELECTION` (the last
  returning `GhosttyRenderStateRowSelection { start_x, end_x }`, or
  `GHOSTTY_NO_VALUE`).
- Cells via `ghostty_render_state_row_cells_new` / `_next` / `_get` /
  `_get_multi`, with `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE`,
  `_GRAPHEMES_LEN`, `_GRAPHEMES_BUF`, `_GRAPHEMES_UTF8`, `_BG_COLOR`,
  `_FG_COLOR`, `_SELECTED`, `_HAS_STYLING`, `_RAW`.
- Colours via `ghostty_render_state_colors_get(state, &colors)` →
  `GhosttyRenderStateColors { background, foreground, ... }`.
- Dirty tracking is two-level: `GhosttyRenderStateDirty` is
  `FALSE`/`PARTIAL`/`FULL` for the frame, and each row carries its own dirty
  flag which the renderer clears with `ghostty_render_state_row_set(row_iter,
  GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY, &false)`.

The library's own documentation describes the workflow as "creating an empty
state, updating it from a terminal instance as needed, and then reading the
state to retrieve the data required for drawing a frame." **Retrieve the data
required for drawing.** There is no draw call anywhere in the surface.

### 2.2 Capability map

Legend: **✅ provided** by libghostty-vt · **🔨 ours to build** · **❌ lost**.

| Our capability | Under libghostty-vt |
|---|---|
| VT parsing, grid, scrollback | ✅ `ghostty_terminal_new` / `ghostty_terminal_vt_write` |
| Resize | ✅ `ghostty_terminal_resize` — but now needs `cell_width_px`/`cell_height_px`, which our `resize_pty` (`lib.rs` L445) does not carry |
| Unicode widths / grapheme clustering | ✅ In-engine. This is the fix for the `UnicodeGraphemesAddon` workaround (`TerminalPane.tsx` L22–31) and the Nerd Font PUA width bug (`settings.ts` L423–431). **The single strongest argument for migrating.** |
| **Rendering** | 🔨 **Entirely ours.** Snapshot only. We would write a canvas/WebGL painter: glyph atlas, cell layout, wide/zero-width handling, cursor shapes (`GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BAR/BLOCK/UNDERLINE/BLOCK_HOLLOW`), underline/strikethrough/bold/italic, DPR, font fallback for the Nerd Font PUA range |
| Ligatures | 🔨 Ghostty's own renderer does this with HarfBuzz; libghostty-vt does not draw, so on our side this becomes a shaping problem against `_GRAPHEMES_UTF8`. Realistically **lost** at first |
| Selection | ✅ Model side: `ghostty_terminal_select_word`, `_select_word_between`, `_select_line` (with `semantic_prompt_boundary = true` — better than xterm's), `_select_output`, `_select_all`; `GhosttySelection` set via `ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SELECTION, &sel)`; grid coords from `ghostty_terminal_grid_ref(terminal, GhosttyPoint{ .tag = GHOSTTY_POINT_TAG_ACTIVE, ... }, &ref)`. 🔨 Hit-testing, drag gestures and highlight painting are ours |
| Copy text out of the grid | ✅ `ghostty_formatter_terminal_new` + `ghostty_formatter_format_alloc` with `GhosttyFormatterTerminalOptions { .emit = GHOSTTY_FORMATTER_FORMAT_PLAIN, .trim, .selection }` |
| Clipboard write to the OS | 🔨 Ours (`navigator.clipboard` or Tauri) — the engine has no OS |
| OSC 133 | ✅ `GHOSTTY_OSC_COMMAND_SEMANTIC_PROMPT` in `GhosttyOscCommandType`. **Its parser wins; ours becomes a shim** — see §2.3 |
| OSC 9 / 777 notifications | ✅ `GHOSTTY_OSC_COMMAND_SHOW_DESKTOP_NOTIFICATION`. Our `oscNotificationBody` (L55) field-layout logic — the OSC 9-vs-777 disagreement — is exactly what the engine already normalises |
| OSC 52 clipboard | ✅ `GHOSTTY_OSC_COMMAND_CLIPBOARD_CONTENTS` (we do not support this today) |
| OSC 7 pwd, OSC 8 hyperlinks, ConEmu progress | ✅ `_REPORT_PWD`, `_HYPERLINK_START/_END`, `_CONEMU_PROGRESS_REPORT` (all new capability we do not have) |
| Alt-screen detection | ✅ Terminal state; readable — no `onBufferChange`-shaped event, so 🔨 we poll or diff it per frame |
| Key encoding (incl. Kitty protocol) | ✅ `ghostty_key_encoder_new`, `ghostty_key_encoder_setopt`, `ghostty_key_encoder_setopt_from_terminal`, `ghostty_key_encoder_encode(encoder, event, out_buf, size, &written)` |
| Mouse encoding | ✅ `ghostty_mouse_encoder_new`, `_setopt` with `GHOSTTY_MOUSE_ENCODER_OPT_EVENT` / `_FORMAT` (`GHOSTTY_MOUSE_FORMAT_SGR`) / `_SIZE` (`GhosttyMouseEncoderSize { screen_width, screen_height, cell_width, cell_height }`), `ghostty_mouse_event_new/_set_action/_set_button/_set_position`, `ghostty_mouse_encoder_encode` |
| **IME / dead keys** | ❌ `GhosttyKeyEvent` is a *key event*. Composition is a webview concern; xterm's hidden textarea does it for free today. 🔨 Ours, and hard |
| Kitty graphics / inline images | ✅ Model side: `GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT`, `GHOSTTY_TERMINAL_DATA_KITTY_GRAPHICS`, `ghostty_kitty_graphics_placement_iterator_new/_next`, `ghostty_kitty_graphics_image`, `_placement_pixel_size`, `_placement_viewport_pos`, and per-image/per-storage `_GENERATION` counters for texture-cache staleness. 🔨 We must supply a PNG decoder via `ghostty_sys_set(GHOSTTY_SYS_OPT_DECODE_PNG, fn)` **and** actually composite the images |
| Terminal responses to queries (`ESC[6n`, DA) | ✅ `ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, cb)` — a callback the engine calls with bytes destined for the PTY. Cleaner than our `replaying` gate hack, which exists because xterm gives us no way to tell an answer from a keystroke (`TerminalPane.tsx` L587–602) |
| Screen-reader mode | ❌ No equivalent retrieved. See §1.3 — we have none today either |
| Web links / our deep-link providers | 🔨 Entirely ours. `PATH_LINE_REGEX`/`SHA_REGEX`/branch matching would run over `_GRAPHEMES_UTF8` per row instead of `line.translateToString()`; hover/underline/click hit-testing is ours |
| Grid-size memory | ✅ Unaffected — `commands/terminalSize.ts` is engine-agnostic |
| Byte replay on re-attach | ✅ **Improved, if the engine is in the backend** — the engine holds the state, so `REPLAY_PROLOGUE`/`resync` (L88/L98) become unnecessary. ❌ **Unchanged, if the engine is in the webview** — a fresh WASM terminal per pane mount still needs the raw-byte replay, prologue and all |

### 2.3 Which OSC parser wins

**libghostty-vt's.** Running two OSC parsers over the same byte stream is how
you get sequences that one accepts and the other rejects, and our
`parseSemanticPrompt` is deliberately loose about extra fields (`semanticPrompt.ts`
L47–57) in a way the engine's typed `GhosttyOscCommandType` is not. Under a
migration, `store/semanticPrompt.ts` keeps its *policy* — `MIN_COMMAND_MS`,
`commandIsNews`, `commandFailed`, the "missing status is not a failure" rule
(L140–147) — and loses its *parsing*: `parseSemanticPrompt` becomes a mapping
from `GHOSTTY_OSC_COMMAND_SEMANTIC_PROMPT` data into `SemanticPromptMark`. The
policy is the part with the tests and the reasoning; the parsing is 15 lines.

---

## 3. The integration fork

### 3.1 Fork A — WASM in the webview

libghostty-vt compiled to WASM (`ghostty/vt/wasm.h`), replacing xterm.js
in-place. PTY bytes continue to arrive over the existing `Channel`
(`TerminalPane.tsx` L747). We paint to canvas ourselves.

The WASM surface is explicitly low-level: `ghostty_wasm_alloc_opaque`,
`ghostty_wasm_alloc_u8_array(len)`, `ghostty_wasm_alloc_u16_array`,
`ghostty_wasm_alloc_u8`, `ghostty_wasm_alloc_usize` and the matching
`ghostty_wasm_free_*`. The docs' own remark: *"The provided Wasm interface
represents a low-level interaction layer for libghostty-vt. It is recommended to
wrap these functions in a higher-level API to abstract away the complexities of
manual memory allocation and pointer management."* That wrapper is ours to
write and maintain — every `_get` is an alloc, a call, a `DataView` read, a
free.

| Criterion | Verdict |
|---|---|
| WebKitGTK | Neutral-to-worse. WASM runs fine, but the painting still happens in the same webview whose GL context we already feature-detect (`webgl2Available` L942) and whose context-loss path we already handle (L374). We would be writing a *new* renderer for the platform that broke the old one, without xterm's DOM-renderer fallback |
| IPC bytes/frame | **Unchanged.** Only raw PTY bytes cross, exactly as today |
| Build cost | One `.wasm` artifact, architecture-independent, built once by Zig and checked in or produced by one CI job. Cheapest of the two |
| `yes` flood | Good. `ghostty_terminal_vt_write` in-process; frame budget is our painter's, not IPC's |
| Full-screen TUI redraw | Good. Row-level dirty flags let us repaint only changed rows |
| `TerminalPane.tsx` survival | ~40%. The Solid lifecycle, owner discipline (L215–247), drop zones, resize debounce, DPR watch and settings effects survive. Everything touching `term.*` — roughly 500 lines — is rewritten |

### 3.2 Fork B — Rust FFI in `src-tauri`

libghostty-vt linked beside `portable-pty` (`Cargo.toml` L38). The backend owns
terminal state; the webview becomes a painter fed render-state diffs.

| Criterion | Verdict |
|---|---|
| WebKitGTK | Same renderer problem, plus a new one: the webview now repaints on IPC arrival rather than on local state change, so every frame inherits IPC latency |
| IPC bytes/frame | **This is what kills it.** Today the IPC carries PTY bytes — a `yes` flood is a few hundred KB/s of *input*. Under Fork B the IPC carries the *screen*: a 200×50 grid is 10,000 cells, and a full-screen TUI redraw at 60 fps is 600,000 cell updates/second. Even at 8 bytes/cell serialised that is ~5 MB/s of structured payload through Tauri's IPC, versus roughly nothing today. Row-level dirty flags help a scrolling `yes`; they do not help `vim` scrolling or `lazygit` refreshing |
| Build cost | **Worst.** Zig in the build for three targets (macOS arm64 + x86_64, Windows, Linux), cross-compiled or per-runner, with a `build.rs` linking a C library into a Tauri bundle. Every VoidLink contributor now needs Zig |
| `yes` flood | Best *parsing* (native Zig, no WASM boundary), worst *delivery* |
| Full-screen TUI redraw | Worst |
| `TerminalPane.tsx` survival | ~25%. Not only the emulator goes, but the whole `write_pty`-from-five-sites input model inverts |

Fork B has one genuine advantage worth naming: the backend would hold real
terminal state, which retires `SCROLLBACK_CAP_BYTES`, `REPLAY_PROLOGUE`,
`resync`, `build_replay`, and the entire `replaying` gate in `TerminalPane.tsx`
(L587–614, plus the 3-second `replayGuard`). That is ~150 lines of the app's
subtlest code deleted. It is not worth 5 MB/s of IPC.

### 3.3 Decision

**Fork A — WASM in the webview.** The deciding criterion is **bytes across the
IPC boundary per frame**: Fork A leaves it exactly where it is today (raw PTY
bytes), Fork B replaces a byte stream with a screen stream and puts the
compositor's frame budget behind a serialisation round trip on the platform
whose IPC-adjacent behaviour is already our worst-behaved surface.

Build cost is the tiebreaker in the same direction: one architecture-independent
`.wasm` versus per-platform native artifacts and Zig on every contributor's
machine.

This decision is conditional on migrating at all — see §7.

---

## 4. Ghostty-style customisation in our settings

**Single source of truth: our JSON settings.** We do *not* adopt Ghostty's
config file format or its theme files. Two reasons, both structural rather than
aesthetic:

1. `store/settings.ts` is already the one file that persists (`STORAGE_KEY =
   "voidlink-settings"`, L403), merges forward (`mergeDefaults`, L485), and is
   editable both through the dialog and through Settings → JSON. A second config
   file would mean two places to look when the terminal renders wrong.
2. Ghostty's `theme` key and our `store/theme.ts` light/dark mode would fight.
   `palette()` (`TerminalPane.tsx` L191) swaps the ANSI table on app theme
   change; a Ghostty theme file would have to be re-read on the same event, at
   which point it is our theme system with an extra file in it.

What we *do* adopt is Ghostty's **vocabulary** — its key names and its value
semantics — mapped onto `terminal.*`. Where a Ghostty key has no equivalent
retrieved from context7, the row says so rather than inventing one.

### 4.1 Mapping table

`E` = exists today · `R` = exists, renamed or re-semanticised · `N` = new.

| Ghostty key (retrieved) | `terminal.*` key | State | How it reaches the engine |
|---|---|---|---|
| `font-family` | `fontFamily` | E (`settings.ts` L432) | Renderer-side font selection. Engine never sees it |
| `font-size` (default 13 macOS / 12 else) | `fontSize` | E (L433) | Renderer; feeds `cell_width_px`/`cell_height_px` into `ghostty_terminal_resize` |
| `font-thicken` (bool, macOS only) | `fontThicken` | N | Renderer only |
| `font-feature` (`-calt` disables ligatures) | `ligatures` | R — inverted meaning (today it loads an addon, L527) | Renderer/shaper only |
| `adjust-cell-height` (int px or %) | `lineHeight` | R — our value is a multiplier, Ghostty's is a delta | Renderer; changes `cell_height_px` |
| `adjust-cell-width` | `letterSpacing` | R | Renderer; changes `cell_width_px` |
| — (no retrieved key; Ghostty uses separate `font-family-bold` etc.) | `fontWeight`, `fontWeightBold` | E (L435–436) | Renderer only. **Kept as ours** — these are CSS-renderer concepts with no Ghostty analogue |
| `cursor-style` (`block`/`bar`/`underline`/`block_hollow`) | `cursorStyle` | R — gains `block_hollow`, matching `GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK_HOLLOW` | Engine default + renderer |
| `cursor-style-blink` (`true`/`false`/null) | `cursorBlink` | R — gains a tri-state null ("follow the app") | Renderer, cross-checked against `GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING` |
| `cursor-color` | `cursorColor` | N | Renderer; overrides `GHOSTTY_RENDER_STATE_DATA_COLOR_CURSOR` |
| — | `cursorWidth` | E (L441) | Renderer only |
| `selection-background` / `selection-foreground` (hex, X11 name, or `cell-foreground`/`cell-background` since 1.2.0) | `selectionBackground`, `selectionForeground` | N — today these are literals inside `DARK_THEME`/`LIGHT_THEME` (L134, L161) | Renderer; row ranges from `GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION` |
| `palette` | `palette` (16 slots × 2 modes) | N — today literals L130–178 | Renderer; overrides `GHOSTTY_RENDER_STATE_DATA_COLOR_PALETTE`. **Inherits the `tokenHygiene.test.ts` exemption reasoning verbatim** (L34–41): an ANSI table is a claim about someone else's output, not chrome. Whatever surface holds it must still never read `--background` or `--canvas` |
| `theme` | — | **Rejected** | Our `store/theme.ts` owns light/dark. One palette per mode, chosen by us |
| `background-opacity` (f64 0.0–1.0) | `backgroundOpacity` | N | Renderer. **Blocked by a documented constraint**: `TerminalPane.tsx` L98–99 says canvas transparency is unreliable across WebKitGTK and caused visible gaps. Ship at 1.0 and behind a note |
| `window-padding-x` / `window-padding-y` (points, or `left,right`) | `paddingX`, `paddingY` | N | Renderer; shrinks the fit rect, so it must run through `refit()` (L338) |
| `scrollback-limit-lines` / `scrollback-limit-bytes` | `scrollback` | R — ours is lines only (L442); Ghostty has both | `GhosttyTerminalOptions.max_scrollback`. Also needs reconciling with backend `SCROLLBACK_CAP_BYTES` (`lib.rs` L48) |
| `mouse-scroll-multiplier` | `scrollSensitivity` | E (L447) | Our wheel handler (L649) and/or `ghostty_mouse_encoder_setopt` |
| `mouse-hide-while-typing` (default false) | `mouseHideWhileTyping` | N | Renderer/DOM only |
| `mouse-shift-capture` | `mouseShiftCapture` | N | Input path |
| `mouse-reporting` (default true) | `mouseReporting` | N | `ghostty_mouse_encoder_setopt(..., GHOSTTY_MOUSE_ENCODER_OPT_EVENT, ...)` |
| `copy-on-select` (default true on macOS/Linux) | `copyOnSelect` | N | Ours: formatter + `navigator.clipboard` |
| `clipboard-read` (`ask`) / `clipboard-write` (`allow`) | `clipboardRead`, `clipboardWrite` | N | Gates our handling of `GHOSTTY_OSC_COMMAND_CLIPBOARD_CONTENTS` (OSC 52), which we do not support today |
| — (`minimum-contrast` exists in Ghostty but was **not** retrieved in this session) | `minimumContrastRatio` | E (L444) | Renderer. Marked unverified on purpose |
| — (`bold-is-bright` exists in Ghostty but was **not** retrieved) | `drawBoldTextInBrightColors` | E (L443) | Renderer. Unverified |
| — (`macos-option-as-alt` exists but was **not** retrieved) | `macOptionIsMeta` | E (L445) | `ghostty_key_encoder_setopt`. Unverified |
| — | `rightClickSelectsWord` | E (L446) | Ours; maps onto `ghostty_terminal_select_word` |
| — | `scrollOnUserInput` | E (L448) | Ours (viewport policy) |

Net: **17 keys exist**, **6 are renames or re-semanticisations**, **12 are new**.
The dialog section that grows is `TerminalPane` in `SettingsDialog.tsx` (L1147);
its `Section` blocks — Font, Cursor, Behavior, Scroll, Shell integration — need
two more: **Colors** (palette, selection, cursor colour) and **Window** (padding,
opacity).

**The honest note on this section:** of those 12 new keys, exactly **two** —
`palette` and `selectionBackground`/`selectionForeground` — require the Ghostty
engine at all. The other ten (padding, opacity, copy-on-select, mouse-hide,
font-thicken, clipboard policy, …) are things we could add to the xterm pane
this month. "Ghostty's config surface is the point of adopting it" does not
survive contact with the mapping: the config surface is mostly *renderer*
config, and we do not get Ghostty's renderer.

---

## 5. Phased plan, with a kill switch

Flag name: **`experimental.ghosttyTerminal`** — added to `ExperimentalSettings`
(`settings.ts` L379) and `DEFAULTS.experimental` (L479), following the precedent
`agentDashboard` set (commit a32565d, "the first experimental flag"). Default
`false` at every phase until Phase 5.

### Phase 0 — Spike (throwaway branch, nothing merged)

Build libghostty-vt to WASM with Zig. Wire the smallest possible harness: feed a
captured `lazygit` session's bytes through `ghostty_terminal_vt_write`, drive
`ghostty_render_state_update` + the row/cell iterators, paint to a canvas with a
naive glyph atlas. Run it inside a real Tauri WebKitGTK build.

- **Acceptance:** sustained 60 fps on a full-screen redraw at 200×50; the
  WASM→JS `_get`-per-cell wrapper cost measured, not estimated; a Nerd Font
  prompt renders at the correct column.
- **Kill criterion:** if the naive painter cannot hold 30 fps on WebKitGTK, or
  if the per-cell FFI wrapper is more than ~2× the cost of xterm's row write,
  **stop here and do §7 instead.** Delete the branch.
- **Rollback:** nothing merged.

### Phase 1 — Engine beside xterm, one pane

`GhosttyTerminalPane.tsx` as a sibling of `TerminalPane.tsx`. Same props
interface (`TerminalPaneProps`, L62), same `pty_subscribe` contract, same drop
zone registration. `experimental.ghosttyTerminal` selects which component the
pane host mounts. xterm untouched.

- **Acceptance:** with the flag on, a shell spawns, echoes, resizes correctly
  (`resize_pty` sees the same cols/rows the grid uses), and survives a worktree
  switch. With the flag off, zero behaviour change — provable by the existing
  test suite passing unmodified.
- **Rollback:** flag off. One boolean.

### Phase 2 — Inventory parity

Re-implement, in this order (riskiest first): OSC 133 → `SemanticPromptMark`
via `GHOSTTY_OSC_COMMAND_SEMANTIC_PROMPT`; OSC 9/777 → `onNotify` via
`GHOSTTY_OSC_COMMAND_SHOW_DESKTOP_NOTIFICATION`; alt-screen → `noteTerminalAltScreen`;
output-rate → `noteTerminalOutput`; keystrokes → `recordKeystroke`; selection +
copy via the formatter; the three deep-link providers; wheel/alt-scroll; the
Shift+Enter `ESC CR` override; file drops; bell.

- **Acceptance:** every row of §1.2 marked ✅ or 🔨 has a passing test or a
  documented manual check. Specifically: a failing `cargo build` under the flag
  produces a red `failed` mark (the capability `semanticPrompt.ts` exists for),
  and re-attaching a pane produces **no** `[57;1R` litter — which under Fork A
  means `GHOSTTY_TERMINAL_OPT_WRITE_PTY` is gated during replay exactly as
  `replaying` is today.
- **Rollback:** flag off.

### Phase 3 — Settings surface

Land the §4.1 mapping: 6 renames behind `mergeDefaults` compatibility shims, 12
new keys, two new `Section` blocks in `SettingsDialog.tsx`'s `TerminalPane`. The
`palette` key moves the ANSI table out of `TerminalPane.tsx`'s literals, which
means `tokenHygiene.test.ts`'s `EXEMPT` set (L42) must move with it — the
exemption follows the palette, and the reasoning in its comment is copied to
wherever it lands.

- **Acceptance:** every renamed key round-trips an existing settings blob
  through `mergeDefaults` without changing rendered output; the JSON view shows
  no orphan keys.
- **Rollback:** flag off leaves the new keys inert (the `showIdleAgents`
  precedent at L384–391: an inert nested flag is better than one that rewrites
  its parent).

### Phase 4 — Default flip

`experimental.ghosttyTerminal` defaults `true`. xterm still present, still
reachable by turning the flag off.

- **Acceptance:** two weeks of daily use on macOS and Linux with no regression
  reported against the §1.2 inventory.
- **Rollback:** flip the default back — a one-line change, no data migration.

### Phase 5 — Remove xterm

Delete `TerminalPane.tsx`'s xterm implementation, drop the six `@xterm/*`
dependencies from `frontend/package.json` (L24–30), and **remove the
`vendor-xterm` manual chunk from `frontend/vite.config.ts` (L19–25) entirely** —
not just its entries, since a `manualChunks` group naming nothing is a build
warning waiting to happen. Remove the flag.

- **Acceptance:** `vite build` produces no `vendor-xterm` chunk and no
  unresolved-import warning; bundle size measured before and after.
- **Rollback:** revert the commit. This is the only phase without a runtime
  rollback, which is why it is last and why Phase 4 is two weeks long.

---

## 6. Risks and open questions

Each with the experiment that settles it. Severity/confidence per the
`docs/audits/README.md` convention.

| # | Risk | Severity / confidence | Experiment that settles it |
|---|---|---|---|
| R1 | **WebKitGTK rendering performance.** We would be writing a canvas renderer for the platform on which xterm's *existing, mature* renderers stutter (`TerminalPane.tsx` L22–31, commit 0b9bfe7) | HIGH / *reading* | Phase 0. Paint a 200×50 grid at 60 fps in a real WebKitGTK Tauri build. This is the whole spike |
| R2 | **The per-cell WASM boundary.** `ghostty_render_state_row_cells_get` is one FFI call per data key per cell; `_get_multi` batches but still crosses per cell. 10,000 cells × several keys per frame is a lot of boundary | HIGH / *reading* | Phase 0. Benchmark `_get_multi` against `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW` — if `_RAW` exposes a row slice we can read directly out of WASM memory with one `DataView`, R2 mostly evaporates. **This is the single most valuable unknown to resolve first** |
| R3 | **Build reproducibility with Zig.** Fork A needs one `.wasm`; the question is whether it is checked in (reproducibility risk, review-blindness) or built in CI (a Zig toolchain pinned per version) | MEDIUM / *reading* | Build the same commit on macOS and Linux, `sha256sum` the two `.wasm` outputs. Identical → check it in. Different → CI job with a pinned Zig |
| R4 | **IME and dead keys.** `ghostty_key_encoder_encode` takes a `GhosttyKeyEvent`; composition is not in that model. xterm's hidden textarea gives us this for free today | HIGH / *reading* | Type `´` + `e` → `é`, and a full CJK composition, into a hidden-textarea prototype feeding the key encoder, on all three platforms. Any regression here is a hard blocker: it breaks typing for non-English users |
| R5 | **Accessibility.** No libghostty equivalent to xterm's `screenReaderMode` was retrieved | LOW / *proven* | None needed — §1.3: `screenReaderMode` is not set anywhere in `frontend/src/components/terminal/`, so there is nothing to regress. Record it as a known gap in both worlds |
| R6 | **Kitty graphics.** Enabling it requires us to supply a decoder (`ghostty_sys_set(GHOSTTY_SYS_OPT_DECODE_PNG, …)`) *and* composite placements. Enabling the model without the compositor means images are stored, consuming the storage limit, and never drawn | MEDIUM / *reading* | Decide explicitly: ship with `GHOSTTY_TERMINAL_OPT_KITTY_IMAGE_STORAGE_LIMIT` unset (protocol off) until a renderer exists. A half-supported image protocol is worse than none — programs probe for it and then draw nothing |
| R7 | **Licence.** Ghostty is MIT; `LICENSE` at the repo root is VoidLink's own | LOW / *suspected* | Read `LICENSE` in the `ghostty-org/ghostty` tree at the pinned commit and confirm libghostty-vt is not separately licensed. Not settled by anything retrieved in this session |
| R8 | **Ligatures regress to nothing.** Ghostty shapes with HarfBuzz in its renderer; we would have neither | MEDIUM / *reading* | Accept the regression (the setting defaults `false`, `settings.ts` L438) or ship a shaping step. Do not pretend the key still works |
| R9 | **`ghostty_terminal_resize` wants pixel cell dimensions** that `resize_pty` (`lib.rs` L445) does not carry | LOW / *proven* | Additive backend change; no experiment needed, but it is a Phase 1 task nobody would predict from the current code |
| R10 | **API churn.** The library is young; `GHOSTTY_ENUM_MAX_VALUE` sentinels and `GHOSTTY_INIT_SIZED` struct-size fields in every retrieved example are ABI-versioning machinery, which is evidence the surface expects to move | MEDIUM / *reading* | Pin an exact commit. Re-run the §2 context7 queries before each phase and diff the symbol list |

---

## 7. Recommendation

**Stay on xterm.js.** Do not migrate. Do not run Phase 0 unless something
changes.

The criterion that decided it: **libghostty-vt does not fix the problem we
actually have.** The three pain points named in the brief are, on the evidence:

1. **WebGL and ligature addons stutter under WebKitGTK** (`TerminalPane.tsx`
   L22–31). This is a *rendering* problem. libghostty-vt ships no renderer —
   `ghostty_render_state_get` hands you data "required for drawing a frame" and
   stops. Migrating replaces a stuttering mature renderer with a stuttering new
   one we wrote, on the same webview, without xterm's DOM fallback (L352, L391).
   **Not fixed. Made worse in expectation.**
2. **Unicode graphemes force-loaded because xterm's default tables garble Ink
   TUIs.** Already fixed, in the current code, at L288–294. The cost is one
   addon on the data pipeline. Ghostty would fold it into the engine — a real
   but small win.
3. **Nerd Font *Mono* variants pinned because xterm mis-measures PUA
   codepoints** (`settings.ts` L423–431). This is the one genuine, unfixed
   xterm-model defect. It is also fixable *inside xterm*: `allowProposedApi` is
   already `true` (L263) for `term.unicode.activeVersion`, and the same proposed
   `term.unicode` surface takes a custom version provider — registering one that
   reports width 2 for the Nerd Font double-width PUA ranges lets us drop the
   Mono-first pin. Verify the provider signature against the xterm 6 typings
   before committing to it; it is a day of work if it holds, and a
   documented-limitation if it does not.

So: one of three already fixed, one fixable in a day inside the current engine,
one not fixed by the migration at all. Against that, the migration costs a
renderer, a glyph atlas, a shaping story, an IME path (R4), a Zig artifact in CI
(R3), and a rewrite of ~500 of `TerminalPane.tsx`'s 1,091 lines — a file whose
comment density is not decoration but the record of every bug that has been
fixed in it (owner discipline L215–247, the replay gate L587–602, `preserveDrawingBuffer`
L360–369, the 198-vs-177-column measurement L382–387). Every one of those
learnings is xterm-shaped and would have to be re-learned against a renderer
that has never met a user.

**What to do instead, this month:**

1. Fix pain point 3 with a custom `term.unicode` version provider, and delete
   the Mono-first pin from `settings.ts` L432 if it holds.
2. Delete the two dead xterm dependencies (§1.3) and their `vite.config.ts`
   chunk entries.
3. Add the ten §4.1 keys that need no engine change — padding, `copy-on-select`,
   mouse-hide-while-typing, clipboard policy for OSC 52, palette and selection
   colours as settings rather than literals. Ghostty's *vocabulary* is worth
   adopting even when its engine is not. Moving the palette out of literals also
   retires the `tokenHygiene.test.ts` exemption (L42), which is a small,
   unambiguous improvement.

**What would change this answer.** Three things, any one of which is worth
re-opening on: libghostty-vt shipping a reference WebGL/canvas renderer or a
maintained JS binding; `GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_RAW` turning out to
expose a directly-readable row slice, collapsing R2 and making a painter a
weekend rather than a quarter; or xterm.js becoming unmaintained. Until then the
exciting answer and the correct one are not the same answer.
