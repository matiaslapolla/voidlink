/// What a failed probe *says* is the whole value of the probe.
///
/// Passing is easy to get right and rare to look at. The cases that matter are
/// the three failures a user actually hits — no CLI, a flag the installed
/// version rejects, an unauthenticated machine — because each has a different
/// fix and the backend's raw string names none of them. A test button that
/// prints `AI command exited with exit status: 1:` has told the user nothing.
import { describe, expect, it, vi, beforeEach } from "vitest";

/// A hand-rolled double rather than `vi.fn()`: a mock whose implementation
/// rejects gets its rejection observed twice — once by the code under test and
/// once by vitest's own result tracking — and the second observation is
/// reported as an unhandled error that fails the very test asserting the
/// rejection is handled. Recording the calls by hand costs three lines and has
/// no such opinion.
const calls: unknown[][] = [];
let answer: () => Promise<string> = () => Promise.resolve("ok");
vi.mock("@/api/git", () => ({
  gitApi: {
    agentQuery: (...args: unknown[]) => {
      calls.push(args);
      return answer();
    },
  },
}));

import { explainProbeFailure, probeClaudeAgent } from "./agentProbe";
import { CLAUDE_PROBE_PROMPT, DEFAULT_CLAUDE_SPEC } from "@/store/claudeAgent";

beforeEach(() => {
  calls.length = 0;
  answer = () => Promise.resolve("ok");
});

describe("probeClaudeAgent", () => {
  it("spawns the probe command in the repo and reports the reply", async () => {
    answer = () => Promise.resolve("ok\n");
    const state = await probeClaudeAgent("/repo", { ...DEFAULT_CLAUDE_SPEC, model: "haiku" });

    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual([
      "/repo",
      "claude -p --tools '' --model 'haiku'",
      CLAUDE_PROBE_PROMPT,
    ]);
    expect(state).toMatchObject({ kind: "ok", reply: "ok" });
  });

  it("shows one line of the answer, so a pass is visibly a real spawn", async () => {
    answer = () => Promise.resolve("ok\nand then some\nmore");
    const state = await probeClaudeAgent("/repo", DEFAULT_CLAUDE_SPEC);
    expect(state).toMatchObject({ kind: "ok", reply: "ok" });
  });

  it("resolves on failure rather than rejecting — the failure is the point", async () => {
    answer = () => Promise.reject(new Error("failed to spawn `claude`: No such file (os error 2)"));
    const state = await probeClaudeAgent("/repo", DEFAULT_CLAUDE_SPEC);
    expect(state.kind).toBe("failed");
  });
});

describe("explainProbeFailure", () => {
  it("names the binary and the fix when nothing spawned", () => {
    // The GUI-vs-terminal PATH difference is the single most common report:
    // `claude` works in the user's shell and is invisible to the app.
    const out = explainProbeFailure("failed to spawn `claude`: No such file (os error 2)");
    expect(out).toContain("claude");
    expect(out).toMatch(/PATH/);
  });

  it("calls out a flag the installed version rejected", () => {
    // This is flag drift — the failure the whole button exists to catch.
    const out = explainProbeFailure(
      "AI command exited with exit status: 1: error: unknown option '--effort'",
    );
    expect(out).toMatch(/rejected a flag/i);
    expect(out).toContain("--effort");
  });

  it("sends an unauthenticated machine to `claude`, not to a settings pane", () => {
    // There is no key to paste any more, so the only useful instruction is to
    // sign the CLI in.
    const out = explainProbeFailure("Invalid API key · Please run /login");
    expect(out).toMatch(/authenticated|sign in/i);
  });

  it("blames the model, not the network, when an alias will not resolve", () => {
    // What an out-of-date `claude` first on the PATH actually returns for a
    // model alias a newer one resolves. It reads as an outage and is a setting.
    const out = explainProbeFailure(
      'AI command exited with exit status: 1: API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: opus"}}',
    );
    expect(out).toContain("opus");
    expect(out).toMatch(/set Model|update the CLI/i);
  });

  it("passes an unrecognised error through instead of flattening it", () => {
    expect(explainProbeFailure('"connection reset by peer"')).toBe("connection reset by peer");
  });
});
