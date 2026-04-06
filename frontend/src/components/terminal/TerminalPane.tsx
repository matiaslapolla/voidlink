import { onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { loadTerminalSettings } from "@/components/settings/SettingsPanel";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  ptyId: string;
  class?: string;
}

export function TerminalPane(props: TerminalPaneProps) {
  let container!: HTMLDivElement;

  onMount(() => {
    const settings = loadTerminalSettings();

    const term = new Terminal({
      theme: {
        background: "#09090b",
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
      },
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      customGlyphs: true,
      letterSpacing: -0.5,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    requestAnimationFrame(() => fitAddon.fit());

    // Keyboard input → PTY
    term.onData((data) => {
      void invoke("write_pty", { sessionId: props.ptyId, data });
    });

    // Resize observer — coalesced via rAF, skip when dimensions unchanged
    let resizeRaf = 0;
    let lastCols = 0;
    let lastRows = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        fitAddon.fit();
        if (term.cols !== lastCols || term.rows !== lastRows) {
          lastCols = term.cols;
          lastRows = term.rows;
          void invoke("resize_pty", {
            sessionId: props.ptyId,
            cols: term.cols,
            rows: term.rows,
          });
        }
      });
    });
    ro.observe(container);

    // ── PTY output ───────────────────────────────────────────────────────
    let unlisten: (() => void) | null = null;

    listen<number[]>(`pty-output:${props.ptyId}`, (event) => {
      term.write(new Uint8Array(event.payload));
    }).then((fn) => {
      unlisten = fn;
    });

    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data: ArrayBuffer) => {
      term.write(new Uint8Array(data));
    };
    void invoke("pty_subscribe", {
      sessionId: props.ptyId,
      onOutput: outputChannel,
    });

    onCleanup(() => {
      cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      unlisten?.();
      term.dispose();
    });
  });

  return (
    <div
      ref={container}
      class={props.class ?? "w-full h-full"}
      style={{ padding: "4px", "box-sizing": "border-box" }}
    />
  );
}
