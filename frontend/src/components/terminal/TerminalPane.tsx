import { createEffect, onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useSettings } from "@/store/settings";

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
  onExit?: () => void;
}

// xterm canvas is always rendered opaque: canvas-transparency is unreliable
// across WebKitGTK and caused visible gaps around the grid.
const TERMINAL_BG = "#09090b";

const TERMINAL_THEME = {
  background: TERMINAL_BG,
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

export function TerminalPane(props: TerminalPaneProps) {
  let container!: HTMLDivElement;
  const { settings } = useSettings();

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
      theme: TERMINAL_THEME,
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
      tabStopWidth: t.tabStopWidth,
      drawBoldTextInBrightColors: t.drawBoldTextInBrightColors,
      minimumContrastRatio: t.minimumContrastRatio,
      macOptionIsMeta: t.macOptionIsMeta,
      rightClickSelectsWord: t.rightClickSelectsWord,
      wordSeparator: t.wordSeparator,
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
      term.options.tabStopWidth = s.tabStopWidth;
      term.options.drawBoldTextInBrightColors = s.drawBoldTextInBrightColors;
      term.options.minimumContrastRatio = s.minimumContrastRatio;
      term.options.macOptionIsMeta = s.macOptionIsMeta;
      term.options.rightClickSelectsWord = s.rightClickSelectsWord;
      term.options.wordSeparator = s.wordSeparator;
      term.options.scrollSensitivity = s.scrollSensitivity;
      term.options.scrollOnUserInput = s.scrollOnUserInput;
      void ensureLigatures(s.ligatures);
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch { /* ignore */ }
    });

    term.onData((data) => {
      void invoke("write_pty", { sessionId: ptyId, data });
    });

    // ── Resize: debounced so fit() + resize_pty only fire after drag ends.
    let fitTimer: number | null = null;
    let lastCols = term.cols;
    let lastRows = term.rows;

    const doFit = () => {
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

    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data: ArrayBuffer) => {
      term.write(new Uint8Array(data));
    };
    void invoke("pty_subscribe", {
      sessionId: ptyId,
      onOutput: outputChannel,
    });

    const unlistenExit = await listen(`pty-exit:${ptyId}`, () => props.onExit?.());

    onCleanup(() => {
      if (fitTimer !== null) clearTimeout(fitTimer);
      ro.disconnect();
      unlistenExit();
      try { ligaturesDisposer?.dispose?.(); } catch { /* ignore */ }
      term.dispose();
    });
  });

  return (
    <div
      ref={container}
      class={props.class ?? "w-full h-full"}
      style={{ "background-color": TERMINAL_BG }}
    />
  );
}
