import { onMount, onCleanup } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ShellIntegrationAddon } from "./ShellIntegrationAddon";
import { loadTerminalSettings } from "@/components/settings/SettingsPanel";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface TerminalPaneProps {
  ptyId: string;
  class?: string;
  /** Called when the shell reports a new working directory (via OSC 7). */
  onCwdChange?: (cwd: string) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  let container!: HTMLDivElement;

  onMount(() => {
    const settings = loadTerminalSettings();

    const term = new Terminal({
      allowProposedApi: true,
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
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // GPU-accelerated rendering — up to 9x faster than DOM renderer
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, DOM renderer is used automatically
    }

    // Addons
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SearchAddon());
    term.loadAddon(new ClipboardAddon());
    term.loadAddon(new SerializeAddon());
    term.loadAddon(new Unicode11Addon());

    // Shell integration: OSC 133 (prompt markers/decorations) + OSC 7 (CWD)
    const shellIntegration = new ShellIntegrationAddon();
    shellIntegration.onCwdChange = (cwd) => {
      props.onCwdChange?.(cwd);
    };
    term.loadAddon(shellIntegration);

    requestAnimationFrame(() => fitAddon.fit());

    // Keyboard input → PTY
    term.onData((data) => {
      void invoke("write_pty", { sessionId: props.ptyId, data });
    });

    // Resize observer keeps terminal cols/rows in sync with container.
    // Coalesce via rAF and skip when dimensions haven't actually changed.
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

    // ── PTY output ────────────────────────────────────────────────────────
    // Listen for output events immediately so we don't miss data.
    // Also subscribe a binary Channel (bypasses JSON) — once the Channel
    // is active the Rust side stops emitting events for this session.
    const eventBuffer: Uint8Array[] = [];
    let replaying = true;
    let unlisten: (() => void) | null = null;

    const writeChunk = (chunk: Uint8Array) => {
      if (replaying) {
        eventBuffer.push(chunk);
      } else {
        term.write(chunk);
      }
    };

    // Primary: event listener (always works, JSON-encoded)
    listen<number[]>(`pty-output:${props.ptyId}`, (event) => {
      writeChunk(new Uint8Array(event.payload));
    }).then((fn) => {
      unlisten = fn;
    });

    // Upgrade: binary Channel (raw ArrayBuffer, no JSON overhead)
    const outputChannel = new Channel<ArrayBuffer>();
    outputChannel.onmessage = (data: ArrayBuffer) => {
      writeChunk(new Uint8Array(data));
    };
    void invoke("pty_subscribe", {
      sessionId: props.ptyId,
      onOutput: outputChannel,
    });

    // Replay scrollback to catch output before we subscribed
    invoke<number[]>("agent_get_scrollback", { ptyId: props.ptyId })
      .then((raw) => {
        if (raw.length > 0) term.write(new Uint8Array(raw));
      })
      .catch(() => {})
      .finally(() => {
        replaying = false;
        for (const chunk of eventBuffer) term.write(chunk);
        eventBuffer.length = 0;
        // The PTY starts emitting output before listeners are registered,
        // so the initial prompt is usually lost. Send Ctrl+L to make the
        // shell clear the screen and redraw the prompt now that we're listening.
        void invoke("write_pty", { sessionId: props.ptyId, data: "\x0c" });
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
