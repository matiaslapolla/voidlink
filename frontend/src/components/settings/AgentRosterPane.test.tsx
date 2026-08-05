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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, useSettings } from "@/store/settings";
import { DEFAULT_CLAUDE_SPEC } from "@/store/claudeAgent";

/// The Test button spawns a real CLI through Tauri, so the one thing every
/// mounted test needs is for that not to happen. See the hand-rolled double in
/// `agentProbe.test.ts` for why this is not `vi.fn()`.
const probeCalls: unknown[][] = [];
let probeAnswer: () => Promise<string> = () => Promise.resolve("ok");
vi.mock("@/api/git", () => ({
  gitApi: {
    agentQuery: (...args: unknown[]) => {
      probeCalls.push(args);
      return probeAnswer();
    },
  },
}));

import { AgentRosterSection } from "./AgentRosterPane";

const agents = () => useSettings().settings.ai.agents;

beforeEach(() => {
  probeCalls.length = 0;
  probeAnswer = () => Promise.resolve("ok");
  // The store is a module singleton, so each test starts from the shipped
  // one-entry roster rather than from whatever the last one built.
  useSettings().updateAi({ agents: structuredClone(DEFAULT_SETTINGS.ai.agents) });
  render(() => <AgentRosterSection repoPath="/repo" />);
});

/// The BYO-CLI command agent is hidden from this pane and still present in the
/// store. Both halves need asserting, because each without the other is a
/// different bug: showing it is the regression, and *dropping* it would
/// silently unconfigure every roster written before this pane existed — which
/// is all of them, including the shipped default.
describe("the hidden command agent", () => {
  it("still ships, and still has no spec", () => {
    expect(agents()).toHaveLength(1);
    expect(agents()[0].claude).toBeUndefined();
  });

  it("renders no row, so the pane starts on its empty state", () => {
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
  });

  it("offers no way to make another one", () => {
    expect(screen.queryByRole("button", { name: /command agent/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /raw command/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Add agent" })).toBeInTheDocument();
  });

  it("survives adding and removing a Claude agent beside it", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.click(screen.getByRole("button", { name: /Remove .* from the roster/ }));

    // Back to one entry, and it is the one that was never on screen.
    expect(agents()).toHaveLength(1);
    expect(agents()[0].claude).toBeUndefined();
    expect(screen.getByText(/No agents yet/i)).toBeInTheDocument();
  });
});

describe("adding an agent", () => {
  it("adds it already built, so the form has something to show", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));

    expect(agents()).toHaveLength(2);
    expect(agents()[1].claude).toBeDefined();
    // And it opens expanded — a row added by a button that then shows nothing
    // is a button that appears not to have worked.
    expect(screen.getByLabelText("System prompt")).toBeInTheDocument();
  });

  it("gives consecutive agents different colours without asking", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    const colors = agents().filter((a) => a.claude).map((a) => a.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("the Claude form writes through to the spec", () => {
  it("patches one field without blanking the rest", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));

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
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    await user.type(screen.getByLabelText("System prompt"), "don't guess");

    // This line is the only way a user can check the quoting the form exists to
    // spare them from writing — so it has to be the real composition, not a
    // summary of it.
    expect(screen.getByLabelText("Command this agent runs")).toHaveValue(
      `claude --name 'Claude agent' --append-system-prompt 'don'\\''t guess'`,
    );
  });

  it("warns that replacing the system prompt is not a stronger version of adding to it", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    expect(screen.getByText(/keeps everything it knows/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace Claude's" }));
    expect(screen.getByText(/no longer be told about its tools/i)).toBeInTheDocument();
  });
});

/// Editing the composed command is the escape hatch for the case the form
/// cannot fix itself: flags that are right for the CLI they were read off and
/// wrong for the one on this machine's PATH. What has to hold is that taking
/// the hatch is reversible and never silent.
describe("editing the command", () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    return screen.getByLabelText("Command this agent runs");
  };

  it("tracks the form until the moment it is edited", async () => {
    const user = userEvent.setup();
    const box = await openForm(user);
    expect(box).toHaveValue("claude --name 'Claude agent'");

    await user.type(screen.getByLabelText("Agent name"), "!");
    expect(box).toHaveValue("claude --name 'Claude agent!'");
  });

  it("runs what was typed, verbatim, once it is edited", async () => {
    const user = userEvent.setup();
    const box = await openForm(user);
    await user.clear(box);
    await user.type(box, "claude --model sonnet");

    expect(agents()[1].claude!.commandOverride).toBe("claude --model sonnet");
    // And the fields it no longer derives from are visibly inert rather than
    // quietly ignored.
    expect(screen.getByText(/fields above no longer affect it/i)).toBeInTheDocument();
  });

  it("stops tracking the form, which is the whole point of an override", async () => {
    const user = userEvent.setup();
    const box = await openForm(user);
    await user.clear(box);
    await user.type(box, "claude --model sonnet");
    await user.type(screen.getByLabelText("Agent name"), "!");

    expect(box).toHaveValue("claude --model sonnet");
  });

  it("gives the composed command back intact — it is a hatch, not a door", async () => {
    const user = userEvent.setup();
    const box = await openForm(user);
    await user.type(screen.getByLabelText("System prompt"), "Be terse.");
    await user.clear(box);
    await user.type(box, "whatever");
    await user.click(screen.getByRole("button", { name: /Reset to the form/ }));

    expect(box).toHaveValue("claude --name 'Claude agent' --append-system-prompt 'Be terse.'");
    expect(agents()[1].claude!.systemPrompt).toBe("Be terse.");
  });

  it("tests the edited command rather than the one it replaced", async () => {
    const user = userEvent.setup();
    const box = await openForm(user);
    await user.clear(box);
    await user.type(box, "my-cli --flag");
    await user.click(screen.getByRole("button", { name: /Test agent/ }));

    // `-p` and nothing else: an override may not even be `claude`, so layering
    // our flags onto it would fail the test for a reason we invented.
    expect((probeCalls[0] as string[])[1]).toBe("my-cli --flag -p");
  });
});

/// The Test button is the only thing in this dialog that makes a claim about
/// the outside world, so the properties worth mounting for are the ones that
/// would let it make a *false* one: testing a command other than the configured
/// agent, and keeping a green tick after the configuration changed.
describe("testing an agent", () => {
  const addAgent = async (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: "Add agent" }));

  it("probes the agent the user is looking at, flags and all", async () => {
    const user = userEvent.setup();
    await addAgent(user);
    await user.type(screen.getByLabelText("System prompt"), "Be terse.");
    await user.click(screen.getByRole("button", { name: /Test agent/ }));

    expect(probeCalls).toHaveLength(1);
    const [repoPath, command] = probeCalls[0] as string[];
    expect(repoPath).toBe("/repo");
    // -p, because a probe has to terminate; no tools, because a test button
    // may not edit the repository; and the field that was just typed.
    expect(command).toContain("-p");
    expect(command).toContain("--tools ''");
    expect(command).toContain("--append-system-prompt 'Be terse.'");
    expect(await screen.findByText(/Works — replied in/)).toBeInTheDocument();
  });

  it("says what went wrong in terms of the fix, not the exit code", async () => {
    const user = userEvent.setup();
    probeAnswer = () =>
      Promise.reject(new Error("failed to spawn `claude`: No such file (os error 2)"));
    await addAgent(user);
    await user.click(screen.getByRole("button", { name: /Test agent/ }));

    expect(await screen.findByText(/isn't on this app's PATH/)).toBeInTheDocument();
  });

  it("stops vouching for a result once the form has moved on", async () => {
    const user = userEvent.setup();
    await addAgent(user);
    await user.click(screen.getByRole("button", { name: /Test agent/ }));
    expect(await screen.findByText(/Works — replied in/)).toBeInTheDocument();

    // One keystroke later the tick describes a command that no longer exists.
    await user.type(screen.getByLabelText("System prompt"), "x");
    expect(screen.queryByText(/Works — replied in/)).toBeNull();
    expect(screen.getByText(/Passed before your last edit/)).toBeInTheDocument();
  });

  it("does not offer to probe with no repository open", async () => {
    const user = userEvent.setup();
    render(() => <AgentRosterSection repoPath={null} />);
    // Two sections are mounted now; the second one is the repo-less one.
    await user.click(screen.getAllByRole("button", { name: "Add agent" })[1]);
    const buttons = screen.getAllByRole("button", { name: /Test agent/ });
    expect(buttons[buttons.length - 1]).toBeDisabled();
    expect(probeCalls).toHaveLength(0);
  });
});

/// The guard counts every entry, hidden ones included, so it fires on the store
/// rather than on what is drawn. With the shipped command agent present it
/// therefore *should not* fire at one visible row — which is the case that
/// would otherwise leave a user unable to delete an agent for a reason they
/// cannot see.
describe("the roster cannot be emptied", () => {
  it("lets the only visible row go, because a hidden entry still holds the floor", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add agent" }));
    const remove = screen.getByRole("button", { name: /Remove .* from the roster/ });
    expect(remove).not.toHaveAttribute("aria-disabled", "true");
  });

  it("refuses when that row is genuinely the last entry there is", async () => {
    const user = userEvent.setup();
    // No hidden command agent this time: the roster is exactly one Claude
    // agent, and removing it would leave every bound agent tab pointing at
    // nothing.
    useSettings().updateAi({
      agents: [
        {
          id: "only",
          name: "Solo",
          commandTemplate: "",
          color: "chart-1",
          claude: { ...DEFAULT_CLAUDE_SPEC },
        },
      ],
    });
    await Promise.resolve();
    const remove = screen.getByRole("button", { name: /Remove .* from the roster/ });
    expect(remove).toHaveAttribute("aria-disabled", "true");
    expect(remove).toHaveAttribute("title", "A roster needs at least one agent");
    await user.click(remove);
    expect(agents()).toHaveLength(1);
  });
});
