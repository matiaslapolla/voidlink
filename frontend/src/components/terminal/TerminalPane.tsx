import { useEffect, useRef, useCallback } from "react";
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
}

export function TerminalPane({ tab, onUpdateTab }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(tab.sessionId || null);

  const getCssVar = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const initTerminal = useCallback(async () => {
    if (!containerRef.current) return;

    const term = new XTerm({
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

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // Update tab title from OSC escape sequences (sent by shells on command exec)
    term.onTitleChange((title) => {
      if (title) onUpdateTab({ title });
    });

    // Spawn PTY
    let sessionId: string;
    try {
      sessionId = await invoke<string>("create_pty", {
        cwd: tab.cwd || (await invoke<string>("get_home_dir")),
      });
    } catch (err) {
      term.writeln(`\x1b[31mFailed to start terminal: ${err}\x1b[0m`);
      return;
    }

    sessionIdRef.current = sessionId;
    onUpdateTab({ sessionId });

    // Listen for PTY output
    const unlisten = await listen<number[]>(`pty-output:${sessionId}`, (event) => {
      const bytes = new Uint8Array(event.payload);
      term.write(bytes);
    });

    // Send input to PTY
    term.onData((data) => {
      invoke("write_pty", { sessionId, data }).catch(() => {});
    });

    // Resize handler
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      invoke("resize_pty", {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      unlisten();
      resizeObserver.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    initTerminal().then((fn) => {
      cleanup = fn;
    });

    return () => {
      cleanup?.();
      termRef.current?.dispose();
      termRef.current = null;
      if (sessionIdRef.current) {
        invoke("close_pty", { sessionId: sessionIdRef.current }).catch(() => {});
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden bg-background p-2"
      style={{ minHeight: 0 }}
    />
  );
}
