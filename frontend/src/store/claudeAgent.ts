/// Composing a `claude` invocation from fields a user filled in, rather than
/// from a command line they typed.
///
/// The roster has always been BYO-CLI: a name and a shell string. That is the
/// right contract for "whatever generative-text command you already have", and
/// it is a bad one for the CLI almost everyone in this roster is actually
/// pointing at. A `claude` command with a system prompt, a model, a permission
/// mode and two tool lists in it is eighty characters of quoting in a
/// single-line text input, where a stray apostrophe in the prompt silently
/// changes which flag the next word belongs to.
///
/// So this module owns the other half of the contract: **structured spec in,
/// shell string out**. The escape hatch does not go away — an entry with no
/// spec keeps its hand-written `commandTemplate`, and `extraArgs` passes
/// anything this file has never heard of straight through.
///
/// Pure and DOM-free on purpose. Quoting is the part that is hard to get right
/// and easy to get *nearly* right, so it is unit-tested against the inputs that
/// actually break it — apostrophes, newlines, `$`, backticks — rather than
/// eyeballed in a settings pane.
///
/// **Flags here were read off `claude --help` on the installed binary, not
/// recalled.** Anything added later must be too: a flag that does not exist
/// turns the whole agent into a usage error at spawn time, which the user sees
/// as "the terminal opened and immediately printed help".

/// Claude Code's permission modes, as the CLI's own `--permission-mode` choice
/// list gives them. A closed union rather than a string, so a mode that is
/// removed upstream fails a build here instead of failing a spawn on a user's
/// machine.
export const CLAUDE_PERMISSION_MODES = [
  "manual",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/// `--effort`. Same closed-union reasoning as the permission modes.
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

/// Model aliases the CLI resolves to the current model of that tier, plus the
/// escape hatch of typing a full model name.
///
/// Aliases rather than pinned ids by default, because a pinned id in a settings
/// blob is a slow-motion bug: it keeps working, on last year's model, and
/// nothing ever tells the user. The field is a free-text string so a user who
/// *wants* a pin can have one.
export const CLAUDE_MODEL_PRESETS = ["opus", "sonnet", "haiku", "fable"] as const;

/// Whether the prompt the user wrote is added to Claude's own system prompt or
/// replaces it.
///
/// This is the single most consequential switch in the form and the two options
/// are not variations on each other: `--append-system-prompt` layers a
/// personality onto a working coding agent, while `--system-prompt` discards
/// everything the CLI knows about tools and this repository. Append is the
/// default for that reason.
export type SystemPromptMode = "append" | "replace";

/// A `claude` invocation, as fields.
export interface ClaudeAgentSpec {
  /// `--model`. Blank means the CLI's own default, which is what a user who has
  /// not thought about models should get.
  model: string;
  /// `--append-system-prompt` or `--system-prompt`, per `systemPromptMode`.
  systemPrompt: string;
  systemPromptMode: SystemPromptMode;
  /// `--permission-mode`. Blank means "don't pass the flag" — not the same as
  /// `manual`, because the CLI's own default is a setting the user may have
  /// configured elsewhere and this pane has no business overriding it silently.
  permissionMode: ClaudePermissionMode | "";
  /// `--effort`. Blank means the flag is omitted, as above.
  effort: ClaudeEffort | "";
  /// `--allowed-tools` / `--disallowed-tools`. Free text, comma or space
  /// separated, because the grammar is the CLI's (`Bash(git *)`, `Edit`) and
  /// re-implementing a parser for it here would only be able to be wrong.
  allowedTools: string;
  disallowedTools: string;
  /// `--add-dir`, one per line. Worktrees are the reason this is in the form at
  /// all: an agent that has to read a sibling worktree cannot be given it any
  /// other way.
  addDirs: string;
  /// `--continue`: resume this directory's most recent conversation instead of
  /// starting a fresh one.
  continueSession: boolean;
  /// Appended verbatim, after everything else. The escape hatch for flags this
  /// form does not model — and the reason not modelling one is survivable.
  extraArgs: string;
}

export const DEFAULT_CLAUDE_SPEC: ClaudeAgentSpec = {
  model: "",
  systemPrompt: "",
  systemPromptMode: "append",
  permissionMode: "",
  effort: "",
  allowedTools: "",
  disallowedTools: "",
  addDirs: "",
  continueSession: false,
  extraArgs: "",
};

/// POSIX single-quoting: wrap in `'`, and write an embedded `'` as `'\''`.
///
/// Single quotes rather than double, because inside double quotes the shell
/// still expands `$`, `` ` `` and `\` — and a system prompt is exactly the kind
/// of free text that contains `$1` or a backticked identifier. Inside single
/// quotes the shell expands nothing at all, so the only character needing
/// treatment is the quote itself.
///
/// Newlines need none: a literal newline inside single quotes is a newline, and
/// a multi-line system prompt is the common case here rather than the exotic
/// one.
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/// Split a comma-or-whitespace separated list, dropping empties.
///
/// Used for the tool lists, where `--allowed-tools` itself accepts either
/// separator — so a user pasting from the CLI's own help text gets what they
/// expect either way.
function splitList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/// Split one-per-line, dropping empties. Directories, unlike tool names, can
/// contain spaces and commas.
function splitLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/// The shell command that launches this agent.
///
/// `name` becomes `--name`, which is the whole of the "clearly labelled" claim:
/// the CLI puts it in its prompt box, in `/resume`, and in the terminal's
/// title, so a window with four agents in four panes is four *named* agents
/// rather than four identical `claude` sessions. A blank name omits the flag
/// rather than passing an empty one.
///
/// Interactive — no `-p`. These run in a real PTY beside the user's other
/// terminals, which is the difference between this and the agent *tab*: a tab
/// pipes one grounded prompt to stdin and renders stdout, and cannot answer a
/// permission prompt because there is nothing to answer it with. A terminal
/// can, and the sidebar's "Needs You" count is built to notice when it is
/// waiting.
///
/// Empty fields contribute nothing. A spec straight out of `DEFAULT_CLAUDE_SPEC`
/// with no name composes to bare `claude`, which is exactly what a user who
/// filled nothing in has asked for.
export function composeClaudeCommand(spec: ClaudeAgentSpec, name = ""): string {
  const argv: string[] = ["claude"];

  const label = name.trim();
  if (label) argv.push("--name", shellQuote(label));

  const model = spec.model.trim();
  if (model) argv.push("--model", shellQuote(model));

  const prompt = spec.systemPrompt.trim();
  if (prompt) {
    argv.push(
      spec.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
      shellQuote(prompt),
    );
  }

  if (spec.permissionMode) argv.push("--permission-mode", spec.permissionMode);
  if (spec.effort) argv.push("--effort", spec.effort);

  const allowed = splitList(spec.allowedTools);
  if (allowed.length) argv.push("--allowed-tools", ...allowed.map(shellQuote));

  const disallowed = splitList(spec.disallowedTools);
  if (disallowed.length) argv.push("--disallowed-tools", ...disallowed.map(shellQuote));

  // Repeated rather than joined: `--add-dir` takes a variadic list, and one
  // flag per directory is the spelling that survives a path with a space in it
  // without depending on how the CLI splits its own argument.
  for (const dir of splitLines(spec.addDirs)) argv.push("--add-dir", shellQuote(dir));

  if (spec.continueSession) argv.push("--continue");

  // Last, and unquoted. It is the escape hatch: a user writing `--betas foo`
  // here means two arguments, and quoting the string would pass it as one.
  const extra = spec.extraArgs.trim();
  if (extra) argv.push(extra);

  return argv.join(" ");
}

/// A one-line summary of what this agent is, for the roster row's collapsed
/// state.
///
/// The composed command is the honest answer and it is also eighty characters
/// wide, so the row shows this instead and the command in full underneath when
/// the row is expanded. Says "Claude defaults" rather than nothing when every
/// field is blank: an empty summary reads as a row that failed to load.
export function describeClaudeSpec(spec: ClaudeAgentSpec): string {
  const parts: string[] = [];
  if (spec.model.trim()) parts.push(spec.model.trim());
  if (spec.permissionMode) parts.push(spec.permissionMode);
  if (spec.effort) parts.push(`effort ${spec.effort}`);
  if (spec.systemPrompt.trim()) {
    parts.push(spec.systemPromptMode === "replace" ? "custom system prompt" : "extra instructions");
  }
  const allowed = splitList(spec.allowedTools).length;
  if (allowed) parts.push(`${allowed} tool${allowed === 1 ? "" : "s"} allowed`);
  const denied = splitList(spec.disallowedTools).length;
  if (denied) parts.push(`${denied} denied`);
  if (spec.continueSession) parts.push("continues last session");
  return parts.length ? parts.join(" · ") : "Claude defaults";
}

/// Revive a persisted spec, field by field.
///
/// Same per-field policy as the rest of the settings store: this is
/// user-editable JSON (Settings → JSON writes the same file), so a hand-typed
/// `permissionMode: "yolo"` costs that one field rather than the whole agent.
/// An enum member this build does not know falls back to blank — which means
/// "don't pass the flag", the only safe answer for a mode we cannot vouch for.
///
/// Returns `undefined` for anything that is not an object, which is how an
/// entry says "I am a hand-written command, not a composed one".
export function parseClaudeSpec(raw: unknown): ClaudeAgentSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | "" =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : "";
  return {
    model: str(r.model),
    systemPrompt: str(r.systemPrompt),
    systemPromptMode: r.systemPromptMode === "replace" ? "replace" : "append",
    permissionMode: oneOf(r.permissionMode, CLAUDE_PERMISSION_MODES),
    effort: oneOf(r.effort, CLAUDE_EFFORTS),
    allowedTools: str(r.allowedTools),
    disallowedTools: str(r.disallowedTools),
    addDirs: str(r.addDirs),
    continueSession: r.continueSession === true,
    extraArgs: str(r.extraArgs),
  };
}
