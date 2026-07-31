/// Fan-out. The properties worth pinning down are the ones that make it
/// different from asking the same question three times:
///
///   1. Legs are independent — one failing to get a worktree must not stop the
///      others, because not knowing which approach works is the whole premise.
///   2. Every leg gets its own branch and its own directory, and two runs of
///      the same prompt do not collide.
///   3. Adopting merges one leg and touches nothing else.
///   4. A leg persisted mid-flight comes back as `interrupted`, never as a
///      spinner nothing will stop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.fn();
const addWorktree = vi.fn();
const removeWorktree = vi.fn();
const merge = vi.fn();
const diffWorking = vi.fn();
const diffRefs = vi.fn();
const streamQuery = vi.fn();
const cancelTurn = vi.fn();

vi.mock("@/store/journal", () => ({ record: (e: unknown) => record(e) }));
vi.mock("@/store/settings", () => ({ aiSecretBindings: () => [] }));
vi.mock("@/store/layout/persistence", () => ({
  STORAGE_KEYS: { fanoutRuns: "voidlink-fanout-runs" },
  readJson: <T,>(_k: string, fallback: T) => fallback,
  writeJson: () => {},
}));
vi.mock("@/api/git", () => ({
  gitApi: {
    addWorktree: (...a: unknown[]) => addWorktree(...a),
    removeWorktree: (...a: unknown[]) => removeWorktree(...a),
    merge: (...a: unknown[]) => merge(...a),
    diffWorking: (...a: unknown[]) => diffWorking(...a),
    diffRefs: (...a: unknown[]) => diffRefs(...a),
  },
}));
vi.mock("@/api/agent", () => ({
  agentApi: {
    streamQuery: (o: unknown) => streamQuery(o),
    cancelTurn: (id: unknown) => cancelTurn(id),
  },
}));

import {
  adoptFanoutLeg,
  compareLegs,
  discardFanoutLeg,
  fanoutRun,
  fanoutRuns,
  isLegDone,
  legBranchName,
  legWorktreePath,
  resetFanout,
  reviveRuns,
  runProgress,
  startFanoutRun,
  type RunLeg,
} from "./fanout";

const REPO = "/repos/api";

const LEGS = [
  { agentId: "a1", agentName: "Refactorer", commandTemplate: "claude -p" },
  { agentId: "a2", agentName: "Reviewer", commandTemplate: "codex exec" },
];

function emptyDiff() {
  return { files: [], totalAdditions: 0, totalDeletions: 0 };
}

beforeEach(() => {
  resetFanout();
  record.mockReset();
  addWorktree.mockReset().mockResolvedValue({});
  removeWorktree.mockReset().mockResolvedValue("");
  merge.mockReset().mockResolvedValue({ ok: true });
  diffWorking.mockReset().mockResolvedValue(emptyDiff());
  diffRefs.mockReset().mockResolvedValue(emptyDiff());
  streamQuery.mockReset().mockResolvedValue({ cancelled: false, exitCode: 0 });
  cancelTurn.mockReset().mockResolvedValue(undefined);
});

afterEach(() => resetFanout());

describe("naming", () => {
  /// A collision only shows up on the second run of the day, and only for the
  /// user whose agents share a name.
  it("gives two legs of one run different branches", () => {
    const a = legBranchName("Add caching", "run-aaaaaa", "Refactorer", 0);
    const b = legBranchName("Add caching", "run-aaaaaa", "Reviewer", 1);
    expect(a).not.toBe(b);
    expect(a.startsWith("fanout/add-caching-")).toBe(true);
  });

  it("gives two runs of the same prompt different branches", () => {
    expect(legBranchName("Add caching", "aaaaaa11", "R", 0)).not.toBe(
      legBranchName("Add caching", "bbbbbb22", "R", 0),
    );
  });

  it("falls back to a positional name when the agent name has no letters", () => {
    expect(legBranchName("Task", "abcdef", "***", 2)).toContain("/leg3");
  });

  it("survives a prompt with nothing sluggable in it", () => {
    expect(legBranchName("!!!", "abcdef", "R", 0)).toContain("fanout/run-abcdef/");
  });

  /// A worktree inside the repository is a worktree git then tries to track.
  it("puts a leg's worktree beside the repository, not inside it", () => {
    const path = legWorktreePath("/repos/api", "fanout/add-caching-abc123/refactorer");
    expect(path.startsWith("/repos/")).toBe(true);
    expect(path.startsWith("/repos/api/")).toBe(false);
  });

  it("ignores a trailing separator on the repository path", () => {
    expect(legWorktreePath("/repos/api/", "fanout/x/y")).toBe(legWorktreePath("/repos/api", "fanout/x/y"));
  });
});

describe("starting a run", () => {
  it("refuses an empty prompt or no legs", async () => {
    expect(await startFanoutRun({ repo: REPO, prompt: "  ", legs: LEGS })).toBeNull();
    expect(await startFanoutRun({ repo: REPO, prompt: "x", legs: [] })).toBeNull();
    expect(fanoutRuns(REPO)).toEqual([]);
  });

  it("creates a worktree and runs an agent per leg", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });

    expect(addWorktree).toHaveBeenCalledTimes(2);
    expect(streamQuery).toHaveBeenCalledTimes(2);
    const run = fanoutRun(REPO, id!)!;
    expect(run.legs.map((l) => l.status)).toEqual(["finished", "finished"]);
    expect(run.legs.map((l) => l.agentName)).toEqual(["Refactorer", "Reviewer"]);
  });

  /// Each leg runs in its own worktree, not in the repository.
  it("points each agent at its own worktree", async () => {
    await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    const paths = streamQuery.mock.calls.map((c) => c[0].repoPath);
    expect(new Set(paths).size).toBe(2);
    expect(paths).not.toContain(REPO);
  });

  /// The instruction to *make the change* is the difference between a fan-out
  /// and asking one question three times.
  it("tells each leg to change the files rather than describe the change", async () => {
    await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    expect(streamQuery.mock.calls[0][0].prompt).toMatch(/do not describe what you would do/i);
    expect(streamQuery.mock.calls[0][0].prompt).toContain("Add caching");
  });

  /// The premise is that you do not know which approach works, so one leg
  /// failing must not take the run with it.
  it("keeps the other legs running when one cannot get a worktree", async () => {
    addWorktree.mockRejectedValueOnce(new Error("already exists"));
    const id = await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });

    const run = fanoutRun(REPO, id!)!;
    const statuses = run.legs.map((l) => l.status).sort();
    expect(statuses).toEqual(["failed", "finished"]);
    expect(run.legs.find((l) => l.status === "failed")!.error).toMatch(/already exists/);
    expect(streamQuery).toHaveBeenCalledTimes(1);
  });

  it("records a failed agent turn as a failed leg without stopping the run", async () => {
    streamQuery.mockRejectedValueOnce(new Error("CLI exited 1"));
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    const run = fanoutRun(REPO, id!)!;
    expect(run.legs.map((l) => l.status).sort()).toEqual(["failed", "finished"]);
  });

  it("marks a cancelled turn cancelled rather than failed", async () => {
    streamQuery.mockResolvedValueOnce({ cancelled: true, exitCode: null });
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    const run = fanoutRun(REPO, id!)!;
    expect(run.legs.map((l) => l.status).sort()).toEqual(["cancelled", "finished"]);
  });

  it("keeps the partial answer of a leg that failed mid-stream", async () => {
    streamQuery.mockImplementationOnce(async (o: { onChunk?: (t: string) => void }) => {
      o.onChunk?.("half an answer");
      throw new Error("died");
    });
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    const failed = fanoutRun(REPO, id!)!.legs.find((l) => l.status === "failed")!;
    expect(failed.answer).toBe("half an answer");
  });

  it("records the run and every leg outcome to the log", async () => {
    await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    const kinds = record.mock.calls.map((c) => c[0].kind);
    expect(kinds[0]).toBe("run.started");
    expect(kinds.filter((k) => k === "run.leg.finished")).toHaveLength(2);
  });

  /// Reporting "0 files changed" for the leg that did the most work is the
  /// single most misleading thing this surface could do.
  it("measures a leg's work against the base ref when it committed", async () => {
    diffRefs.mockResolvedValue({
      files: [{ newPath: "a.rs", oldPath: "a.rs" }],
      totalAdditions: 10,
      totalDeletions: 2,
    });
    const id = await startFanoutRun({
      repo: REPO,
      prompt: "x",
      legs: [LEGS[0]],
      baseRef: "main",
    });
    expect(fanoutRun(REPO, id!)!.legs[0].stat).toEqual({
      files: 1,
      additions: 10,
      deletions: 2,
      // The paths, not just the count: the comparison matrix is files × legs,
      // and two legs reporting "1 file" mean different things depending on
      // whether it is the same file.
      paths: ["a.rs"],
    });
  });

  it("reports a stat it could not take as unmeasured rather than as zero", async () => {
    diffWorking.mockRejectedValue(new Error("no repo"));
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    expect(fanoutRun(REPO, id!)!.legs[0].stat).toBeNull();
  });
});

describe("adopting", () => {
  async function finishedRun() {
    const id = await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    return fanoutRun(REPO, id!)!;
  }

  it("merges the chosen leg's branch", async () => {
    const run = await finishedRun();
    const result = await adoptFanoutLeg(REPO, run.id, run.legs[0].id);

    expect(result.ok).toBe(true);
    expect(merge).toHaveBeenCalledWith(REPO, run.legs[0].branch, false);
    expect(fanoutRun(REPO, run.id)!.adoptedLegId).toBe(run.legs[0].id);
  });

  /// The losing branches are somebody's four minutes of work. Removing them as
  /// a side effect of picking a winner is not this module's decision to make.
  it("leaves the other legs' worktrees alone", async () => {
    const run = await finishedRun();
    await adoptFanoutLeg(REPO, run.id, run.legs[0].id);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  /// Two answers to one question merged on top of each other is painful to
  /// unpick and is not a state anybody asked for.
  it("refuses a second adoption", async () => {
    const run = await finishedRun();
    await adoptFanoutLeg(REPO, run.id, run.legs[0].id);
    const second = await adoptFanoutLeg(REPO, run.id, run.legs[1].id);

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already been adopted/i);
    expect(merge).toHaveBeenCalledTimes(1);
  });

  it("reports a merge failure instead of claiming the leg was adopted", async () => {
    merge.mockRejectedValue(new Error("conflict in src/a.rs"));
    const run = await finishedRun();
    const result = await adoptFanoutLeg(REPO, run.id, run.legs[0].id);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/conflict/);
    expect(fanoutRun(REPO, run.id)!.adoptedLegId).toBeNull();
  });

  it("records the adoption", async () => {
    const run = await finishedRun();
    record.mockReset();
    await adoptFanoutLeg(REPO, run.id, run.legs[0].id);
    expect(record.mock.calls[0][0]).toMatchObject({ kind: "run.adopted", repo: REPO });
  });

  it("discards a leg's worktree only when asked", async () => {
    const run = await finishedRun();
    const result = await discardFanoutLeg(REPO, run.id, run.legs[1].id);
    expect(result.ok).toBe(true);
    expect(removeWorktree).toHaveBeenCalledWith(REPO, run.legs[1].worktreePath, true);
  });
});

describe("cancelling", () => {
  it("stops one leg without touching the others", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    streamQuery.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );

    const pending = startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    await vi.waitFor(() => expect(streamQuery).toHaveBeenCalledTimes(2));

    const run = fanoutRuns(REPO)[0];
    const { cancelFanoutLeg } = await import("./fanout");
    await cancelFanoutLeg(run.legs[0].id);
    expect(cancelTurn).toHaveBeenCalledTimes(1);

    resolveFirst({ cancelled: true, exitCode: null });
    await pending;
    expect(fanoutRun(REPO, run.id)!.legs.map((l) => l.status).sort()).toEqual([
      "cancelled",
      "finished",
    ]);
  });

  it("is a no-op for a leg that already ended", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const { cancelFanoutLeg } = await import("./fanout");
    await cancelFanoutLeg(fanoutRun(REPO, id!)!.legs[0].id);
    expect(cancelTurn).not.toHaveBeenCalled();
  });
});

describe("reading a run", () => {
  function leg(partial: Partial<RunLeg>): RunLeg {
    return {
      id: "l",
      agentId: "a",
      agentName: "A",
      commandTemplate: "",
      worktreePath: "/w",
      branch: "b",
      status: "finished",
      startedAt: null,
      endedAt: null,
      answer: "",
      error: null,
      stat: null,
      ...partial,
    };
  }

  it("knows which statuses are terminal", () => {
    expect(isLegDone("running")).toBe(false);
    expect(isLegDone("preparing")).toBe(false);
    expect(isLegDone("interrupted")).toBe(true);
    expect(isLegDone("finished")).toBe(true);
  });

  it("counts progress across the legs", () => {
    const run = {
      id: "r",
      repo: REPO,
      prompt: "",
      createdAt: 0,
      adoptedLegId: null,
      legs: [
        leg({ id: "1", status: "finished" }),
        leg({ id: "2", status: "failed" }),
        leg({ id: "3", status: "running" }),
      ],
    };
    expect(runProgress(run)).toEqual({
      total: 3,
      done: 2,
      running: 1,
      failed: 1,
      active: true,
    });
  });

  it("reads the finished legs first, largest change first", () => {
    const sorted = [
      leg({ id: "small", agentName: "S", stat: { files: 1, additions: 2, deletions: 0, paths: [] } }),
      leg({ id: "running", agentName: "R", status: "running" }),
      leg({ id: "big", agentName: "B", stat: { files: 9, additions: 90, deletions: 5, paths: [] } }),
      leg({ id: "failed", agentName: "F", status: "failed" }),
    ].sort(compareLegs);
    expect(sorted.map((l) => l.id)).toEqual(["big", "small", "running", "failed"]);
  });

  it("puts an unmeasured leg below a measured one", () => {
    const sorted = [
      leg({ id: "none", agentName: "N", stat: null }),
      leg({ id: "some", agentName: "S", stat: { files: 1, additions: 0, deletions: 0, paths: [] } }),
    ].sort(compareLegs);
    expect(sorted.map((l) => l.id)).toEqual(["some", "none"]);
  });
});

describe("reviveRuns", () => {
  /// The load-bearing repair. A leg persisted mid-flight has no process behind
  /// it any more, and coming back as `running` would be a spinner nothing will
  /// ever stop.
  it("marks a leg that was in flight as interrupted", () => {
    const revived = reviveRuns({
      [REPO]: [
        {
          id: "r",
          prompt: "x",
          legs: [
            { id: "a", worktreePath: "/w", status: "running" },
            { id: "b", worktreePath: "/w2", status: "preparing" },
            { id: "c", worktreePath: "/w3", status: "finished" },
          ],
        },
      ],
    });
    expect(revived[REPO][0].legs.map((l) => l.status)).toEqual([
      "interrupted",
      "interrupted",
      "finished",
    ]);
  });

  it("drops a run with no legs, which cannot be read or adopted", () => {
    const revived = reviveRuns({ [REPO]: [{ id: "r", prompt: "x", legs: [] }] });
    expect(revived).toEqual({});
  });

  it("drops a leg with no worktree and keeps its siblings", () => {
    const revived = reviveRuns({
      [REPO]: [{ id: "r", legs: [{ id: "a" }, { id: "b", worktreePath: "/w" }] }],
    });
    expect(revived[REPO][0].legs.map((l) => l.id)).toEqual(["b"]);
  });

  it("survives a blob that is not the shape it expects", () => {
    expect(reviveRuns(null)).toEqual({});
    expect(reviveRuns({ [REPO]: "nope" })).toEqual({});
  });
});
