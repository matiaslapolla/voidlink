# Stream F — Plan: replace xterm.js with Ghostty's VT engine

```text
<context>
VoidLink's terminal is xterm.js 6 in the webview, fed by a `portable-pty` backend in
Rust over a Tauri `Channel`. It works, but it is the surface with the most accumulated
workarounds in the codebase: the WebGL and ligature addons are opt-in because they
stutter under WebKitGTK, the Unicode-graphemes addon is force-loaded because xterm's
default tables garble modern Ink-based TUIs, and the default font stack is pinned to
Nerd Font *Mono* variants specifically because xterm mis-measures the private-use
codepoints. Every one of those is xterm's model of the world leaking into ours.

Ghostty is the terminal that got those right. Its VT engine ships separately as
libghostty-vt: a C library providing escape-sequence parsing, terminal and screen state,
scrollback, selection, OSC and SGR parsers, key and mouse encoding, kitty graphics,
Unicode layout, and a render-state API (`ghostty_render_state_new` /
`ghostty_render_state_update`) that hands you a snapshot of everything needed to draw a
frame. It has both a native C API and a WASM build (`ghostty/vt/wasm.h`).

**libghostty-vt is an engine, not a widget: it does not draw.** Adopting it means we
own the renderer, the input path and the DOM/canvas integration that xterm.js currently
provides. That is the central cost, and this plan exists to size it honestly before
anyone writes code.

The deliverable here is a plan document. Do not implement the migration.
</context>

<task>
Write `docs/decisions/ghostty-terminal-engine.md`: a migration plan a fresh agent could
execute in phases, and that Matias could reject on the evidence in it.

It must cover:

1. **What we have.** Inventory every capability the current terminal provides and every
   consumer that depends on it — enumerate them from the code, not from memory. At
   minimum: PTY lifecycle and resize, OSC 133 semantic prompts, OSC 9 / OSC 777
   notifications, alt-screen detection, activity/idle marks, terminal history and
   keystroke recording, grid-size memory, selection and clipboard, web links, ligatures,
   the 16-slot ANSI palette, per-theme terminal colours, and every `terminal.*` setting.

2. **What libghostty-vt gives and what it does not.** Query context7
   (`resolve-library-id` → `query-docs`) against `/websites/libghostty_tip_ghostty` for
   the render-state, screen, grid-ref, OSC, key/mouse and WASM APIs, and against
   `/ghostty-org/ghostty` for the configuration surface. Map each inventoried capability
   to: provided by libghostty-vt / must be built by us / lost. Be explicit about the
   renderer — there isn't one.

3. **The integration fork, decided with reasons.** Compare at least:
   - **WASM in the webview** — libghostty-vt compiled to WASM, replacing xterm.js
     in-place; we render to canvas/WebGL ourselves; PTY bytes still arrive over the
     existing Channel.
   - **Rust FFI in `src-tauri`** — libghostty-vt linked into the Tauri backend beside
     `portable-pty`; the backend owns terminal state and ships render-state diffs to the
     webview, which becomes a thin painter.
   Judge each on: WebKitGTK behaviour (the platform that broke the xterm addons), bytes
   crossing the IPC boundary per frame, build/toolchain cost (Zig in the build, per-platform
   artifacts, CI), latency under a `yes` flood and a full-screen TUI redraw, and how much
   of `TerminalPane.tsx` survives. Pick one and say why.

4. **Ghostty-style terminal customisation in our settings.** Ghostty's config surface is
   the point of adopting it, not a side effect. Enumerate the config keys worth exposing
   (font family/size/thickness, line height and cell adjustments, cursor style and blink,
   theme/palette, padding, background opacity, selection colours, scrollback, mouse
   behaviour), map each to a `terminal.*` key in `frontend/src/store/settings.ts` —
   marking which already exist, which are renames, and which are new — and specify how
   they reach the engine. Say whether we adopt Ghostty's own config file format/theme
   files or keep our JSON settings as the single source; do not leave two ways to
   configure the terminal.

5. **Phased plan with a kill switch.** Phases sized so each ends with the app working:
   engine behind a feature flag beside xterm, one pane at a time, then the settings
   surface, then removal of xterm. Name the flag (`experimental.*` already exists), the
   rollback at each phase, and the per-phase acceptance criteria.

6. **Risks and open questions**, each with the experiment that would settle it. Include
   at minimum: WebKitGTK rendering performance, macOS/Windows/Linux build reproducibility
   with a Zig-built C library, IME and dead-key input, accessibility (xterm's screen-reader
   mode has no libghostty equivalent), kitty-graphics and image protocol support, and
   licence compatibility.

7. **A recommendation.** Migrate, migrate partially, or stay on xterm and fix the
   specific pain points. State it in the first paragraph of the document as well as at
   the end — a plan that buries its conclusion is a plan nobody reads.
</task>

<reuse>
- `frontend/src/components/terminal/TerminalPane.tsx` — the whole file, and especially
  its header: the prior perf learning about WebKitGTK and xterm addons (commit 0b9bfe7)
  is the single most load-bearing constraint on this decision, and the OSC 9 / OSC 777
  parsing is a capability that must survive.
- `frontend/src/store/terminalWatch.ts` — `noteSemanticPrompt`, `noteTerminalAltScreen`,
  `noteTerminalOutput`.
- `frontend/src/store/semanticPrompt.ts` — `parseSemanticPrompt`, `SEMANTIC_PROMPT_OSC`
  (OSC 133). libghostty-vt has its own OSC parser; the plan must say which one wins.
- `frontend/src/commands/terminalSize.ts` — `lastGridSize`, `rememberGridSize`,
  `sizeForPty`.
- `frontend/src/commands/terminalHistory.ts` — `markActive`, `recordKeystroke`.
- `frontend/src/store/settings.ts` — the `terminal` block in `DEFAULTS` (~L419) and
  `TerminalSettings`; read the comment above `fontFamily`, which documents exactly the
  xterm width bug Ghostty would fix.
- `frontend/src/components/settings/SettingsDialog.tsx` — `TerminalPane` (~L1147), the
  section this plan's settings surface lands in.
- `frontend/src/tokenHygiene.test.ts` — the documented exemption for the terminal's ANSI
  palette, and the reasoning behind it. Any new palette surface inherits that reasoning.
- `src-tauri/src/lib.rs` — the pty commands (`pty_subscribe`, `pty_unsubscribe`,
  `pty_process_info`, the `portable_pty` spawn at ~L253), `PtyStore`, `PtyChannels`, and
  the `pty-exit:<sessionId>` event contract.
- `src-tauri/Cargo.toml` — `portable-pty = "0.8"`.
- `frontend/vite.config.ts` — the `vendor-xterm` manual chunk, which the removal phase
  has to unwind.
- `docs/audits/` and `docs/features/` for the house style; `docs/audits/README.md` for
  how prior investigations were structured.
</reuse>

<constraints>
- **Document only. Write no implementation code**, no feature flag, no dependency. Code
  fragments in the doc are illustrative and belong inside fenced blocks in the document.
- Every claim about libghostty-vt's or Ghostty's API must come from a context7 query
  made during this task, with the API name quoted. Do not describe an API from memory —
  this library is young and the surface moves.
- Every claim about the current implementation must cite a real file and symbol from the
  list above. An inventory item you cannot point at does not go in the inventory.
- Prefer the honest answer to the exciting one. If the evidence says stay on xterm and
  fix the three specific pain points, say that.
- Build exactly this slice. Make routine judgment calls yourself; check in only where two
  readings mean materially different work. If a premise here looks wrong, say so in one
  sentence and continue as asked.
</constraints>

<out_of_scope>
- Any change to `TerminalPane.tsx`, `src-tauri`, `Cargo.toml`, `package.json` or
  `vite.config.ts`.
- Adding a feature flag or a settings key.
- Prototyping the WASM or FFI integration.
- Changing the PTY backend (`portable-pty` stays either way; this is a VT-engine
  decision, not a process-spawning one).
</out_of_scope>

<acceptance>
- `docs/decisions/ghostty-terminal-engine.md` exists and covers all seven sections above.
- The capability inventory has at least one file:symbol citation per row.
- The libghostty-vt capability map names real API symbols retrieved via context7 in this
  session.
- The integration fork is decided, not merely presented, with the deciding criterion
  named.
- The settings mapping table has a row per proposed `terminal.*` key, marked
  existing / renamed / new.
- Each phase has an acceptance criterion and a rollback.
- `git status` shows exactly one new file and no modifications to any source file.
</acceptance>
```
</content>
