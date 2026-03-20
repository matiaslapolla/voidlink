import { onMount, onCleanup } from "solid-js";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import type { TerminalTab } from "@/types/tabs";

interface TerminalPaneProps {
  tab: TerminalTab;
  onUpdateTab: (updates: Partial<TerminalTab>) => void;
  onClose: () => void;
}

export function TerminalPane({ tab, onUpdateTab, onClose }: TerminalPaneProps) {
  let containerRef: HTMLDivElement | undefined;
  let term: XTerm | null = null;
  let currentSessionId: string | null = tab.sessionId || null;

  const getCssVar = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  async function initTerminal(): Promise<() => void> {
    if (!containerRef) return () => {};

    const t = new XTerm({
      fontFamily: '"GeistMono", "Cascadia Code", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      theme: {
        background: getCssVar("--background") || "#1a1a1a",
        foreground: getCssVar("--foreground") || "#e0e0e0",
        cursor: getCssVar("--primary") || "#60a5fa",
        selectionBackground: getCssVar("--accent") || "#374151",
        black: "#000000",
        brightBlack: "#4d4d4d",
        red: "#f87171",
        brightRed: "#ef4444",
        green: "#4ade80",
        brightGreen: "#22c55e",
        yellow: "#facc15",
        brightYellow: "#eab308",
        blue: "#60a5fa",
        brightBlue: "#3b82f6",
        magenta: "#c084fc",
        brightMagenta: "#a855f7",
        cyan: "#22d3ee",
        brightCyan: "#06b6d4",
        white: "#e5e7eb",
        brightWhite: "#f9fafb",
      },
    });

    const fit = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    t.loadAddon(fit);
    t.loadAddon(webLinksAddon);
    t.open(containerRef);
    fit.fit();

    term = t;

    // Update tab title from OSC escape sequences (sent by shells on command exec)
    t.onTitleChange((title) => {
      if (title) onUpdateTab({ title });
    });

    // Spawn PTY
    let sessionId: string;
    try {
      sessionId = await invoke<string>("create_pty", {
        cwd: tab.cwd || (await invoke<string>("get_home_dir")),
      });
    } catch (err) {
      t.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
      return () => {};
    }

    currentSessionId = sessionId;
    onUpdateTab({ sessionId });

    // Listen for PTY output
    const unlisten = await listen<number[]>(`pty-output:${sessionId}`, (event) => {
      const bytes = new Uint8Array(event.payload);
      t.write(bytes);
    });

    // Listen for PTY exit — show message then close the tab
    let exitTimeout: ReturnType<typeof setTimeout> | null = null;
    const unlistenExit = await listen(`pty-exit:${sessionId}`, () => {
      t.writeln("\r\n\x1b[2m[Process completed]\x1b[0m");
      exitTimeout = setTimeout(() => {
        currentSessionId = null; // prevent double close_pty on unmount
        onClose();
      }, 1500);
    });

    // Send input to PTY
    t.onData((data) => {
      invoke("write_pty", { sessionId, data }).catch(() => {});
    });

    // Resize handler
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      invoke("resize_pty", {
        sessionId,
        cols: t.cols,
        rows: t.rows,
      }).catch(() => {});
    });

    if (containerRef) {
      resizeObserver.observe(containerRef);
    }

    return () => {
      unlisten();
      unlistenExit();
      if (exitTimeout !== null) clearTimeout(exitTimeout);
      resizeObserver.disconnect();
    };
  }

  onMount(async () => {
    let cleanup: (() => void) | undefined;

    initTerminal().then((fn) => {
      cleanup = fn;
    });

    // Forward horizontal wheel events to the parent <main> scroll container
    // so trackpad swipes navigate between tabs instead of being captured by xterm.js
    const el = containerRef;
    if (el) {
      const handler = (e: WheelEvent) => {
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.stopPropagation();
          e.preventDefault();
          const scrollParent = el.closest("main");
          if (scrollParent) scrollParent.scrollBy({ left: e.deltaX });
        }
      };
      el.addEventListener("wheel", handler, { capture: true, passive: false });

      onCleanup(() => {
        el.removeEventListener("wheel", handler, { capture: true });
      });
    }

    onCleanup(() => {
      cleanup?.();
      term?.dispose();
      term = null;
      if (currentSessionId) {
        invoke("close_pty", { sessionId: currentSessionId }).catch(() => {});
      }
    });
  });

  return (
    <div
      ref={el => containerRef = el}
      class="h-full overflow-hidden bg-background p-2"
    />
  );
}
