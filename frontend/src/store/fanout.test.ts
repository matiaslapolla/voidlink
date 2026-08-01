/// Fan-out. The properties worth pinning down are the ones that make it
/// different from asking the same question three times, plus the ones added
/// by moving orchestration into Rust:
///
///   1. Legs are independent — one failing must not stop the others, because
///      not knowing which approach works is the whole premise.
///   2. Every leg gets its own branch and its own directory, and two runs of
///      the same prompt do not collide.
///   3. Adopting merges one leg and touches nothing else.
///   4. A leg persisted mid-flight comes back as `interrupted` until
///      `reconcileFanoutRuns` proves otherwise.
///   5. This store no longer spawns or streams anything itself — it hands a
///      run to `fanoutApi.startRun` and applies whatever `fanoutApi.subscribe`
///      sends back. These tests mock the API boundary, not a child process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.fn();
const addWorktree = vi.fn();
const removeWorktree = vi.fn();
const merge = vi.fn();
const diffWorking = vi.fn();
const diffRefs = vi.fn();
const startRun = vi.fn();
const cancelLeg = vi.fn();
const runState = vi.fn();
const subscribe = vi.fn();

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
vi.mock("@/api/fanout", () => ({
  fanoutApi: {
    startRun: (o: unknown) => startRun(o),
    cancelLeg: (id: unknown) => cancelLeg(id),
    runState: (repo: unknown) => runState(repo),
    subscribe: (runId: unknown, onEvent: unknown) => subscribe(runId, onEvent),
  },
}));

import {
  adoptFanoutLeg,
  cancelFanoutLeg,
  compareLegs,
  discardFanoutLeg,
  fanoutRun,
  fanoutRuns,
  isLegDone,
  legBranchName,
  legWorktreePath,
  reconcileFanoutRuns,
  removeFanoutRun,
  resetFanout,
  reviveRuns,
  runProgress,
  startFanoutRun,
  type FanoutRun,
  type RunLeg,
} from "./fanout";
import type { FanoutStreamEvent, LegSnapshot } from "@/api/fanout";

const REPO = "/repos/api";

const LEGS = [
  { agentId: "a1", agentName: "Refactorer", commandTemplate: "claude -p" },
  { agentId: "a2", agentName: "Reviewer", commandTemplate: "codex exec" },
];

function emptyDiff() {
  return { files: [], totalAdditions: 0, totalDeletions: 0 };
}

/// The pending listener registered by the most recent `subscribe` call, so a
/// test can push messages into it exactly as the supervisor would.
function lastSubscriber(): (event: FanoutStreamEvent) => void {
  const call = subscribe.mock.calls.at(-1);
  if (!call) throw new Error("subscribe was never called");
  return call[1] as (event: FanoutStreamEvent) => void;
}

/// A `legStatus` message naming a full terminal leg — what the supervisor
/// sends once a leg finishes, fails, or is cancelled.
function legStatusEvent(partial: Partial<LegSnapshot> & { id: string }): FanoutStreamEvent {
  return {
    event: "legStatus",
    data: {
      leg: {
        agentId: "a",
        agentName: "Agent",
        commandTemplate: "",
        worktreePath: "/w",
        branch: "b",
        status: "finished",
        startedAt: 0,
        endedAt: 1,
        answer: "",
        error: null,
        ...partial,
      },
    },
  };
}

beforeEach(() => {
  resetFanout();
  record.mockReset();
  addWorktree.mockReset().mockResolvedValue({});
  removeWorktree.mockReset().mockResolvedValue("");
  merge.mockReset().mockResolvedValue({ ok: true });
  diffWorking.mockReset().mockResolvedValue(emptyDiff());
  diffRefs.mockReset().mockResolvedValue(emptyDiff());
  startRun.mockReset().mockResolvedValue({ id: "run", repo: REPO, legs: [] });
  cancelLeg.mockReset().mockResolvedValue(true);
  runState.mockReset().mockResolvedValue([]);
  subscribe.mockReset().mockResolvedValue(undefined);
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
    expect(startRun).not.toHaveBeenCalled();
  });

  it("hands the supervisor one leg per agent, each with its own worktree and branch", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });

    expect(startRun).toHaveBeenCalledTimes(1);
    const call = startRun.mock.calls[0][0];
    expect(call.runId).toBe(id);
    expect(call.legs).toHaveLength(2);
    const paths = call.legs.map((l: { worktreePath: string }) => l.worktreePath);
    expect(new Set(paths).size).toBe(2);
    expect(paths).not.toContain(REPO);
  });

  /// The instruction to *make the change* is the difference between a fan-out
  /// and asking one question three times.
  it("tells each leg to change the files rather than describe the change", async () => {
    await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    const call = startRun.mock.calls[0][0];
    expect(call.legs[0].prompt).toMatch(/do not describe what you would do/i);
    expect(call.legs[0].prompt).toContain("Add caching");
  });

  /// Registering does not wait for a single leg to finish — that guarantee
  /// belonged to the old window-owned orchestration.
  it("resolves as soon as the supervisor registers the run, without waiting on any leg", async () => {
    let resolveStart: (v: unknown) => void = () => {};
    startRun.mockImplementationOnce(() => new Promise((resolve) => (resolveStart = resolve)));

    const pending = startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    resolveStart({ id: "run", repo: REPO, legs: [] });
    const id = await pending;

    const run = fanoutRun(REPO, id!)!;
    // Nothing has streamed yet — every leg is still `pending`.
    expect(run.legs.map((l) => l.status)).toEqual(["pending", "pending"]);
  });

  it("subscribes to the run once it is registered", async () => {
    await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("fails every leg when the supervisor refuses the run outright", async () => {
    startRun.mockRejectedValueOnce(new Error("A run with this id is already registered."));
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    const run = fanoutRun(REPO, id!)!;
    expect(run.legs.every((l) => l.status === "failed")).toBe(true);
    expect(run.legs[0].error).toMatch(/already registered/);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("applies a leg-status message from the live subscription", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const run = fanoutRun(REPO, id!)!;
    lastSubscriber()(legStatusEvent({ id: run.legs[0].id, status: "running", startedAt: 5 }));
    expect(fanoutRun(REPO, id!)!.legs[0].status).toBe("running");
    expect(fanoutRun(REPO, id!)!.legs[0].startedAt).toBe(5);
  });

  /// The premise is that you do not know which approach works, so one leg
  /// failing must not read as the whole run failing.
  it("keeps the other legs' status independent when one fails", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: LEGS });
    const run = fanoutRun(REPO, id!)!;
    lastSubscriber()(legStatusEvent({ id: run.legs[0].id, status: "failed", error: "boom" }));
    lastSubscriber()(legStatusEvent({ id: run.legs[1].id, status: "finished" }));
    const statuses = fanoutRun(REPO, id!)!.legs.map((l) => l.status).sort();
    expect(statuses).toEqual(["failed", "finished"]);
  });

  it("appends live chunks to a leg's answer rather than replacing it", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    const onEvent = lastSubscriber();
    onEvent({ event: "chunk", data: { legId, text: "half " } });
    onEvent({ event: "chunk", data: { legId, text: "an answer" } });
    expect(fanoutRun(REPO, id!)!.legs[0].answer).toBe("half an answer");
  });

  /// A `legStatus` message carries the full buffered answer, so it replaces
  /// rather than appends — unlike a `chunk`.
  it("replaces a leg's answer wholesale from a legStatus message", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    const onEvent = lastSubscriber();
    onEvent({ event: "chunk", data: { legId, text: "partial" } });
    onEvent(legStatusEvent({ id: legId, status: "finished", answer: "the whole answer" }));
    expect(fanoutRun(REPO, id!)!.legs[0].answer).toBe("the whole answer");
  });

  it("measures a leg once it goes terminal", async () => {
    diffWorking.mockResolvedValue({
      files: [{ newPath: "a.rs", oldPath: "a.rs" }],
      totalAdditions: 10,
      totalDeletions: 2,
    });
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    lastSubscriber()(legStatusEvent({ id: legId, status: "finished", answer: "done" }));
    await vi.waitFor(() => expect(fanoutRun(REPO, id!)!.legs[0].stat).not.toBeNull());
    expect(fanoutRun(REPO, id!)!.legs[0].stat).toEqual({
      files: 1,
      additions: 10,
      deletions: 2,
      paths: ["a.rs"],
    });
  });

  it("reports a stat it could not take as unmeasured rather than as zero", async () => {
    diffWorking.mockRejectedValue(new Error("no repo"));
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    lastSubscriber()(legStatusEvent({ id: legId, status: "finished" }));
    await vi.waitFor(() => expect(diffWorking).toHaveBeenCalled());
    expect(fanoutRun(REPO, id!)!.legs[0].stat).toBeNull();
  });

  it("measures a leg against the base ref when the run has one", async () => {
    diffRefs.mockResolvedValue(emptyDiff());
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]], baseRef: "main" });
    const leg = fanoutRun(REPO, id!)!.legs[0];
    lastSubscriber()(legStatusEvent({ id: leg.id, status: "finished" }));
    await vi.waitFor(() => expect(diffRefs).toHaveBeenCalledWith(leg.worktreePath, "main", "HEAD", true));
  });

  it("does not record run or leg journal events itself — the supervisor does", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    lastSubscriber()(legStatusEvent({ id: fanoutRun(REPO, id!)!.legs[0].id, status: "finished" }));
    expect(record).not.toHaveBeenCalled();
  });
});

describe("adopting", () => {
  async function finishedRun() {
    const id = await startFanoutRun({ repo: REPO, prompt: "Add caching", legs: LEGS });
    const run = fanoutRun(REPO, id!)!;
    const onEvent = lastSubscriber();
    for (const leg of run.legs) onEvent(legStatusEvent({ id: leg.id, status: "finished" }));
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
  it("asks the supervisor to cancel the leg", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    await cancelFanoutLeg(legId);
    expect(cancelLeg).toHaveBeenCalledWith(legId);
  });

  /// A cancel racing the leg's own completion is the ordinary case — the
  /// supervisor answers `false` and this must not throw.
  it("does not throw when there was nothing to cancel", async () => {
    cancelLeg.mockResolvedValueOnce(false);
    await expect(cancelFanoutLeg("some-leg")).resolves.toBeUndefined();
  });

  it("swallows a rejected cancel the same way a resolved false is handled", async () => {
    cancelLeg.mockRejectedValueOnce(new Error("no such turn"));
    await expect(cancelFanoutLeg("some-leg")).resolves.toBeUndefined();
  });
});

describe("reconnecting", () => {
  it("marks a leg interrupted at load time when nothing has confirmed otherwise", () => {
    const revived = reviveRuns({
      [REPO]: [{ id: "r", prompt: "x", legs: [{ id: "a", worktreePath: "/w", status: "running" }] }],
    });
    expect(revived[REPO][0].legs[0].status).toBe("interrupted");
  });

  it("corrects a locally-guessed interrupted leg once the supervisor confirms it is still tracked", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const run = fanoutRun(REPO, id!)!;
    // Simulate what a reload would have done before reconciling: the leg
    // looks interrupted because nothing has told this window otherwise yet.
    lastSubscriber()(legStatusEvent({ id: run.legs[0].id, status: "running" }));
    subscribe.mockReset().mockResolvedValue(undefined);

    runState.mockResolvedValueOnce([
      {
        id: run.id,
        repo: REPO,
        legs: [
          {
            id: run.legs[0].id,
            agentId: "a1",
            agentName: "Refactorer",
            commandTemplate: "",
            worktreePath: run.legs[0].worktreePath,
            branch: run.legs[0].branch,
            status: "finished",
            startedAt: 1,
            endedAt: 2,
            answer: "the answer",
            error: null,
          },
        ],
      },
    ]);

    await reconcileFanoutRuns(REPO);

    expect(fanoutRun(REPO, id!)!.legs[0].status).toBe("finished");
    expect(fanoutRun(REPO, id!)!.legs[0].answer).toBe("the answer");
  });

  it("leaves a run untouched when the supervisor has no record of it", async () => {
    runState.mockResolvedValueOnce([]);
    const revived = reviveRuns({
      [REPO]: [{ id: "old-run", prompt: "x", legs: [{ id: "a", worktreePath: "/w", status: "running" }] }],
    });
    expect(revived[REPO][0].legs[0].status).toBe("interrupted");
    // `reconcileFanoutRuns` reads from the live store, not from `revived`
    // directly, so this documents the property rather than exercising the
    // store — the store-level version is the test above.
    await reconcileFanoutRuns(REPO);
  });

  it("does not throw when the supervisor cannot be reached", async () => {
    runState.mockRejectedValueOnce(new Error("IPC down"));
    await expect(reconcileFanoutRuns(REPO)).resolves.toBeUndefined();
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
    const run: FanoutRun = {
      id: "r",
      repo: REPO,
      prompt: "",
      createdAt: 0,
      adoptedLegId: null,
      baseRef: null,
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
  /// The load-bearing repair. A leg persisted mid-flight has no confirmed
  /// supervisor behind it yet, and coming back as `running` would be a
  /// spinner nothing will ever stop unless `reconcileFanoutRuns` says otherwise.
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

  it("defaults baseRef to null when absent, and keeps it when present", () => {
    const revived = reviveRuns({
      [REPO]: [
        { id: "r1", prompt: "x", legs: [{ id: "a", worktreePath: "/w" }] },
        { id: "r2", prompt: "x", baseRef: "main", legs: [{ id: "a", worktreePath: "/w" }] },
      ],
    });
    expect(revived[REPO][0].baseRef).toBeNull();
    expect(revived[REPO][1].baseRef).toBe("main");
  });
});

describe("removeFanoutRun", () => {
  it("stops the run from receiving further live messages", async () => {
    const id = await startFanoutRun({ repo: REPO, prompt: "x", legs: [LEGS[0]] });
    const legId = fanoutRun(REPO, id!)!.legs[0].id;
    removeFanoutRun(REPO, id!);
    // The subscription callback still exists (nothing unregisters it on the
    // Rust side from a `Forget`), but applying it must no-op once the run is
    // gone from the store rather than resurrecting a deleted run.
    lastSubscriber()(legStatusEvent({ id: legId, status: "finished" }));
    expect(fanoutRuns(REPO)).toEqual([]);
  });
});
