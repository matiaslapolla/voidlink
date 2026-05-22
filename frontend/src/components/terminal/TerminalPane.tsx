import { createEffect, createSignal, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "@xterm/xterm/css/xterm.css";
import { useSettings } from "@/store/settings";
import { useTheme } from "@/store/theme";
import { markActive, recordKeystroke } from "@/commands/terminalHistory";

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

  onMount(async () => {
    const ptyId = props.ptyId;
    const t = settings.terminal;

    try {
      await document.fonts.ready;
    } catch {
      // unsupported — proceed
    }

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
    fitAddon.fit();
    term.focus();

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

    // The PTY was created at a hardcoded 80x24 on the Rust side. Tell it the
    // real dimensions now — without this, TUIs launched immediately after
    // mount (e.g. `claude` right after the shell prompt appears) render at
    // 80x24 and then misalign when SIGWINCH arrives.
    if (term.cols > 0 && term.rows > 0) {
      void invoke("resize_pty", {
        sessionId: ptyId,
        cols: term.cols,
        rows: term.rows,
      });
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
    createEffect(() => {
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
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch { /* ignore */ }
    });

    // Theme swap on app light/dark toggle. xterm rebuilds its color
    // cache when `options.theme` is reassigned; a refresh forces a
    // canvas repaint so already-rendered cells pick up the new palette.
    createEffect(() => {
      term.options.theme = palette();
      try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
    });

    term.onData((data) => {
      recordKeystroke(ptyId, data);
      void invoke("write_pty", { sessionId: ptyId, data });
    });

    // First focus → mark as the "most recent" PTY so global Cmd+Shift+R
    // knows where to send the repeated command. Also re-mark whenever the
    // pane becomes active.
    markActive(ptyId);

    // ── Resize: debounced so fit() + resize_pty only fire after drag ends.
    let fitTimer: number | null = null;
    let lastCols = term.cols;
    let lastRows = term.rows;

    const doFit = () => {
      // Never fit against a hidden container: getBoundingClientRect is 0×0
      // under display:none, and a stray resize_pty would SIGWINCH the TUI to
      // a tiny width and make it redraw garbled frames.
      if (props.active === false) return;
      if (!container.clientWidth || !container.clientHeight) return;
      try { fitAddon.fit(); } catch { return; }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        void invoke("resize_pty", {
          sessionId: ptyId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    };

    const scheduleFit = () => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      fitTimer = window.setTimeout(() => {
        fitTimer = null;
        doFit();
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
    createEffect(() => {
      const active = props.active !== false;
      if (active && !wasActive) {
        if (fitTimer !== null) {
          clearTimeout(fitTimer);
          fitTimer = null;
        }
        if (pendingShowFrame !== null) cancelAnimationFrame(pendingShowFrame);
        pendingShowFrame = requestAnimationFrame(() => {
          pendingShowFrame = null;
          doFit();
          try { term.refresh(0, term.rows - 1); } catch { /* ignore */ }
        });
        markActive(ptyId);
      }
      wasActive = active;
    });

    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data: ArrayBuffer) => {
      term.write(new Uint8Array(data));
    };
    void invoke("pty_subscribe", {
      sessionId: ptyId,
      onOutput: outputChannel,
    });

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

    onCleanup(() => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      if (pendingShowFrame !== null) cancelAnimationFrame(pendingShowFrame);
      ro.disconnect();
      unlistenExit();
      unlistenDrop();
      for (const d of linkDisposers) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      try { ligaturesDisposer?.dispose?.(); } catch { /* ignore */ }
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
