/// What counts as "an agent is running in this shell", and nothing else.
///
/// The activity vocabulary in `components/layout/StatusLed.tsx` gained states
/// that only make sense for an agent CLI — "it is asking you for permission" is
/// not a thing `zsh` can be. Something therefore has to answer *is the thing in
/// the foreground of this shell an agent at all*, and the answer has to be a
/// pure function so the whole derivation is testable without a PTY.
///
/// The observable is the one the app already has: `PtyProcessInfo.name`, the
/// foreground process the `tcgetpgrp` poll in `pty_process_info` reports. No new
/// Rust command, no PTY-stream sniffing for per-CLI prompt shapes — a roster of
/// binary names matched on the basename is crude, but it is crude in the
/// direction that fails safe: an unrecognised binary renders *no* indicator,
/// which is exactly what a plain shell should render.

/// The known agent CLIs, matched case-insensitively against the basename of the
/// foreground process.
///
/// **To extend:** add the binary's name as it appears in `ps` — lower case, no
/// path, no extension. That is the whole contract; nothing else keys off this
/// list's order or length. A wrapper script counts as its own entry (the poll
/// sees the wrapper, not what it execs), and a version-suffixed binary
/// (`claude-1.2`) needs its own entry too, because the match is exact rather
/// than a prefix — a prefix match would claim `codex-mirror` and `ampere`.
export const AGENT_CLIS: readonly string[] = [
  "claude",
  "codex",
  "aider",
  "gemini",
  "cursor-agent",
  "opencode",
  "amp",
];

const ROSTER = new Set(AGENT_CLIS);

/// Is this foreground process name a recognised agent CLI?
///
/// `null` — an idle prompt, where there is no foreground process at all — is
/// not an agent. Neither is `bash`, `zsh` or `nvim`: they get no indicator,
/// which is a different state from `idle` and deliberately so.
export function isAgentCli(name: string | null | undefined): boolean {
  const base = agentCliName(name);
  return base !== null && ROSTER.has(base);
}

/// The normalised basename of a foreground process name, or `null` when there
/// isn't one. Exported because the dashboard labels cards with it and must not
/// re-derive the normalisation.
///
/// The poll usually hands us a bare `comm` value, but a shell that was started
/// with an absolute path, or a name with a trailing argument, has both been
/// observed — so the basename is taken and the value trimmed before matching.
export function agentCliName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const base = trimmed.split("/").pop() ?? trimmed;
  return base.toLowerCase() || null;
}

/// How long an agent's PTY must be silent before it counts as *waiting on you*
/// rather than *working*.
///
/// The heuristic, stated rather than hidden: an agent CLI that is in the
/// foreground and has stopped writing to its PTY is, by construction, waiting
/// for the user — it is the only thing it can be doing. That is why no per-CLI
/// prompt text is parsed here, and why the OSC 133 gate the brief floated was
/// dropped: semantic prompts bracket the *shell's* commands, so `claude` emits
/// `C` when it launches and `D` when it quits and says nothing at all about the
/// permission prompt in between. Integration would have gated the feature on a
/// signal that cannot observe it.
///
/// 5s, which is above `OUTPUT_IDLE_MS` (1500ms — the point `working` goes off)
/// with room for an agent that pauses mid-thought, and below the point a user
/// would have looked away and back.
export const AGENT_QUIET_MS = 5000;

/// Has an agent been silent long enough to count as waiting? Pure, so the
/// window is testable without a clock.
export function agentIsWaiting(state: {
  /// A foreground process is present and is on the roster.
  agent: boolean;
  /// The output-rate window says bytes are arriving right now.
  outputActive: boolean;
  /// Milliseconds since the last byte, or `null` if none has ever arrived.
  quietMs: number | null;
}): boolean {
  if (!state.agent || state.outputActive) return false;
  return state.quietMs === null || state.quietMs >= AGENT_QUIET_MS;
}
