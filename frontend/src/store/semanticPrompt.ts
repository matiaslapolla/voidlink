/// OSC 133 — the semantic prompt sequences — parsed out of the PTY stream.
///
/// This module is the *reading* half of shell integration, and it is pure on
/// purpose: everything here is a string in and a decision out, so the rule that
/// finally makes `failed` reachable from a terminal can be proven without a
/// shell, a PTY, or an emulator.
///
/// ## Why this exists
///
/// `store/terminalWatch.ts` infers a command's completion from the process poll
/// going idle, and idle carries no status. So a `cargo build` that fails inside
/// a live shell raised `finished` — the poll saw the foreground process go away
/// and had nothing else to say. `failed` was the highest signal in §7.5.3's
/// vocabulary and it was unreachable from the surface users spend the most time
/// in. Only the *shell* knows `$?`, so the only way to learn it is to have the
/// shell say so.
///
/// OSC 133 is how every terminal that solved this solved it — FinalTerm
/// originated it, iTerm2, VS Code, WezTerm and kitty all consume it:
///
///   * `OSC 133 ; A ST` — the prompt is about to be drawn.
///   * `OSC 133 ; B ST` — the prompt has been drawn; what follows is the
///     command line the user is typing.
///   * `OSC 133 ; C ST` — the command is about to run.
///   * `OSC 133 ; D ; <exit-code> ST` — it finished, with that status.
///
/// The pair we actually need is C and D. A and B are parsed anyway because they
/// are the first thing a shell emits and are therefore the cheapest possible
/// evidence that integration is installed at all — a shell that only ever
/// prints prompts still tells us it is wired up, which is what lets the settings
/// screen answer "did my rc change work?" honestly instead of guessing.

/// The OSC identifier. `registerOscHandler` takes it as a number.
export const SEMANTIC_PROMPT_OSC = 133;

export type SemanticPromptMark =
  | { kind: "prompt-start" }
  | { kind: "prompt-end" }
  | { kind: "command-start" }
  /// `exitCode` is `null` when the shell emitted a bare `D` — it ended the
  /// command but did not say how. Kept distinct from `0` all the way through:
  /// "finished, status unknown" and "succeeded" are different claims, and the
  /// only honest thing to do with the first is what we did before shell
  /// integration existed.
  | { kind: "command-end"; exitCode: number | null };

/// Parse one OSC 133 payload — everything xterm hands the handler, i.e. the
/// text *after* `ESC ] 133 ;` and before the terminator.
///
/// `null` for anything unrecognised, and that is load-bearing rather than
/// defensive. OSC 133 is an open namespace that shells and prompt frameworks
/// extend: fish appends `;k=i`, kitty and iTerm2 append `;aid=<n>`, some emit
/// sub-commands we have no interest in (`P`, `L`). Field parsing therefore
/// reads the first field and *ignores the rest* rather than requiring an exact
/// shape — a stricter parser would silently stop working the day the user
/// installs a prompt that adds a field, and the symptom would be `failed`
/// quietly becoming unreachable again.
export function parseSemanticPrompt(payload: string): SemanticPromptMark | null {
  const fields = payload.split(";");
  switch (fields[0]?.trim()) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "prompt-end" };
    case "C":
      return { kind: "command-start" };
    case "D":
      return { kind: "command-end", exitCode: parseExitCode(fields[1]) };
    default:
      return null;
  }
}

/// `D`'s status field. Absent, empty or malformed all mean "the shell did not
/// tell us", which is not the same as zero — see `SemanticPromptMark`.
///
/// Non-negative integers only. A shell reporting a signal death writes `130`
/// (128 + SIGINT) rather than a negative number, so there is no legitimate
/// negative status to accept, and a `-` would only ever arrive from a sequence
/// that is not really OSC 133.
function parseExitCode(field: string | undefined): number | null {
  if (field === undefined) return null;
  const trimmed = field.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/// How long a command has to run before its completion is worth a mark.
///
/// The poll-based path has an equivalent floor (`MIN_BUSY_SAMPLES` × the poll
/// interval) and it exists for the same reason: nobody wants a badge for `ls`.
/// Shell integration makes that floor *necessary* rather than incidental,
/// because unlike the poll it sees every single command — including the dozens
/// of sub-100ms ones a person types in a minute.
///
/// One second, which is what `terminalWatch`'s hysteresis comment already
/// claims its rule achieves. Stated as a duration rather than a sample count
/// because here we have the real span: C's timestamp to D's.
export const MIN_COMMAND_MS = 1000;

export interface CommandSpan {
  /// C to D, in milliseconds. `null` when there was no C — see below.
  durationMs: number | null;
  exitCode: number | null;
  /// Did the shell paint the alternate screen at any point during the span?
  wasFullScreen: boolean;
}

/// Was a command that just ended news the user should be told about?
///
/// Three rejections, each closing a way this could become noise:
///
///   * **No `C`.** We attached mid-command (a pane rebuilt after a worktree
///     switch, a shell that was already running), so we know it ended but not
///     what it was or how long it took. Reporting an event we cannot describe
///     is worse than reporting nothing.
///   * **The alternate screen.** Quitting `vim` is not a build finishing, and
///     `:cq` exits non-zero — without this, closing an editor the deliberate
///     way would raise the one signal that cannot be dismissed by looking at it.
///     Same rule as `completionIsNews`, same reason.
///   * **Under a second.** `grep` finding nothing exits 1. So does `test -f`,
///     `git diff --quiet`, and half of what a shell script does. The failing
///     ones are the dangerous case: `failed` is the only signal §7.5.3 says
///     must be *acknowledged* rather than dismissed by looking, so a spurious
///     one costs strictly more than a spurious `finished` — which is exactly
///     why failures get no easier a gate here than successes do.
///
/// The cost of the last rule, stated rather than hidden: a genuinely
/// interesting command that fails in 300ms (a typo'd `cargo` subcommand, a
/// compile that dies on the first file) raises nothing. That is the same class
/// of miss the poll already accepts, and the alternative — a red mark you have
/// to dismiss every time a `grep` misses — is the failure mode that makes
/// people turn signals off.
export function commandIsNews(span: CommandSpan): boolean {
  if (span.durationMs === null) return false;
  if (span.wasFullScreen) return false;
  return span.durationMs >= MIN_COMMAND_MS;
}

/// Did this command fail?
///
/// A missing status is **not** a failure. It is the pre-integration state of
/// the world — "something ended" — and the whole point of this work is that a
/// red mark means a real non-zero `$?` and nothing else.
export function commandFailed(exitCode: number | null): boolean {
  return exitCode !== null && exitCode !== 0;
}
