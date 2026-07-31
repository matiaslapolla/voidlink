/// Fan-out, mounted.
///
/// The orchestration is proven in `store/fanout.test.ts`. What only a mounted
/// test reaches: that a leg nobody can act on offers no actions, that an
/// interrupted leg *says* it was interrupted rather than showing a spinner, and
/// that adopting is one explicit click that never appears twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { FanoutRun, RunLeg } from "@/store/fanout";

let runs: FanoutRun[] = [];
const startFanoutRun = vi.fn();
const adoptFanoutLeg = vi.fn();
const discardFanoutLeg = vi.fn();
const cancelFanoutLeg = vi.fn();
const removeFanoutRun = vi.fn();

vi.mock("@/store/fanout", async () => {
  // The pure helpers are the real ones: the ordering and the terminal-status
  // predicate are what decide which controls render, and mocking them would
  // test the mock.
  const real = await vi.importActual<typeof import("@/store/fanout")>("@/store/fanout");
  return {
    isLegDone: real.isLegDone,
    compareLegs: real.compareLegs,
    runProgress: real.runProgress,
    fanoutRuns: () => runs,
    startFanoutRun: (o: unknown) => startFanoutRun(o),
    adoptFanoutLeg: (...a: unknown[]) => adoptFanoutLeg(...a),
    discardFanoutLeg: (...a: unknown[]) => discardFanoutLeg(...a),
    cancelFanoutLeg: (id: unknown) => cancelFanoutLeg(id),
    removeFanoutRun: (...a: unknown[]) => removeFanoutRun(...a),
  };
});

vi.mock("@/store/settings", () => ({
  agentRoster: () => [
    { id: "a1", name: "Refactorer", commandTemplate: "claude -p" },
    { id: "a2", name: "Reviewer", commandTemplate: "codex exec" },
  ],
  resolveAgentCommand: (a: { commandTemplate: string }) => a.commandTemplate,
}));

import { RunsSection } from "./RunsSection";

const REPO = "/repos/api";

function leg(partial: Partial<RunLeg> = {}): RunLeg {
  return {
    id: "l1",
    agentId: "a1",
    agentName: "Refactorer",
    commandTemplate: "claude -p",
    worktreePath: "/repos/api-leg",
    branch: "fanout/x/refactorer",
    status: "finished",
    startedAt: 0,
    endedAt: 1,
    answer: "",
    error: null,
    stat: { files: 3, additions: 40, deletions: 5, paths: [] },
    ...partial,
  };
}

function run(partial: Partial<FanoutRun> = {}): FanoutRun {
  return {
    id: "r1",
    repo: REPO,
    prompt: "Add caching to the parser",
    createdAt: 0,
    legs: [leg()],
    adoptedLegId: null,
    ...partial,
  };
}

beforeEach(() => {
  runs = [];
  startFanoutRun.mockReset().mockResolvedValue("r1");
  adoptFanoutLeg.mockReset().mockResolvedValue({ ok: true });
  discardFanoutLeg.mockReset().mockResolvedValue({ ok: true });
  cancelFanoutLeg.mockReset().mockResolvedValue(undefined);
  removeFanoutRun.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("without a repository", () => {
  it("explains why it cannot run rather than showing a dead form", () => {
    render(() => <RunsSection />);
    expect(screen.getByText(/fan-out needs a repository/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fan out/i })).not.toBeInTheDocument();
  });
});

describe("launching", () => {
  it("will not launch with no prompt or no agent chosen", async () => {
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    const go = screen.getByRole("button", { name: /fan out/i });
    expect(go).toBeDisabled();

    await user.type(screen.getByRole("textbox", { name: /fan-out prompt/i }), "Add caching");
    expect(go).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Refactorer" }));
    expect(go).toBeEnabled();
  });

  it("sends one leg per chosen agent, with that agent's command", async () => {
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);

    await user.type(screen.getByRole("textbox", { name: /fan-out prompt/i }), "Add caching");
    await user.click(screen.getByRole("button", { name: "Refactorer" }));
    await user.click(screen.getByRole("button", { name: "Reviewer" }));
    await user.click(screen.getByRole("button", { name: /fan out/i }));

    expect(startFanoutRun).toHaveBeenCalledWith({
      repo: REPO,
      prompt: "Add caching",
      legs: [
        { agentId: "a1", agentName: "Refactorer", commandTemplate: "claude -p" },
        { agentId: "a2", agentName: "Reviewer", commandTemplate: "codex exec" },
      ],
    });
  });

  it("deselects an agent on a second click", async () => {
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    const agent = screen.getByRole("button", { name: "Refactorer" });
    await user.click(agent);
    expect(agent).toHaveAttribute("aria-pressed", "true");
    await user.click(agent);
    expect(agent).toHaveAttribute("aria-pressed", "false");
  });

  it("surfaces a launch failure instead of clearing the prompt", async () => {
    startFanoutRun.mockRejectedValue(new Error("no worktree space"));
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);

    const field = screen.getByRole("textbox", { name: /fan-out prompt/i });
    await user.type(field, "Add caching");
    await user.click(screen.getByRole("button", { name: "Refactorer" }));
    await user.click(screen.getByRole("button", { name: /fan out/i }));

    expect(await screen.findByText("no worktree space")).toBeInTheDocument();
    expect(field).toHaveValue("Add caching");
  });

  it("teaches what a fan-out is for when there are no runs", () => {
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.getByText(/a change you are unsure how to make/i)).toBeInTheDocument();
  });
});

describe("reading a run", () => {
  it("shows each leg's status, size and progress", () => {
    runs = [
      run({
        legs: [leg({ id: "a" }), leg({ id: "b", agentName: "Reviewer", status: "running", stat: null })],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);

    expect(screen.getByText("Add caching to the parser")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("finished")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.getByText("+40")).toBeInTheDocument();
  });

  /// Nobody chose it and nothing went wrong. Saying "failed" would send the
  /// user looking for an error that does not exist.
  it("says an interrupted leg was interrupted, in those words", () => {
    runs = [run({ legs: [leg({ status: "interrupted", stat: null })] })];
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.getByText(/interrupted when the window closed/i)).toBeInTheDocument();
  });

  /// Reporting a stat we failed to take as "0 files changed" would be the most
  /// misleading thing this surface could say.
  it("says a leg was not measured rather than showing zero", () => {
    runs = [run({ legs: [leg({ stat: null })] })];
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.getByText("not measured")).toBeInTheDocument();
  });

  it("shows a failed leg's reason", () => {
    runs = [run({ legs: [leg({ status: "failed", error: "CLI exited 1", stat: null })] })];
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.getByText("CLI exited 1")).toBeInTheDocument();
  });

  it("reads the biggest finished leg first", () => {
    runs = [
      run({
        legs: [
          leg({ id: "small", agentName: "Small", stat: { files: 1, additions: 2, deletions: 0, paths: [] } }),
          leg({ id: "big", agentName: "Big", stat: { files: 9, additions: 90, deletions: 1, paths: [] } }),
        ],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);
    const names = screen.getAllByTitle("fanout/x/refactorer").map((n) => n.textContent);
    expect(names).toEqual(["Big", "Small"]);
  });
});

describe("acting on a leg", () => {
  it("offers stop only while the leg could still change", () => {
    runs = [run({ legs: [leg({ status: "running", stat: null })] })];
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.getByRole("button", { name: "Stop Refactorer" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /adopt/i })).not.toBeInTheDocument();
  });

  it("stops one leg by its own id", async () => {
    runs = [run({ legs: [leg({ id: "leg-7", status: "running", stat: null })] })];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    await user.click(screen.getByRole("button", { name: "Stop Refactorer" }));
    expect(cancelFanoutLeg).toHaveBeenCalledWith("leg-7");
  });

  it("adopts one leg", async () => {
    runs = [run()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    await user.click(screen.getByRole("button", { name: /adopt refactorer/i }));
    expect(adoptFanoutLeg).toHaveBeenCalledWith(REPO, "r1", "l1");
  });

  /// A run can only be adopted once — merging two competing answers to one
  /// question on top of each other is painful to unpick.
  it("offers no adopt control once the run has been adopted", () => {
    runs = [
      run({
        adoptedLegId: "l1",
        legs: [leg({ id: "l1" }), leg({ id: "l2", agentName: "Reviewer" })],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);
    expect(screen.queryByRole("button", { name: /adopt/i })).not.toBeInTheDocument();
    expect(screen.getByText("adopted")).toBeInTheDocument();
  });

  it("reports a failed adoption rather than showing it as done", async () => {
    adoptFanoutLeg.mockResolvedValue({ ok: false, error: "conflict in src/a.rs" });
    runs = [run()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    await user.click(screen.getByRole("button", { name: /adopt refactorer/i }));
    expect(await screen.findByText("conflict in src/a.rs")).toBeInTheDocument();
  });

  /// Removing a losing worktree is an explicit act, never a side effect of
  /// picking a winner.
  it("removes a worktree only through its own control", async () => {
    runs = [run()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    await user.click(screen.getByRole("button", { name: /adopt refactorer/i }));
    expect(discardFanoutLeg).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /remove refactorer's worktree/i }));
    expect(discardFanoutLeg).toHaveBeenCalledWith(REPO, "r1", "l1");
  });

  it("offers to read a finished leg's diff", async () => {
    const onInspect = vi.fn();
    runs = [run()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} onInspect={onInspect} />);
    await user.click(screen.getByRole("button", { name: "Read" }));
    expect(onInspect).toHaveBeenCalledWith(expect.objectContaining({ id: "l1" }));
  });

  /// Forgetting the record must not be confusable with deleting the work.
  it("says forgetting a run leaves the worktrees alone", async () => {
    runs = [run()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);
    const forget = screen.getByRole("button", { name: /forget this run/i });
    expect(forget).toHaveAttribute("title", expect.stringMatching(/worktrees and branches stay/i));
    await user.click(forget);
    expect(removeFanoutRun).toHaveBeenCalledWith(REPO, "r1");
  });
});

/// Choosing between N branches is the half of fan-out that the mechanism does
/// not solve. `compareModel.test.ts` proves the comparison is right; these prove
/// the surface leads with the finding rather than the evidence, and that it
/// never presents a heuristic as a verdict.
describe("the comparison", () => {
  const compared = () =>
    run({
      legs: [
        leg({
          id: "l1",
          agentName: "Refactorer",
          branch: "fanout/x/refactorer",
          stat: { files: 2, additions: 40, deletions: 5, paths: ["src/parser.ts", "src/a.ts"] },
        }),
        leg({
          id: "l2",
          agentName: "Reviewer",
          worktreePath: "/repos/api-leg-2",
          branch: "fanout/x/reviewer",
          stat: { files: 2, additions: 90, deletions: 0, paths: ["src/parser.ts", "src/b.ts"] },
        }),
      ],
    });

  it("leads with what the legs agreed on", async () => {
    runs = [compared()];
    render(() => <RunsSection repoPath={REPO} />);
    expect(
      await screen.findByText(/1 file touched by every leg, 2 where they differ/i),
    ).toBeInTheDocument();
  });

  it("names the files where they diverge", async () => {
    runs = [compared()];
    render(() => <RunsSection repoPath={REPO} />);
    expect(await screen.findByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  /// The matrix is evidence. Opening with a grid of checkmarks would be showing
  /// the working before the answer.
  it("keeps the matrix collapsed until asked", async () => {
    runs = [compared()];
    const user = userEvent.setup();
    render(() => <RunsSection repoPath={REPO} />);

    const toggle = await screen.findByRole("button", { name: /show the file matrix/i });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByRole("table")).toBeInTheDocument();
    // `src/parser.ts` is in both legs, so it is a row with two ticks.
    expect(screen.getAllByLabelText("touched")).toHaveLength(4);
    expect(screen.getAllByLabelText("not touched")).toHaveLength(2);
  });

  /// Presenting a heuristic over line counts as a judgement about which answer
  /// is *correct* is the same lie as unmarked inferred attribution.
  it("labels the suggestion as a guess", async () => {
    runs = [compared()];
    render(() => <RunsSection repoPath={REPO} />);
    expect(await screen.findByText(/worth reading first/i)).toBeInTheDocument();
    expect(screen.getByText(/a guess from counts, not a verdict/i)).toBeInTheDocument();
  });

  /// A leg that silently vanishes from the comparison reads as one that was
  /// never started.
  it("says which legs are not in the comparison and why", async () => {
    runs = [
      run({
        legs: [
          leg({ id: "l1", stat: { files: 1, additions: 1, deletions: 0, paths: ["a.ts"] } }),
          leg({ id: "l2", agentName: "Reviewer", status: "failed", stat: null }),
        ],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);
    expect(await screen.findByText(/not in the comparison/i)).toBeInTheDocument();
    expect(screen.getByText(/Reviewer \(failed\)/)).toBeInTheDocument();
  });

  it("shows nothing to compare before any leg has a diff", async () => {
    runs = [run({ legs: [leg({ status: "running", stat: null })] })];
    render(() => <RunsSection repoPath={REPO} />);
    await screen.findByText(/working/i);
    expect(screen.queryByText(/file matrix/i)).not.toBeInTheDocument();
  });
});

/// Adopting leaves the other worktrees alone — deliberately, see the module
/// comment in `store/fanout.ts`. Leaving them alone *and saying nothing* is how
/// someone accumulates six abandoned worktrees and finds out from
/// `git worktree list` a month later.
describe("after an adopt", () => {
  it("says what is still on disk, and names it", async () => {
    runs = [
      run({
        adoptedLegId: "l1",
        legs: [
          leg({ id: "l1" }),
          leg({ id: "l2", agentName: "Reviewer", branch: "fanout/x/reviewer" }),
        ],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);
    expect(await screen.findByText(/1 other worktree and branch are still on disk/i)).toBeInTheDocument();
    expect(screen.getByText("fanout/x/reviewer")).toBeInTheDocument();
  });

  /// It has to be clear the app is not going to tidy up on its own — that is
  /// the whole point of saying anything.
  it("says nothing will be deleted for you", async () => {
    runs = [
      run({
        adoptedLegId: "l1",
        legs: [leg({ id: "l1" }), leg({ id: "l2", agentName: "Reviewer" })],
      }),
    ];
    render(() => <RunsSection repoPath={REPO} />);
    expect(
      await screen.findByText(/nothing here deletes an agent's work for you/i),
    ).toBeInTheDocument();
  });

  it("says nothing when there was only one leg", async () => {
    runs = [run({ adoptedLegId: "l1", legs: [leg({ id: "l1" })] })];
    render(() => <RunsSection repoPath={REPO} />);
    await screen.findByText("adopted");
    expect(screen.queryByText(/still on disk/i)).not.toBeInTheDocument();
  });
});
