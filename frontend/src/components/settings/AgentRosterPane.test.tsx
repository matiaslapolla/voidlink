/// The agent roster, mounted.
///
/// `claudeAgent.test.ts` proves the command composes correctly. What only a
/// mounted test can prove is that the pane and that composer are looking at the
/// same object — the failure this file exists for is a form that writes to a
/// field nothing reads, which typechecks, renders, and quietly runs the CLI
/// with none of the settings the user just filled in.
///
/// The other property worth mounting for is the **nesting**. `updateAgentClaude`
/// patches one key of `entry.claude`; a caller that spread its partial into
/// `updateAgent` instead would replace the whole spec and blank every other
/// field. That is invisible in a single-field test and obvious in a two-field
/// one, so every write here is checked against a field it did not touch.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";

import { AgentRosterSection } from "./AgentRosterPane";

const agents = () => useSettings().settings.ai.agents;

beforeEach(() => {
  // The store is a module singleton, so each test starts from the shipped
  // one-entry roster rather than from whatever the last one built.
  useSettings().updateAi({ agents: structuredClone(DEFAULT_SETTINGS.ai.agents) });
  render(() => <AgentRosterSection />);
});

const expand = async (user: ReturnType<typeof userEvent.setup>, summary: RegExp) =>
  user.click(screen.getByRole("button", { expanded: false, name: summary }));

describe("the two kinds of entry", () => {
  it("ships one command agent, and it stays one", () => {
    // The shipped roster predates Claude agents and every roster on disk is
    // this shape. Adding a spec to it on load would silently convert every
    // existing user's agent into a `claude` invocation.
    expect(agents()).toHaveLength(1);
    expect(agents()[0].claude).toBeUndefined();
  });

  it("adds a Claude agent already built, so the form has something to show", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));

    expect(agents()).toHaveLength(2);
    expect(agents()[1].claude).toBeDefined();
    // And it opens expanded — a row added by a button that then shows nothing
    // is a button that appears not to have worked.
    expect(screen.getByLabelText("System prompt")).toBeInTheDocument();
  });

  it("adds a command agent with no spec, which is the other button's whole point", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add command agent" }));

    expect(agents()[1].claude).toBeUndefined();
    // The command input, not the Claude form.
    expect(screen.getByLabelText("Command")).toBeInTheDocument();
    expect(screen.queryByLabelText("System prompt")).toBeNull();
  });

  it("gives consecutive agents different colours without asking", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    const colors = agents().map((a) => a.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("the Claude form writes through to the spec", () => {
  it("patches one field without blanking the rest", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));

    await user.type(screen.getByLabelText("System prompt"), "Be blunt.");
    await user.selectOptions(screen.getByLabelText("Permissions"), "plan");

    const spec = agents()[1].claude!;
    expect(spec.systemPrompt).toBe("Be blunt.");
    // The field written *first* is the one a whole-object write would have
    // destroyed.
    expect(spec.permissionMode).toBe("plan");
    expect(spec.systemPromptMode).toBe("append");
  });

  it("shows the command it will actually run, quoting included", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    await user.type(screen.getByLabelText("System prompt"), "don't guess");

    // The read-only line is the only way a user can check the quoting the form
    // exists to spare them from writing — so it has to be the real composition,
    // not a summary of it.
    expect(
      screen.getByText(`claude --name 'Claude agent' --append-system-prompt 'don'\\''t guess'`),
    ).toBeInTheDocument();
  });

  it("warns that replacing the system prompt is not a stronger version of adding to it", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    expect(screen.getByText(/keeps everything it knows/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace Claude's" }));
    expect(screen.getByText(/no longer be told about its tools/i)).toBeInTheDocument();
  });
});

describe("switching between the two", () => {
  it("builds an existing command agent into a Claude one", async () => {
    const user = userEvent.setup();
    await expand(user, /no command/i);
    await user.click(screen.getByRole("button", { name: /Build this as a Claude agent/i }));

    expect(agents()[0].claude).toEqual(DEFAULT_SETTINGS.ai.agents[0].claude ?? expect.anything());
    expect(agents()[0].claude).toBeDefined();
    expect(screen.getByLabelText("System prompt")).toBeInTheDocument();
  });

  it("keeps the typed command underneath, so switching back is not a blank input", async () => {
    const user = userEvent.setup();
    await expand(user, /no command/i);
    await user.type(screen.getByLabelText("Command"), "ollama run llama3.2");
    await user.click(screen.getByRole("button", { name: /Build this as a Claude agent/i }));
    await user.click(screen.getByRole("button", { name: /Use a raw command instead/i }));

    expect(agents()[0].claude).toBeUndefined();
    expect(agents()[0].commandTemplate).toBe("ollama run llama3.2");
  });

  it("says on its face that it discards the form", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    // Not in a tooltip: this is the one control here that throws away typing,
    // and §7.6 wants the consequence where the user is already looking.
    expect(screen.getByRole("button", { name: /discards this form/i })).toBeInTheDocument();
  });
});

describe("the roster cannot be emptied", () => {
  it("keeps the last remove button present and disabled, with the reason", () => {
    const remove = screen.getByRole("button", { name: /Remove .* from the roster/ });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAttribute("title", "A roster needs at least one agent");
  });

  it("enables it once there is a second agent", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add Claude agent" }));
    for (const remove of screen.getAllByRole("button", { name: /Remove .* from the roster/ })) {
      expect(remove).not.toHaveAttribute("aria-disabled", "true");
    }
  });
});
