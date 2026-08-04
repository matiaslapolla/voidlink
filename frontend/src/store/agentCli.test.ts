import { describe, expect, it } from "vitest";
import {
  AGENT_CLIS,
  AGENT_QUIET_MS,
  agentCliName,
  agentIsWaiting,
  isAgentCli,
} from "./agentCli";
import { terminalSignal } from "@/components/layout/activitySignal";

describe("isAgentCli", () => {
  it("recognises every binary on the roster", () => {
    for (const name of AGENT_CLIS) expect(isAgentCli(name), name).toBe(true);
  });

  it("matches case-insensitively on the basename", () => {
    expect(isAgentCli("Claude")).toBe(true);
    expect(isAgentCli("/opt/homebrew/bin/claude")).toBe(true);
    expect(isAgentCli("  codex  ")).toBe(true);
    expect(isAgentCli("/usr/local/bin/CURSOR-AGENT")).toBe(true);
  });

  /// The plain-shell case the whole "no indicator" state exists for, plus the
  /// editor that used to be the reason `busy` was useless.
  it("does not recognise a shell, an editor, or an empty foreground", () => {
    for (const name of ["bash", "zsh", "fish", "nvim", "vim", "lazygit", "npm"]) {
      expect(isAgentCli(name), name).toBe(false);
    }
    expect(isAgentCli(null)).toBe(false);
    expect(isAgentCli(undefined)).toBe(false);
    expect(isAgentCli("")).toBe(false);
    expect(isAgentCli("   ")).toBe(false);
  });

  /// Exact, not prefix. A prefix match would claim every binary that happens to
  /// start with a roster name.
  it("does not match by prefix", () => {
    expect(isAgentCli("claude-wrapper")).toBe(false);
    expect(isAgentCli("ampere")).toBe(false);
    expect(isAgentCli("codex-mirror")).toBe(false);
  });
});

describe("agentCliName", () => {
  it("normalises to a lower-case basename, or null", () => {
    expect(agentCliName("/usr/bin/Claude")).toBe("claude");
    expect(agentCliName("  zsh ")).toBe("zsh");
    expect(agentCliName(null)).toBeNull();
    expect(agentCliName("  ")).toBeNull();
  });
});

describe("agentIsWaiting", () => {
  it("is false while the agent is producing output", () => {
    expect(agentIsWaiting({ agent: true, outputActive: true, quietMs: 60_000 })).toBe(false);
  });

  it("is false for anything that is not an agent, however quiet", () => {
    expect(agentIsWaiting({ agent: false, outputActive: false, quietMs: 60_000 })).toBe(false);
  });

  it("waits out the quiet window before claiming the user is owed an answer", () => {
    expect(
      agentIsWaiting({ agent: true, outputActive: false, quietMs: AGENT_QUIET_MS - 1 }),
    ).toBe(false);
    expect(agentIsWaiting({ agent: true, outputActive: false, quietMs: AGENT_QUIET_MS })).toBe(
      true,
    );
  });

  /// An agent we attached to mid-session, that has never written a byte. It is
  /// sitting at a prompt by definition, so it is waiting.
  it("counts an agent that has never produced output as waiting", () => {
    expect(agentIsWaiting({ agent: true, outputActive: false, quietMs: null })).toBe(true);
  });
});

/// The end-to-end shape of the rule, one layer up: what a row actually renders
/// for a shell whose foreground process is on the roster and one whose is not.
describe("roster to indicator", () => {
  it("gives a recognised agent a mark and a plain shell none", () => {
    expect(
      terminalSignal({
        agent: isAgentCli("claude"),
        working: false,
        waiting: true,
        focused: false,
      }),
    ).toBe("waiting");
    expect(
      terminalSignal({
        agent: isAgentCli("zsh"),
        working: false,
        waiting: true,
        focused: true,
      }),
    ).toBeUndefined();
  });
});
