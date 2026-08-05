/// Quoting is the whole risk here.
///
/// Every other field is a string that either appears after a flag or does not.
/// The system prompt is different in kind: it is free prose the user pasted,
/// it lands on a shell command line, and getting it *nearly* right produces a
/// command that runs — with the second half of the prompt reinterpreted as
/// flags, or with `$HOME` expanded inside what was meant to be literal text.
/// So the cases below are the characters that actually break it rather than a
/// round-trip of a tidy sentence.
import { describe, expect, it } from "vitest";
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  DEFAULT_CLAUDE_SPEC,
  composeClaudeCommand,
  composeClaudeProbeCommand,
  describeClaudeSpec,
  parseClaudeSpec,
  shellQuote,
  type ClaudeAgentSpec,
} from "./claudeAgent";

const spec = (patch: Partial<ClaudeAgentSpec> = {}): ClaudeAgentSpec => ({
  ...DEFAULT_CLAUDE_SPEC,
  ...patch,
});

describe("shellQuote", () => {
  it("wraps in single quotes so the shell expands nothing", () => {
    // `$`, backtick and backslash are all live inside double quotes and inert
    // inside single ones — which is the entire reason for the choice.
    expect(shellQuote("cost is $HOME `whoami` \\n")).toBe("'cost is $HOME `whoami` \\n'");
  });

  it("survives the apostrophe, which is the one character that can escape", () => {
    expect(shellQuote("don't")).toBe(`'don'\\''t'`);
    // Two in a row, and one at each end — the off-by-one shapes.
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });

  it("passes a newline through, because a multi-line prompt is the normal case", () => {
    expect(shellQuote("one\ntwo")).toBe("'one\ntwo'");
  });
});

describe("composeClaudeCommand", () => {
  it("is bare `claude` when nothing has been filled in", () => {
    expect(composeClaudeCommand(DEFAULT_CLAUDE_SPEC)).toBe("claude");
  });

  it("labels the session, which is what makes four panes four named agents", () => {
    expect(composeClaudeCommand(DEFAULT_CLAUDE_SPEC, "Reviewer")).toBe("claude --name 'Reviewer'");
    // A blank name omits the flag rather than passing an empty one.
    expect(composeClaudeCommand(DEFAULT_CLAUDE_SPEC, "   ")).toBe("claude");
  });

  it("appends the system prompt by default and replaces only when asked", () => {
    expect(composeClaudeCommand(spec({ systemPrompt: "Be terse." }))).toBe(
      "claude --append-system-prompt 'Be terse.'",
    );
    expect(
      composeClaudeCommand(spec({ systemPrompt: "Be terse.", systemPromptMode: "replace" })),
    ).toBe("claude --system-prompt 'Be terse.'");
  });

  it("keeps a prompt with an apostrophe in it as one argument", () => {
    // The failure this guards is not a crash: it is a command that still runs,
    // with everything after the apostrophe read as further arguments.
    const out = composeClaudeCommand(spec({ systemPrompt: "don't guess --model opus" }));
    expect(out).toBe(`claude --append-system-prompt 'don'\\''t guess --model opus'`);
  });

  it("omits a flag whose field is blank rather than passing an empty value", () => {
    const out = composeClaudeCommand(spec({ permissionMode: "", effort: "", model: "  " }));
    expect(out).not.toContain("--permission-mode");
    expect(out).not.toContain("--effort");
    expect(out).not.toContain("--model");
  });

  it("takes tool lists separated either way, since the CLI does", () => {
    expect(composeClaudeCommand(spec({ allowedTools: "Read, Edit  Grep" }))).toBe(
      "claude --allowed-tools 'Read' 'Edit' 'Grep'",
    );
    expect(composeClaudeCommand(spec({ disallowedTools: "Bash" }))).toBe(
      "claude --disallowed-tools 'Bash'",
    );
  });

  it("gives each extra directory its own flag, so a path with a space survives", () => {
    expect(composeClaudeCommand(spec({ addDirs: "/a/b\n/c d/e\n\n" }))).toBe(
      "claude --add-dir '/a/b' --add-dir '/c d/e'",
    );
  });

  it("passes the escape hatch through unquoted — it is arguments, not an argument", () => {
    expect(composeClaudeCommand(spec({ extraArgs: "--betas foo --ide" }))).toBe(
      "claude --betas foo --ide",
    );
  });

  it("orders the flags so the escape hatch can override what the form set", () => {
    const out = composeClaudeCommand(
      spec({ model: "opus", continueSession: true, extraArgs: "--model sonnet" }),
      "Fixer",
    );
    expect(out).toBe("claude --name 'Fixer' --model 'opus' --continue --model sonnet");
    // Last wins on the CLI's own parser, so a user overriding a field from the
    // escape hatch gets the override — which is the only useful meaning of an
    // escape hatch that sits beside the form.
    expect(out.lastIndexOf("--model sonnet")).toBeGreaterThan(out.indexOf("--model 'opus'"));
  });

  it("is interactive — no -p, because a piped agent cannot answer a permission prompt", () => {
    expect(composeClaudeCommand(spec({ systemPrompt: "x" }))).not.toMatch(/(^|\s)-p(\s|$)/);
    expect(composeClaudeCommand(spec({ systemPrompt: "x" }))).not.toContain("--print");
  });
});

/// The probe is only worth having if it tests the *same* agent the user
/// configured. Every case here is a way for it to quietly test something else
/// and pass — which is worse than having no button, because a green tick is a
/// claim.
describe("composeClaudeProbeCommand", () => {
  it("prints and restricts tools, and adds nothing else", () => {
    expect(composeClaudeProbeCommand(DEFAULT_CLAUDE_SPEC)).toBe("claude -p --tools ''");
  });

  it("adds no flag the agent itself does not need", () => {
    // `--no-session-persistence` was here, purely so the probe would not show
    // up in `/resume`, and it is unknown to a `claude` two minor versions old —
    // so the first failure the button ever reported was one it had invented.
    // A probe that fails on its own conveniences tests nothing.
    expect(composeClaudeProbeCommand(DEFAULT_CLAUDE_SPEC)).not.toContain(
      "--no-session-persistence",
    );
  });

  it("carries every configured flag, so a rejected flag is a failed test", () => {
    // The list is the point: a probe missing one of these passes for an agent
    // that will not start.
    const out = composeClaudeProbeCommand(
      spec({
        model: "opus",
        systemPrompt: "Be terse.",
        permissionMode: "plan",
        effort: "high",
        allowedTools: "Read Grep",
        disallowedTools: "Bash",
        addDirs: "/a/b",
      }),
    );
    expect(out).toContain("--model 'opus'");
    expect(out).toContain("--append-system-prompt 'Be terse.'");
    expect(out).toContain("--permission-mode plan");
    expect(out).toContain("--effort high");
    expect(out).toContain("--allowed-tools 'Read' 'Grep'");
    expect(out).toContain("--disallowed-tools 'Bash'");
    expect(out).toContain("--add-dir '/a/b'");
  });

  it("quotes the system prompt the same way the launch command does", () => {
    const patch = { systemPrompt: "don't guess" };
    expect(composeClaudeProbeCommand(spec(patch))).toContain(
      `--append-system-prompt 'don'\\''t guess'`,
    );
  });

  it("never resumes the folder's real conversation to ask it a test question", () => {
    // `--continue` in a probe writes a turn into a session the user cares
    // about, which is a side effect no test button is allowed to have.
    expect(composeClaudeProbeCommand(spec({ continueSession: true }))).not.toContain("--continue");
  });

  it("includes the escape hatch, because it is configuration too", () => {
    expect(composeClaudeProbeCommand(spec({ extraArgs: "--betas foo" }))).toContain("--betas foo");
  });

  it("has no --name: a probe is not a session anyone will look for", () => {
    expect(composeClaudeProbeCommand(spec({ model: "opus" }))).not.toContain("--name");
  });
});

/// The one thing this file cannot prove on its own is that these are the CLI's
/// actual options — that is what the Test button is for at runtime. What it can
/// pin is the *spelling* of what we emit, so an edit that renames a flag has to
/// be deliberate rather than incidental.
///
/// Verified against `claude --help` on 2.1.222 (July 2026).
describe("the flag vocabulary, as of the installed CLI", () => {
  it("emits only options that version documents", () => {
    const emitted = composeClaudeProbeCommand(
      spec({
        model: "opus",
        systemPrompt: "x",
        permissionMode: "plan",
        effort: "high",
        allowedTools: "Read",
        disallowedTools: "Bash",
        addDirs: "/a",
      }),
    )
      .split(" ")
      .filter((token) => token.startsWith("--") || token === "-p");
    expect(new Set(emitted)).toEqual(
      new Set([
        "-p",
        "--tools",
        "--model",
        "--append-system-prompt",
        "--permission-mode",
        "--effort",
        "--allowed-tools",
        "--disallowed-tools",
        "--add-dir",
      ]),
    );
    // The two the launch command adds on top.
    const launch = composeClaudeCommand(spec({ continueSession: true }), "Reviewer");
    expect(launch).toContain("--name");
    expect(launch).toContain("--continue");
    expect(composeClaudeCommand(spec({ systemPrompt: "x", systemPromptMode: "replace" }))).toContain(
      "--system-prompt",
    );
  });

  it("offers exactly the CLI's own choice lists", () => {
    // `--permission-mode (choices: "acceptEdits", "auto", "bypassPermissions",
    // "manual", "dontAsk", "plan")` and `--effort <low|medium|high|xhigh|max>`.
    expect([...CLAUDE_PERMISSION_MODES].sort()).toEqual(
      ["acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"].sort(),
    );
    expect([...CLAUDE_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("describeClaudeSpec", () => {
  it("says something rather than nothing for an untouched spec", () => {
    expect(describeClaudeSpec(DEFAULT_CLAUDE_SPEC)).toBe("Claude defaults");
  });

  it("distinguishes an added system prompt from a replaced one", () => {
    expect(describeClaudeSpec(spec({ systemPrompt: "x" }))).toContain("extra instructions");
    expect(describeClaudeSpec(spec({ systemPrompt: "x", systemPromptMode: "replace" }))).toContain(
      "custom system prompt",
    );
  });

  it("counts the tool lists rather than reprinting them", () => {
    expect(describeClaudeSpec(spec({ allowedTools: "Read Edit" }))).toContain("2 tools allowed");
    expect(describeClaudeSpec(spec({ allowedTools: "Read" }))).toContain("1 tool allowed");
  });
});

describe("parseClaudeSpec", () => {
  it("is undefined for a hand-written entry, which has no spec at all", () => {
    expect(parseClaudeSpec(undefined)).toBeUndefined();
    expect(parseClaudeSpec(null)).toBeUndefined();
    expect(parseClaudeSpec("claude --model opus")).toBeUndefined();
  });

  it("fills every absent field from the defaults", () => {
    expect(parseClaudeSpec({})).toEqual(DEFAULT_CLAUDE_SPEC);
  });

  it("drops an enum member this build does not know, and only that field", () => {
    // Hand-edited JSON is a realistic input — Settings → JSON writes this same
    // file. One bad field must cost one field.
    const out = parseClaudeSpec({ permissionMode: "yolo", model: "opus", effort: "extreme" });
    expect(out?.permissionMode).toBe("");
    expect(out?.effort).toBe("");
    expect(out?.model).toBe("opus");
  });

  it("does not compose a flag out of a rejected mode", () => {
    // The point of falling back to blank rather than to `manual`: an unknown
    // mode means the flag is not passed, so the CLI's own configured default
    // stands instead of one this pane invented.
    const out = parseClaudeSpec({ permissionMode: "yolo" })!;
    expect(composeClaudeCommand(out)).toBe("claude");
  });

  it("keeps every known mode and effort", () => {
    for (const mode of ["manual", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"]) {
      expect(parseClaudeSpec({ permissionMode: mode })?.permissionMode).toBe(mode);
    }
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(parseClaudeSpec({ effort })?.effort).toBe(effort);
    }
  });
});
