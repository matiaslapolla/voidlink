/// Running a configured agent once, to find out whether it works.
///
/// Everything in the agent form is a claim until something spawns it: that
/// `claude` is installed and on the PATH a GUI app inherits, that the machine
/// is signed in, that each flag still exists in the version actually installed,
/// and that whatever the user typed into the escape hatch parses. Before this,
/// all four were discovered the same way — open a pane, watch it print usage
/// and exit — with nothing connecting the failure back to the field that caused
/// it.
///
/// So this is the one-shot version of the same configuration. No new backend:
/// it goes through `git_agent_query`, which is exactly the pipe-a-prompt-in,
/// read-stdout-back path the agent thread already uses, so a probe that
/// succeeds has proven the real spawn path rather than a simulation of it.
///
/// DOM-free on purpose — the pane renders `ProbeState`, it does not compute it.
import { gitApi } from "@/api/git";
import {
  CLAUDE_PROBE_PROMPT,
  composeClaudeProbeCommand,
  type ClaudeAgentSpec,
} from "@/store/claudeAgent";
import { aiSecretBindings } from "@/store/settings";

export type ProbeState =
  | { kind: "idle" }
  | { kind: "running" }
  /// `reply` is the model's answer, trimmed to one line. Shown rather than
  /// swallowed: "passed" from a component that never spawned anything looks
  /// identical to "passed", and a user has no way to tell them apart.
  | { kind: "ok"; ms: number; reply: string }
  | { kind: "failed"; ms: number; reason: string };

/// Run `spec` through `claude -p` in `repoPath` and report what happened.
///
/// Resolves rather than rejects for every outcome. A test button whose failure
/// path is an unhandled rejection is a test button that reports nothing in the
/// one case it exists for.
export async function probeClaudeAgent(
  repoPath: string,
  spec: ClaudeAgentSpec,
): Promise<ProbeState> {
  const startedAt = performance.now();
  try {
    const reply = await gitApi.agentQuery(
      repoPath,
      composeClaudeProbeCommand(spec),
      CLAUDE_PROBE_PROMPT,
      aiSecretBindings(),
    );
    return {
      kind: "ok",
      ms: Math.round(performance.now() - startedAt),
      reply: firstLine(reply),
    };
  } catch (e) {
    return {
      kind: "failed",
      ms: Math.round(performance.now() - startedAt),
      reason: explainProbeFailure(e instanceof Error ? e.message : String(e)),
    };
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/// Turn a backend error string into the next thing the user should do.
///
/// The three failures below are not variations on "it didn't work" — they have
/// different fixes, and the raw string names none of them. Anything
/// unrecognised is passed through verbatim rather than flattened into a generic
/// message: an error we cannot classify is exactly the one where the CLI's own
/// words are worth more than ours.
export function explainProbeFailure(reason: string): string {
  const spawn = reason.match(/failed to spawn `([^`]+)`/);
  if (spawn) {
    return `${spawn[1]} isn't on this app's PATH — install the Claude Code CLI, or launch voidlink from a terminal.`;
  }
  // The CLI's own argument parser. This is the flag-drift case: a form field
  // spelling an option the installed version no longer has.
  if (/unknown option|unknown argument|error: option|allowed choices|invalid value/i.test(reason)) {
    return `The installed claude rejected a flag: ${tidy(reason)}`;
  }
  if (/not (logged|signed) in|unauthenticated|authentication|401|invalid api key|credit balance/i.test(reason)) {
    return `claude isn't authenticated on this machine — run \`claude\` once in a terminal and sign in. (${tidy(reason)})`;
  }
  // A model alias the *account or the binary* cannot resolve, which reads as a
  // network failure and is not one. Worth its own case because the fix is a
  // field in this very form, and because an outdated `claude` first on the PATH
  // fails exactly this way on an alias a newer one resolves fine.
  const model = reason.match(/"?model"?:\s*"?([\w.-]+)/i);
  if (/404|not_found_error/.test(reason) && model) {
    return `The installed claude couldn't resolve the model "${model[1]}" — set Model above to one it knows, or update the CLI it's running.`;
  }
  return tidy(reason);
}

function tidy(reason: string): string {
  return reason.replace(/^"|"$/g, "").trim();
}
