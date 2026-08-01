/// OSC 133 parsing and the news rule, proven without a shell.
///
/// The boundary this suite cannot cross is worth stating up front: it feeds the
/// parser the payloads real shells produce, but nothing here drives a real
/// shell. What is proven is that a given payload maps to a given decision. What
/// is *not* proven — and cannot be, from a test runner — is that zsh and bash
/// emit those payloads at the right moments; that lives in
/// `shell-integration/`, and is verified by running the snippets.
import { describe, expect, it } from "vitest";
import {
  commandFailed,
  commandIsNews,
  MIN_COMMAND_MS,
  parseSemanticPrompt,
  SEMANTIC_PROMPT_OSC,
} from "./semanticPrompt";

describe("parsing OSC 133 payloads", () => {
  it("uses the identifier xterm registers handlers under", () => {
    expect(SEMANTIC_PROMPT_OSC).toBe(133);
  });

  it("reads the four marks", () => {
    expect(parseSemanticPrompt("A")).toEqual({ kind: "prompt-start" });
    expect(parseSemanticPrompt("B")).toEqual({ kind: "prompt-end" });
    expect(parseSemanticPrompt("C")).toEqual({ kind: "command-start" });
    expect(parseSemanticPrompt("D;0")).toEqual({ kind: "command-end", exitCode: 0 });
  });

  it("reads the exit status out of D", () => {
    expect(parseSemanticPrompt("D;1")).toEqual({ kind: "command-end", exitCode: 1 });
    expect(parseSemanticPrompt("D;127")).toEqual({ kind: "command-end", exitCode: 127 });
    // 128 + SIGINT: how a shell reports a command the user killed.
    expect(parseSemanticPrompt("D;130")).toEqual({ kind: "command-end", exitCode: 130 });
  });

  /// The extension case. OSC 133 is an open namespace — fish appends `k=i`,
  /// kitty and iTerm2 append `aid=<n>` — and a parser that demanded an exact
  /// field count would silently stop working the day the user changes prompt,
  /// with `failed` quietly becoming unreachable again.
  it("ignores trailing fields other shells add", () => {
    expect(parseSemanticPrompt("A;aid=7")).toEqual({ kind: "prompt-start" });
    expect(parseSemanticPrompt("A;k=i")).toEqual({ kind: "prompt-start" });
    expect(parseSemanticPrompt("C;cmdline=ls")).toEqual({ kind: "command-start" });
    expect(parseSemanticPrompt("D;1;aid=7")).toEqual({ kind: "command-end", exitCode: 1 });
  });

  /// "It ended" and "it succeeded" are different claims and must stay
  /// different all the way through — a bare `D` is a shell that could not tell
  /// us, not a shell reporting success.
  it("reports a missing or malformed status as unknown, never as zero", () => {
    expect(parseSemanticPrompt("D")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseSemanticPrompt("D;")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseSemanticPrompt("D;oops")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseSemanticPrompt("D;-1")).toEqual({ kind: "command-end", exitCode: null });
    expect(parseSemanticPrompt("D;1.5")).toEqual({ kind: "command-end", exitCode: null });
  });

  it("rejects sub-commands and junk rather than guessing", () => {
    expect(parseSemanticPrompt("P;k=i")).toBeNull();
    expect(parseSemanticPrompt("L")).toBeNull();
    expect(parseSemanticPrompt("")).toBeNull();
    expect(parseSemanticPrompt("notify;done")).toBeNull();
  });
});

describe("what counts as a failure", () => {
  it("is a reported non-zero status and nothing else", () => {
    expect(commandFailed(1)).toBe(true);
    expect(commandFailed(127)).toBe(true);
    expect(commandFailed(0)).toBe(false);
  });

  /// The rule that keeps the red mark meaning something. An unknown status is
  /// the pre-integration state of the world; treating it as failure would light
  /// up every shell that emits a bare `D`.
  it("is never an unknown status", () => {
    expect(commandFailed(null)).toBe(false);
  });
});

describe("whether a finished command is news", () => {
  const span = (over: Partial<Parameters<typeof commandIsNews>[0]> = {}) =>
    commandIsNews({ durationMs: 5000, exitCode: 0, wasFullScreen: false, ...over });

  it("reports a command that ran long enough to be waited on", () => {
    expect(span({ durationMs: MIN_COMMAND_MS })).toBe(true);
    expect(span({ durationMs: 90_000, exitCode: 1 })).toBe(true);
  });

  /// `grep` finding nothing exits 1, and so does half of what a shell script
  /// does. Unlike the poll, shell integration sees every one of them.
  it("suppresses commands too short to have been waited on", () => {
    expect(span({ durationMs: 5 })).toBe(false);
    expect(span({ durationMs: MIN_COMMAND_MS - 1 })).toBe(false);
  });

  /// The asymmetry that is deliberately absent: a failure gets no easier a gate
  /// than a success, because `failed` is the only signal that has to be
  /// acknowledged rather than dismissed by looking, so a spurious one costs
  /// strictly more.
  it("gives a short failure no easier a gate than a short success", () => {
    expect(span({ durationMs: 5, exitCode: 1 })).toBe(false);
    expect(span({ durationMs: 5, exitCode: 0 })).toBe(false);
  });

  /// Quitting `vim` is not a build finishing — and `:cq` exits non-zero, so
  /// without this the deliberate way to leave an editor would raise the one
  /// mark you cannot get rid of by looking at it.
  it("never reports a full-screen app exiting, however long it ran", () => {
    expect(span({ durationMs: 600_000, wasFullScreen: true })).toBe(false);
    expect(span({ durationMs: 600_000, exitCode: 1, wasFullScreen: true })).toBe(false);
  });

  /// We attached mid-command: a pane rebuilt after a worktree switch, or a
  /// shell that was already running. We know it ended and nothing else.
  it("reports nothing for a D it has no C for", () => {
    expect(span({ durationMs: null })).toBe(false);
    expect(span({ durationMs: null, exitCode: 1 })).toBe(false);
  });
});
