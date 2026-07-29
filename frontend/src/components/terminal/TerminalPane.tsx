import { createEffect, createSignal, onMount, onCleanup, getOwner, runWithOwner, untrack } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
import { useSettings } from "@/store/settings";
import { useTheme } from "@/store/theme";
import { markActive, recordKeystroke } from "@/commands/terminalHistory";
import { lastGridSize, rememberGridSize, sizeForPty } from "@/commands/terminalSize";

// Prior perf learning (commit 0b9bfe7): in Tauri's WebKitGTK webview, xterm
// addons beyond FitAddon hook the data pipeline and cause stutter / glitches.
// Exceptions, eagerly loaded because they fix visible correctness bugs:
//   • UnicodeGraphemesAddon — Unicode 15 width tables + Intl.Segmenter
//     grapheme clustering. Without this xterm uses Unicode 6 tables and
//     misjudges the column width of emoji / ZWJ sequences / wide chars, so
//     modern Ink-based TUIs (Claude Code, Codex, OpenCode) drift column-wise
//     and render garbled. Lazygit is unaffected because it only uses plain
//     U+2500 box-drawing.
// Ligatures remain opt-in via settings.

// ResizeObserver fires continuously while the user drags the window edges.
// xterm's fit() measures DOM + reflows the grid, which is expensive and
// visually noisy during drag. We debounce so fit runs once, after drag ends.
const RESIZE_DEBOUNCE_MS = 150;

interface TerminalPaneProps {
  ptyId: string;
  class?: string;
  // When false, the pane is hidden (display:none) by the parent. We avoid
  // fitting/resizing the PTY while hidden, and re-fit + repaint on show —
  // otherwise stale grid dimensions or window resizes missed while hidden
  // cause TUIs to redraw at the wrong width ("compressed, repeated" output).
  active?: boolean;
  onExit?: () => void;
  /// The shell rang the bell (BEL). One of the three distinct terminal events
  /// MASTER §7.5.3 names — the other two (a command running, a command
  /// finishing) come from the process poll in `store/terminalWatch.ts`, not
  /// from the emulator. Ambient only: it must never steal focus.
  onBell?: () => void;
  /// Click handler for `path[:line[:column]]` matches in scrollback. The
  /// path is whatever the regex captured — may be relative; the caller
  /// is responsible for resolving against the workspace root.
  onOpenPath?: (path: string, line?: number, column?: number) => void;
  /// Click handler for 7+ hex-digit SHA matches in scrollback. The caller
  /// chooses how to interpret (typically: open a compare tab at sha^..sha).
  onOpenSha?: (sha: string) => void;
  /// Click handler for branch-name matches in scrollback. Only tokens that
  /// exactly equal a name returned by `branchNames` are linkified — we never
  /// guess at arbitrary words, since branch names are ordinary text and free
  /// matching would underline half the screen.
  onOpenBranch?: (branch: string) => void;
  /// Live list of real branch names in the repo. Read at link-resolution
  /// time (per buffer line) so it stays current as branches come and go.
  branchNames?: () => string[];
}

// xterm canvas is always rendered opaque: canvas-transparency is unreliable
// across WebKitGTK and caused visible gaps around the grid.
const DARK_BG = "#09090b";
const LIGHT_BG = "#fdf6e3"; // solarized-base3

/// `path/to/file.ext:line[:column]`. The path can include letters, digits,
/// `.`, `_`, `-`, `+`, `/`, `@`, and `~`. Requires a `:` followed by a
/// digit run so we don't link arbitrary path-shaped text like
/// `--include=foo/bar.txt`. The extension whitelist is broad enough to
/// cover typical project files but excludes binary types so the cursor
/// doesn't turn into a link over `assets/logo.png` etc.
const PATH_LINE_REGEX =
  /([\w@~+\-./]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cpp|h|hpp|cs|rb|php|html|css|scss|json|yaml|yml|md|toml|sh|sql)):(\d+)(?::(\d+))?/g;

/// Loose 7–40 hex digit SHA-1. We require word boundaries so we don't
/// match inside e.g. a long hash-prefixed filename.
const SHA_REGEX = /\b[0-9a-f]{7,40}\b/g;

const DARK_THEME = {
  background: DARK_BG,
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#86efac",
  yellow: "#fde047",
  blue: "#93c5fd",
  magenta: "#c4b5fd",
  cyan: "#67e8f9",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#bbf7d0",
  brightYellow: "#fef08a",
  brightBlue: "#bfdbfe",
  brightMagenta: "#ddd6fe",
  brightCyan: "#a5f3fc",
  brightWhite: "#fafafa",
} as const;

/// Solarized-light tuned for terminal readability against the warm
/// off-white background. ANSI 0–7 use the standard solarized accents at
/// their darker (base0x) variants so they stay legible on the light bg;
/// bright 8–15 brighten the same hues. base0/base00 control body text.
const LIGHT_THEME = {
  background: LIGHT_BG,
  foreground: "#586e75",            // base01
  cursor: "#586e75",
  selectionBackground: "#eee8d5",   // base2
  black: "#073642",                 // base02
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",                 // base2
  brightBlack: "#657b83",           // base00
  brightRed: "#cb4b16",
  brightGreen: "#586e75",           // base01
  brightYellow: "#657b83",          // base00
  brightBlue: "#839496",            // base0
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",            // base1
  brightWhite: "#fdf6e3",           // base3
} as const;

export function TerminalPane(props: TerminalPaneProps) {
  let container!: HTMLDivElement;
  const { settings } = useSettings();
  const { mode } = useTheme();
  const palette = () => (mode() === "light" ? LIGHT_THEME : DARK_THEME);
  const paneBg = () => (mode() === "light" ? LIGHT_BG : DARK_BG);
  // Highlight ring while a file is dragged over the pane.
  const [dragOver, setDragOver] = createSignal(false);

  /// Type the dropped paths onto the shell input line. Each path is
  /// shell-quoted (so spaces / parens don't break the command) and a
  /// trailing space lets the user keep typing. We write straight to the
  /// PTY rather than xterm so the bytes reach the running shell.
  function injectPaths(paths: string[]) {
    const text = paths.map(quoteForShell).join(" ");
    if (!text) return;
    void invoke("write_pty", { sessionId: props.ptyId, data: text + " " });
  }

  /// True when the screen point (client coords) lands inside this pane's
  /// box. Hidden panes are display:none → 0×0 rect → always false, so this
  /// also doubles as the "am I the visible terminal?" check for OS drops.
  function pointInPane(clientX: number, clientY: number): boolean {
    const r = container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  // Everything below is set up after `await document.fonts.ready`, and Solid's
  // owner is only current for the *synchronous* part of a computation. Anything
  // registered past that await would attach to a null owner: the effects would
  // never be disposed and — the damaging one — the onCleanup at the end of the
  // mount body would silently register nothing, so unmounting a pane left the
  // xterm alive with its WebGL context, ResizeObserver and window listeners
  // still attached. Switching worktrees unmounts every pane, so contexts piled
  // up until the webview hit its live-context ceiling and started dropping the
  // oldest ones — panes coming back read as black. Re-entering this owner at
  // each registration site restores normal disposal.
  const owner = getOwner();

  // Teardown is routed through a cleanup registered *synchronously*, so it is
  // guaranteed to be armed even if the pane unmounts while the mount body is
  // still awaiting — rapid worktree switching hits exactly that window, and
  // handing the disposer to an owner that has already run its cleanups would
  // strand the terminal just as thoroughly as registering none at all.
  let disposed = false;
  let teardown: (() => void) | null = null;
  const ownedCleanup = (fn: () => void) => {
    teardown = fn;
    if (disposed) { teardown = null; fn(); }
  };
  const ownedEffect = (fn: () => void) => {
    if (disposed) return;
    runWithOwner(owner, () => createEffect(fn));
  };
  onCleanup(() => {
    disposed = true;
    const fn = teardown;
    teardown = null;
    fn?.();
  });

  onMount(async () => {
    const ptyId = props.ptyId;
    const t = settings.terminal;

    try {
      await document.fonts.ready;
    } catch {
      // unsupported — proceed
    }
    // Unmounted while we waited — never build a terminal nobody will show.
    if (disposed) return;

    const term = new Terminal({
      // Required for `term.unicode.activeVersion` (used below).
      allowProposedApi: true,
      theme: palette(),
      fontFamily: t.fontFamily,
      fontSize: t.fontSize,
      lineHeight: t.lineHeight,
      fontWeight: t.fontWeight,
      fontWeightBold: t.fontWeightBold,
      letterSpacing: t.letterSpacing,
      cursorBlink: t.cursorBlink,
      cursorStyle: t.cursorStyle,
      cursorWidth: t.cursorWidth,
      scrollback: t.scrollback,
      drawBoldTextInBrightColors: t.drawBoldTextInBrightColors,
      minimumContrastRatio: t.minimumContrastRatio,
      macOptionIsMeta: t.macOptionIsMeta,
      rightClickSelectsWord: t.rightClickSelectsWord,
      scrollSensitivity: t.scrollSensitivity,
      scrollOnUserInput: t.scrollOnUserInput,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // Install Unicode 15 width tables before open() so the first frame uses
    // correct column widths for emoji / ZWJ / wide chars.
    try {
      term.loadAddon(new UnicodeGraphemesAddon());
      term.unicode.activeVersion = "15-graphemes";
    } catch {
      // If the addon fails to attach (e.g. Intl.Segmenter unavailable),
      // fall through to the default Unicode 6 tables.
    }

    term.open(container);

    // ── Grid size ─────────────────────────────────────────────────────
    // The shell and the renderer must agree on the column count or every
    // redraw of the input line paints over the prompt row instead of past it:
    // zsh computes its cursor moves from the winsize it was given, xterm wraps
    // at its own grid width. The rule that keeps them together is that the PTY
    // is told about *grid changes*, not about *fits* — `onResize` fires once
    // per real change from every path there is (fit, an explicit resize, a
    // font-option change that reflows), so no path can move the grid without
    // the shell hearing about it.
    //
    // Sizes are published through a promise chain. `resize_pty` is an async
    // Tauri command and two of them are independent tasks with no ordering
    // guarantee, so unserialized calls can land oldest-last and strand the
    // shell on a stale winsize — the very failure this is meant to prevent.
    let published: { cols: number; rows: number } | null = null;
    let publishing: Promise<void> = Promise.resolve();
    const publish = (cols: number, rows: number) => {
      if (published && published.cols === cols && published.rows === rows) return;
      published = { cols, rows };
      publishing = publishing.then(async () => {
        try {
          await invoke("resize_pty", { sessionId: ptyId, cols, rows });
          rememberGridSize(ptyId, cols, rows);
        } catch {
          // Session gone, or the ioctl failed. Drop our record of the PTY's
          // size so the next change retries rather than short-circuiting on a
          // figure the shell never received.
          published = null;
        }
      });
    };
    term.onResize(({ cols, rows }) => publish(cols, rows));

    /// Re-measure the container and reflow the grid to match, reporting
    /// whether it could be measured at all. Publishing is left to `onResize`.
    ///
    /// Fitting while hidden is refused, and not as an optimisation: under
    /// `display:none` getComputedStyle hands FitAddon the *unresolved* `100%`
    /// from the pane's `w-full h-full`, so it measures 100px and reflows the
    /// grid to 11 columns.
    const refit = (): boolean => {
      if (props.active === false) return false;
      if (!container.clientWidth || !container.clientHeight) return false;
      try { fitAddon.fit(); } catch { return false; }
      return true;
    };

    // ── WebGL renderer ────────────────────────────────────────────────
    // xterm's default DOM renderer is the slowest path; the WebGL addon is
    // the biggest terminal-perf win (GPU-composited glyph atlas). It must be
    // loaded AFTER open() so the canvas/context exists. WebGL2 support varies
    // across our two webviews — WebKitGTK on Linux can ship without a usable
    // GL context, and even on macOS WKWebView construction can throw — so we
    // feature-detect first and wrap construction in try/catch. On any failure
    // we silently leave the DOM renderer in place; the pane must never blank.
    //
    // Ligatures stay compatible: the ligatures addon works via xterm's
    // character-joiner API, which the WebGL renderer honours (unlike the old
    // canvas renderer), so the existing opt-in ligatures path below is
    // unaffected and we don't need to gate it.
    let webglAddon: WebglAddon | null = null;
    if (webgl2Available()) {
      try {
        // `preserveDrawingBuffer` is the fix for the pane going black when the
        // app loses focus. By default a WebGL drawing buffer's contents are
        // undefined after the compositor presents a frame, and xterm only
        // redraws on damage — so an idle terminal that gets composited again
        // (window blurred, occluded, tab re-shown) presents an empty buffer and
        // reads as "the terminal went black". Keeping the buffer costs a little
        // fill bandwidth per frame; it does not touch the data pipeline, so the
        // stutter class of problem called out at the top of this file is
        // unaffected.
        const addon = new WebglAddon(true);
        // A lost GL context (OOM, GPU reset, system suspend) would otherwise
        // leave a blank canvas. Dispose the addon so xterm falls back to the
        // DOM renderer, and null our ref so cleanup doesn't double-dispose.
        addon.onContextLoss(() => {
          try { addon.dispose(); } catch { /* ignore */ }
          webglAddon = null;
          // Disposing swaps the DOM renderer back in, but it only paints on the
          // next damage — without this the grid stays blank until the shell
          // happens to write something.
          repaint();
          // The two renderers disagree about how many columns fit — WebGL
          // floors the cell box to whole device pixels, the DOM renderer
          // doesn't — and the gap is large (measured 198 vs 177 columns at
          // dpr 1, 184 vs 177 at dpr 2), not a rounding wobble. Falling back
          // without re-fitting would leave the shell wrapping at a width the
          // renderer no longer uses.
          refit();
        });
        term.loadAddon(addon);
        webglAddon = addon;
      } catch {
        // Construction failed (no context, driver quirk) — keep DOM renderer.
        webglAddon = null;
      }
    }

    // First sizing, deliberately after the renderer is settled: fitting with
    // the DOM renderer and then again once WebGL swaps the cell metrics would
    // hand the shell a wrong width first and correct it a tick later, and two
    // SIGWINCHes during shell startup is exactly what the spawn-time seed
    // exists to avoid.
    if (!refit()) {
      // Mounted hidden — a restored workspace, a background terminal, or a
      // pane rebuilt after a worktree switch while its shell kept running.
      // The container can't be measured, so adopt the size the PTY already
      // has (or the pane guess, for a shell just spawned with it). This goes
      // through `term.resize`, so `onResize` publishes it: the grid and the
      // winsize cannot end up disagreeing even when the guess is stale.
      const hint = sizeForPty(ptyId) ?? lastGridSize();
      if (hint) {
        try { term.resize(hint.cols, hint.rows); } catch { /* ignore */ }
      }
    }
    // Nothing moved the grid — a fit that landed on xterm's 80x24 default, or
    // a hidden pane with no hint. The PTY was spawned from a *guess*, which
    // may not be that, so state the grid's size outright rather than assume
    // silence means agreement.
    if (!published) publish(term.cols, term.rows);
    term.focus();

    /// Force the full grid to repaint, rebuilding the glyph atlas first.
    ///
    /// `refresh` alone re-runs the renderer over rows xterm considers damaged,
    /// which is enough for a stale frame but not for a texture atlas the GPU
    /// dropped underneath us (DPR change, context recycle, suspend). Clearing
    /// it first is cheap at the frequency we call this — only on focus,
    /// visibility and DPR transitions, never per frame.
    const repaint = () => {
      try {
        webglAddon?.clearTextureAtlas();
        term.refresh(0, term.rows - 1);
      } catch { /* ignore — the terminal may be mid-teardown */ }
    };

    // ── Device-pixel-ratio changes ────────────────────────────────────
    // The WebGL renderer bakes glyphs into a texture atlas sized for the DPR
    // at construction time. Dragging the window between a Retina and a
    // non-Retina display (or changing display scaling) leaves that atlas at
    // the old scale, and the grid renders blurry or smeared until something
    // else happens to invalidate it. `matchMedia` on the current resolution
    // is the standard way to hear about the change; the listener re-arms
    // itself because the query is only true for the DPR it was built with.
    let dprMedia: MediaQueryList | null = null;
    const onDprChange = () => {
      repaint();
      // The WebGL cell box is `floor(charWidth * dpr) / dpr`, so the column
      // count that fits changes with the DPR even though the container's CSS
      // size doesn't — ResizeObserver hears nothing about this one.
      refit();
      watchDpr();
    };
    const watchDpr = () => {
      dprMedia?.removeEventListener("change", onDprChange);
      try {
        dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        dprMedia.addEventListener("change", onDprChange);
      } catch {
        dprMedia = null;
      }
    };
    watchDpr();

    // ── Repaint on focus / visibility regain ──────────────────────────
    // Belt to `preserveDrawingBuffer`'s braces. Losing and regaining focus is
    // exactly when a frame can go stale — the OS composites the window while
    // xterm has no damage to redraw, and on some GPU/driver combinations the
    // buffer comes back empty anyway. Repainting on the way back in costs one
    // frame and makes "click the terminal, it's black" unreachable.
    //
    // Deferred to the next frame in every case: the repaint has to land after
    // the compositor has actually presented the window again, or it repaints
    // the frame that is about to be thrown away.
    let repaintFrame: number | null = null;
    const repaintSoon = () => {
      if (props.active === false) return;
      if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
      repaintFrame = requestAnimationFrame(() => {
        repaintFrame = null;
        repaint();
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") repaintSoon();
    };
    // `focusin` (not `focus`) — it bubbles, so it catches focus landing on
    // xterm's own hidden textarea, which is what "focusing the terminal" is.
    container.addEventListener("focusin", repaintSoon);
    window.addEventListener("focus", repaintSoon);
    document.addEventListener("visibilitychange", onVisibility);

    // ── Deep-link providers (path:line, SHAs) ─────────────────────────
    // Use the native xterm link-provider API rather than the web-links
    // addon — it sidesteps the data-pipeline hook called out at the top
    // of this file and gives us full control over the click handler.
    const linkDisposers: { dispose: () => void }[] = [];
    if (props.onOpenBranch && props.branchNames) {
      linkDisposers.push(
        buildBranchLinkProvider(term, props.branchNames, (branch) => {
          props.onOpenBranch?.(branch);
        }),
      );
    }
    if (props.onOpenPath || props.onOpenSha) {
      // Two providers — one per pattern. Keeps regex complexity low and
      // lets the path provider win precedence on overlapping spans.
      if (props.onOpenPath) {
        linkDisposers.push(
          buildLinkProvider(term, PATH_LINE_REGEX, (match) => {
            const path = match[1];
            const line = match[2] ? parseInt(match[2], 10) : undefined;
            const column = match[3] ? parseInt(match[3], 10) : undefined;
            props.onOpenPath?.(path, line, column);
          }),
        );
      }
      if (props.onOpenSha) {
        linkDisposers.push(
          buildLinkProvider(term, SHA_REGEX, (match) => {
            props.onOpenSha?.(match[0]);
          }),
        );
      }
    }

    // Ligatures are lazy + opt-in, because they hook the glyph pipeline.
    let ligaturesDisposer: { dispose?: () => void } | null = null;
    const ensureLigatures = async (enabled: boolean) => {
      if (enabled && !ligaturesDisposer) {
        try {
          const mod = await import("@xterm/addon-ligatures");
          const addon = new mod.LigaturesAddon();
          term.loadAddon(addon);
          ligaturesDisposer = addon;
        } catch {
          // silently ignore if the addon fails to load in this webview
        }
      } else if (!enabled && ligaturesDisposer) {
        try { ligaturesDisposer.dispose?.(); } catch { /* ignore */ }
        ligaturesDisposer = null;
      }
    };
    void ensureLigatures(t.ligatures);

    // Reactively apply setting changes. Font/size changes need a refresh to
    // repaint the canvas with the new glyph metrics — just setting the option
    // invalidates cached measurements but doesn't redraw the existing grid.
    ownedEffect(() => {
      const s = settings.terminal;
      term.options.fontFamily = s.fontFamily;
      term.options.fontSize = s.fontSize;
      term.options.lineHeight = s.lineHeight;
      term.options.fontWeight = s.fontWeight;
      term.options.fontWeightBold = s.fontWeightBold;
      term.options.letterSpacing = s.letterSpacing;
      term.options.cursorBlink = s.cursorBlink;
      term.options.cursorStyle = s.cursorStyle;
      term.options.cursorWidth = s.cursorWidth;
      term.options.scrollback = s.scrollback;
      term.options.drawBoldTextInBrightColors = s.drawBoldTextInBrightColors;
      term.options.minimumContrastRatio = s.minimumContrastRatio;
      term.options.macOptionIsMeta = s.macOptionIsMeta;
      term.options.rightClickSelectsWord = s.rightClickSelectsWord;
      term.options.scrollSensitivity = s.scrollSensitivity;
      term.options.scrollOnUserInput = s.scrollOnUserInput;
      void ensureLigatures(s.ligatures);
      // Font metrics changed, so the number of cells that fit changed with
      // them, and the shell has to hear about it — not just the grid.
      // `untrack`: refit reads `props.active`, which is a plain getter, not a
      // memo. Tracking it would subscribe this effect to the active-tab
      // signal, so every tab switch would re-run it for every mounted pane —
      // defeating the resize debounce mid-drag and front-running the
      // deliberate wait-a-frame path below.
      untrack(refit);
      try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
    });

    // Theme swap on app light/dark toggle. xterm rebuilds its color
    // cache when `options.theme` is reassigned; a refresh forces a
    // canvas repaint so already-rendered cells pick up the new palette.
    ownedEffect(() => {
      term.options.theme = palette();
      try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
    });

    term.onData((data) => {
      recordKeystroke(ptyId, data);
      void invoke("write_pty", { sessionId: ptyId, data });
    });

    // ── Wheel scrolling inside full-screen TUIs ───────────────────────
    // On the alternate screen there is no scrollback to scroll, so a wheel
    // tick has to be translated into input the app understands ("alternate
    // scroll"). xterm.js does do this, but it emits exactly *one* arrow key
    // per wheel event no matter how far the wheel turned — it ignores both
    // the delta and `scrollSensitivity`. A mouse wheel notch therefore moves
    // a single line and reads as "scrolling is broken".
    //
    // We take the case over: accumulate the real delta, convert it to whole
    // lines, and send that many cursor keys. Two cases are handed back to
    // xterm untouched:
    //   • the normal buffer, where the viewport's own scrollback scroll is
    //     what the user wants;
    //   • apps that turned on mouse reporting (lazygit, vim with `set mouse`),
    //     which want the raw wheel events and do their own scrolling.
    let wheelRemainder = 0;
    // A single flick shouldn't dump hundreds of keypresses into the PTY.
    const MAX_WHEEL_LINES = 20;

    /// Measured row height in CSS px. Taken from the rendered grid rather
    /// than the font size so `lineHeight` and DPR rounding are included.
    const cellHeight = (): number => {
      const rows = container.querySelector(".xterm-rows") as HTMLElement | null;
      const h = rows?.getBoundingClientRect().height ?? container.clientHeight;
      return h > 0 && term.rows > 0 ? h / term.rows : 17;
    };

    term.attachCustomWheelEventHandler((ev) => {
      if (term.buffer.active.type !== "alternate") return true;
      if (term.modes.mouseTrackingMode !== "none") return true;
      if (ev.deltaY === 0) return true;

      let lines: number;
      if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) lines = ev.deltaY;
      else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) lines = ev.deltaY * term.rows;
      else lines = ev.deltaY / cellHeight();
      lines *= settings.terminal.scrollSensitivity;

      // Reversing direction mid-gesture must not be damped by the leftover
      // fraction of the previous direction.
      if (Math.sign(lines) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
      wheelRemainder += lines;
      const whole = Math.trunc(wheelRemainder);
      wheelRemainder -= whole;
      // Swallow the event either way: a partial delta is still "handled", and
      // letting it through would give xterm's one-line fallback a second go.
      if (whole === 0) return false;

      const count = Math.min(Math.abs(whole), MAX_WHEEL_LINES);
      const key = term.modes.applicationCursorKeysMode ? "O" : "[";
      const arrow = whole < 0 ? "A" : "B";
      void invoke("write_pty", {
        sessionId: ptyId,
        data: `\x1b${key}${arrow}`.repeat(count),
      });
      return false;
    });

    // ── Shift+Enter → newline instead of submit ───────────────────────
    // xterm.js sends a bare CR for Shift+Enter, indistinguishable from
    // Enter, so multiline input was impossible: zsh submitted the line and
    // Ink-based TUIs (Claude Code, Codex, OpenCode) treated it as send.
    // ESC+CR is the sequence every one of them already understands — it is
    // what Claude Code's own `/terminal-setup` writes into iTerm2 and VS
    // Code, and zsh's emacs keymap binds `^[^M` to self-insert-unmeta, so
    // the shell inserts a literal newline and keeps editing.
    //
    // Alt/Option+Enter is mapped to the same bytes on purpose: with
    // `macOptionIsMeta` off xterm would otherwise send a plain CR there too,
    // making the muscle-memory alternative silently submit.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || e.key !== "Enter") return true;
      if (e.ctrlKey || e.metaKey) return true;
      if (!e.shiftKey && !e.altKey) return true;
      e.preventDefault();
      // Deliberately not recorded as a keystroke: this never completes a
      // command, so it must not disturb repeat-last-command tracking.
      void invoke("write_pty", { sessionId: ptyId, data: "\x1b\r" });
      return false;
    });

    // First focus → mark as the "most recent" PTY so global Cmd+Shift+R
    // knows where to send the repeated command. Also re-mark whenever the
    // pane becomes active.
    markActive(ptyId);

    // ── Resize: debounced so fit() + resize_pty only fire after drag ends.
    let fitTimer: number | null = null;

    const scheduleFit = () => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        refit();
      }, RESIZE_DEBOUNCE_MS);
    };

    const ro = new ResizeObserver(scheduleFit);
    ro.observe(container);

    // When the pane flips hidden → visible, ResizeObserver doesn't reliably
    // fire (display:none → block isn't a content-box resize), and the window
    // may have been resized while we were hidden. Re-fit synchronously on
    // next frame (layout settled) and force a canvas repaint so the buffer
    // re-renders at the current dimensions.
    let wasActive = props.active !== false;
    let pendingShowFrame: number | null = null;
    ownedEffect(() => {
      const active = props.active !== false;
      if (active && !wasActive) {
        if (fitTimer !== null) {
          clearTimeout(fitTimer);
          fitTimer = null;
        }
        if (pendingShowFrame !== null) cancelAnimationFrame(pendingShowFrame);
        pendingShowFrame = requestAnimationFrame(() => {
          pendingShowFrame = null;
          refit();
          repaint();
        });
        markActive(ptyId);
      }
      wasActive = active;
    });

    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data: ArrayBuffer) => {
      // Detaching is a round trip, so chunks can still land after teardown.
      if (disposed) return;
      term.write(new Uint8Array(data));
    };
    // The token identifies *this* attachment. A pane that unmounts after its
    // replacement has already subscribed must not detach the live one, so the
    // backend ignores a token that is no longer current.
    const subscription = invoke<number>("pty_subscribe", {
      sessionId: ptyId,
      onOutput: outputChannel,
    });
    void subscription.catch(() => { /* pane will show nothing; nothing to undo */ });

    const bellSub = term.onBell(() => props.onBell?.());
    ownedCleanup(() => bellSub.dispose());

    const unlistenExit = await listen(`pty-exit:${ptyId}`, () => props.onExit?.());

    // OS file drops (Finder/Explorer). Tauri intercepts these before the
    // webview's HTML5 drop fires (dragDropEnabled defaults on), so we go
    // through the webview drag-drop event. Position is physical px relative
    // to the webview top-left; divide by devicePixelRatio to compare with
    // getBoundingClientRect. Every mounted pane gets this listener, but only
    // the one whose box contains the cursor (i.e. the visible one) injects.
    const dpr = () => window.devicePixelRatio || 1;
    const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "over") {
        setDragOver(pointInPane(p.position.x / dpr(), p.position.y / dpr()));
      } else if (p.type === "drop") {
        const inside = pointInPane(p.position.x / dpr(), p.position.y / dpr());
        setDragOver(false);
        if (inside && p.paths.length > 0) {
          term.focus();
          injectPaths(p.paths);
        }
      } else {
        setDragOver(false);
      }
    });

    ownedCleanup(() => {
      // Detach before disposing the terminal: the channel outlives this pane
      // otherwise, and the session goes on posting every byte it produces to a
      // receiver that writes into a disposed xterm.
      void subscription.then((token) =>
        invoke("pty_unsubscribe", { sessionId: ptyId, token }),
      ).catch(() => { /* session already gone */ });
      if (fitTimer !== null) clearTimeout(fitTimer);
      if (pendingShowFrame !== null) cancelAnimationFrame(pendingShowFrame);
      if (repaintFrame !== null) cancelAnimationFrame(repaintFrame);
      ro.disconnect();
      dprMedia?.removeEventListener("change", onDprChange);
      container.removeEventListener("focusin", repaintSoon);
      window.removeEventListener("focus", repaintSoon);
      document.removeEventListener("visibilitychange", onVisibility);
      unlistenExit();
      unlistenDrop();
      for (const d of linkDisposers) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      try { ligaturesDisposer?.dispose?.(); } catch { /* ignore */ }
      // May already be null if onContextLoss disposed it — never double-dispose.
      try { webglAddon?.dispose(); } catch { /* ignore */ }
      term.dispose();
    });
  });

  return (
    <div
      ref={container}
      class={`${props.class ?? "w-full h-full"} ${dragOver() ? "ring-2 ring-inset ring-primary/70" : ""}`}
      style={{ "background-color": paneBg() }}
      onDragOver={(e) => {
        // In-app drags (from the file tree) arrive as HTML5 DnD. Allow the
        // drop and show the same ring as OS drops.
        if (e.dataTransfer?.types.includes("application/x-voidlink-path") ||
            e.dataTransfer?.types.includes("text/plain")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        const path =
          dt.getData("application/x-voidlink-path") || dt.getData("text/plain");
        if (!path) return;
        e.preventDefault();
        setDragOver(false);
        injectPaths([path]);
      }}
    />
  );
}

/// Probe for a usable WebGL2 context before we try to construct the WebGL
/// renderer. WebKitGTK (Linux) and WKWebView (macOS) don't both guarantee
/// WebGL2, and calling getContext on a throwaway canvas is the cheapest way
/// to know without risking a mid-construction throw inside the addon.
function webgl2Available(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!canvas.getContext("webgl2");
  } catch {
    return false;
  }
}

/// Quote a path for a POSIX shell input line. Bare when it only contains
/// safe chars; otherwise single-quoted with embedded quotes escaped. Keeps
/// dropped paths with spaces or parens from breaking the typed command.
function quoteForShell(p: string): string {
  if (/^[\w@%+=:,./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/// Build an xterm link provider that matches `regex` against each
/// buffer line and calls `onClick` when a link is invoked. Returns the
/// disposable so the caller can clean up on terminal teardown.
function buildLinkProvider(
  term: Terminal,
  regex: RegExp,
  onClick: (match: RegExpMatchArray) => void,
): { dispose: () => void } {
  const provider = {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: TerminalLink[] | undefined) => void,
    ) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }
      const links: TerminalLink[] = [];
      for (const m of text.matchAll(regex)) {
        if (m.index === undefined) continue;
        const start = m.index + 1; // xterm uses 1-based columns
        const length = m[0].length;
        const captured = m;
        links.push({
          range: {
            start: { x: start, y: bufferLineNumber },
            end: { x: start + length - 1, y: bufferLineNumber },
          },
          text: m[0],
          activate: () => onClick(captured),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}

/// Branch chars per `git check-ref-format`: word chars plus `/`, `.`, `-`.
/// We treat these as the "inside a branch token" set for boundary checks so
/// `main` inside `domain` or `feat/x` inside `feat/xyz` never falsely links.
const BRANCH_CHAR = /[\w/.-]/;

/// Build a link provider that linkifies occurrences of *known* branch names.
/// The name list is read live (`getNames`) and the alternation is rebuilt
/// only when the set changes, so adding/deleting branches stays cheap. Names
/// are sorted longest-first so `feat/auth` wins over a bare `feat`, and each
/// is regex-escaped. Boundaries are checked manually (no lookbehind) to keep
/// this working on older WebKitGTK builds.
function buildBranchLinkProvider(
  term: Terminal,
  getNames: () => string[],
  onClick: (branch: string) => void,
): { dispose: () => void } {
  let cacheKey = "";
  let regex: RegExp | null = null;

  const ensureRegex = (): RegExp | null => {
    const names = getNames().filter((n) => n.length > 0);
    const key = names.join("\n");
    if (key === cacheKey) return regex;
    cacheKey = key;
    if (names.length === 0) {
      regex = null;
      return null;
    }
    const alt = [...names]
      .sort((a, b) => b.length - a.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    regex = new RegExp(`(?:${alt})`, "g");
    return regex;
  };

  const provider = {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: TerminalLink[] | undefined) => void,
    ) {
      const re = ensureRegex();
      if (!re) {
        callback(undefined);
        return;
      }
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      const text = line?.translateToString(true);
      if (!text) {
        callback(undefined);
        return;
      }
      const links: TerminalLink[] = [];
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) {
        if (m.index === undefined) continue;
        const before = m.index > 0 ? text[m.index - 1] : "";
        const afterIdx = m.index + m[0].length;
        const after = afterIdx < text.length ? text[afterIdx] : "";
        // Reject matches glued to more branch-y chars on either side.
        if (BRANCH_CHAR.test(before) || BRANCH_CHAR.test(after)) continue;
        const start = m.index + 1; // xterm uses 1-based columns
        const branch = m[0];
        links.push({
          range: {
            start: { x: start, y: bufferLineNumber },
            end: { x: start + branch.length - 1, y: bufferLineNumber },
          },
          text: branch,
          activate: () => onClick(branch),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
  return term.registerLinkProvider(provider);
}

/// xterm.js link shape — re-declared locally to avoid importing the
/// full ITerminalAddon type bundle into this file.
interface TerminalLink {
  range: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  };
  text: string;
  activate: (event: MouseEvent, text: string) => void;
}
