/// The language-server transport, as thin as it can be.
///
/// Rust owns the process and the base-protocol framing (`src-tauri/src/lsp/`);
/// this module moves already-framed JSON-RPC text across the boundary in both
/// directions and knows nothing else. Nothing here parses a message — the LSP
/// semantics live in `components/editor/lspClient.ts`.
///
/// `locate` returning `null` is load-bearing and is deliberately not an error:
/// not having a language server installed is the normal state for most users of
/// most languages, and it must produce today's editor with no status segment
/// rather than a rejected promise somebody has to remember to catch.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const MESSAGE_EVENT = "lsp-message";
const LOG_EVENT = "lsp-log";
const EXIT_EVENT = "lsp-exit";

export interface LspMessageEvent {
  sessionId: string;
  /// One framed JSON-RPC message, verbatim.
  message: string;
}

export interface LspLogEvent {
  sessionId: string;
  line: string;
}

export interface LspExitEvent {
  sessionId: string;
  code: number | null;
  /// `true` when `stop()` asked for it. The bridge counts only the other kind
  /// as a crash, so toggling the setting off never shows "stopped unexpectedly".
  requested: boolean;
  reason: string;
}

export const lspApi = {
  /// Absolute path of `command`, or `null` when it is not installed. Also
  /// accepts an absolute path, which is what the Settings override supplies.
  locate(command: string): Promise<string | null> {
    return invoke<string | null>("lsp_locate", { command });
  },

  /// Spawn a server. Resolves with the absolute path that was started, which
  /// the output log names so "which rust-analyzer is this" is answerable.
  start(
    sessionId: string,
    command: string,
    args: string[],
    cwd: string | null,
  ): Promise<string> {
    return invoke<string>("lsp_start", { sessionId, command, args, cwd });
  },

  /// Queue one JSON-RPC message. Returns as soon as it is queued — the write
  /// happens on the session's own thread, so a wedged server cannot block the
  /// UI.
  send(sessionId: string, message: string): Promise<void> {
    return invoke<void>("lsp_send", { sessionId, message });
  },

  stop(sessionId: string): Promise<void> {
    return invoke<void>("lsp_stop", { sessionId });
  },

  onMessage(handler: (e: LspMessageEvent) => void): Promise<UnlistenFn> {
    return listen<LspMessageEvent>(MESSAGE_EVENT, (e) => handler(e.payload));
  },

  onLog(handler: (e: LspLogEvent) => void): Promise<UnlistenFn> {
    return listen<LspLogEvent>(LOG_EVENT, (e) => handler(e.payload));
  },

  onExit(handler: (e: LspExitEvent) => void): Promise<UnlistenFn> {
    return listen<LspExitEvent>(EXIT_EVENT, (e) => handler(e.payload));
  },
};
