/// The agent turn transport, as thin as it can be.
///
/// Rust owns the child process, the login-shell PATH fix, the keychain
/// injection and the kill (`src-tauri/src/agent/`); this module moves a prompt
/// across the boundary and hands back the stdout chunks as they arrive. Nothing
/// here assembles a prompt or holds a conversation — that is
/// `commands/agent.ts`, and the separation is why the slide-over and an agent
/// tab can share one transport without sharing a renderer.
///
/// Deliberately *not* on `gitApi`. `git_agent_query`, the one-shot this
/// replaces, is registered through Rust's `blocking_git!` macro and so holds
/// the per-repo git lock for the whole turn — a forty-second answer froze every
/// stage click in that worktree. The streaming command takes no git lock at
/// all, and living on its own object is the reminder that it is not a git
/// command and must not become one.

import { Channel, invoke } from "@tauri-apps/api/core";

/// One event in a turn's output stream. The `{ event, data }` envelope is
/// serde's `tag`/`content` representation of the Rust enum — see
/// `AgentStreamEvent` in `src-tauri/src/agent/mod.rs`.
///
/// stdout and stderr arrive separately because several popular CLIs narrate
/// progress on stderr; folding that into the answer body would corrupt the very
/// text the user is reading.
export type AgentStreamEvent =
  | { event: "chunk"; data: { text: string } }
  | { event: "stderr"; data: { text: string } };

/// How a turn ended.
///
/// There is no error case here: a turn that failed rejects the promise, and a
/// turn the user stopped *resolves* with `cancelled: true`. Cancellation is a
/// normal outcome — the partial answer already streamed is worth keeping, and
/// the non-zero exit the kill produced is an artefact of the kill rather than a
/// fault to report.
export interface AgentTurnResult {
  cancelled: boolean;
  exitCode: number | null;
}

export interface AgentStreamOptions {
  repoPath: string;
  commandTemplate: string;
  prompt: string;
  /// The non-secret id → env-var mapping of the provider keys the user
  /// configured. Rust resolves each id against the OS keychain at spawn time
  /// and exports the value into the child's environment; no value passes
  /// through JS in either direction.
  secretBindings: { id: string; envVar: string }[];
  /// Caller-minted id, and the only handle `cancelTurn` has. Must be unique
  /// among turns in flight — Rust rejects a duplicate rather than silently
  /// replacing the turn a later cancel would then miss.
  turnId: string;
  /// Called once per stdout chunk, in arrival order. Append; never replace.
  onChunk: (text: string) => void;
  /// Called once per stderr chunk. Optional because the common case has none.
  onStderr?: (text: string) => void;
}

export const agentApi = {
  /// Run one turn, streaming its stdout through `onChunk`, and resolve when the
  /// child exits. Rejects with the CLI's stderr on a non-zero exit, and with a
  /// spawn message naming the binary when the command isn't on PATH.
  streamQuery(opts: AgentStreamOptions): Promise<AgentTurnResult> {
    const onEvent = new Channel<AgentStreamEvent>();
    onEvent.onmessage = (message) => {
      if (message.event === "chunk") opts.onChunk(message.data.text);
      else opts.onStderr?.(message.data.text);
    };
    return invoke<AgentTurnResult>("agent_stream_query", {
      repoPath: opts.repoPath,
      commandTemplate: opts.commandTemplate,
      prompt: opts.prompt,
      secretBindings: opts.secretBindings,
      turnId: opts.turnId,
      onEvent,
    });
  },

  /// Kill the child process for `turnId`, killing its whole process group so
  /// the CLI behind the login shell dies with it. Resolves `false` when there
  /// was no such turn in flight, which is not an error: a cancel that races the
  /// turn's own completion is an ordinary double-click.
  cancelTurn(turnId: string): Promise<boolean> {
    return invoke<boolean>("agent_cancel_turn", { turnId });
  },
};
