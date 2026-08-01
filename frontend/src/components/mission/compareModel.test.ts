/// The fan-out comparison, which is the part of that feature most likely to be
/// quietly wrong — and the part where being quietly wrong costs the most, since
/// the whole point is helping someone choose which branch to merge.
import { describe, expect, it } from "vitest";
import type { FanoutRun, LegStat, LegStatus, RunLeg } from "@/store/fanout";
import {
  comparisonSummary,
  compareRun,
  consensusPaths,
  suggestedLeg,
} from "./compareModel";

let n = 0;

function leg(
  agentName: string,
  status: LegStatus,
  stat: Partial<LegStat> | null,
): RunLeg {
  n += 1;
  return {
    id: `leg-${n}`,
    agentId: `agent-${n}`,
    agentName,
    commandTemplate: "cli",
    worktreePath: `/wt/${agentName}`,
    branch: `fanout/${agentName}`,
    status,
    startedAt: 0,
    endedAt: 1,
    answer: "",
    error: null,
    stat: stat
      ? { files: stat.paths?.length ?? 0, additions: 0, deletions: 0, paths: [], ...stat }
      : null,
  };
}

function run(legs: RunLeg[]): FanoutRun {
  return {
    id: "run-1",
    repo: "/repo",
    prompt: "Extract the parser",
    createdAt: 0,
    legs,
    adoptedLegId: null,
    baseRef: null,
  };
}

describe("columns", () => {
  it("makes a column per measured leg", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["src/a.ts"] }),
        leg("B", "finished", { paths: ["src/b.ts"] }),
      ]),
    );
    expect(c.columns.map((x) => x.agentName)).toEqual(["A", "B"]);
    expect(c.comparable).toBe(true);
  });

  /// A failed leg has nothing to compare, and a column of blanks reads as "this
  /// agent chose to change nothing" — which is a different and much more
  /// misleading claim.
  it("does not give a failed leg a column, and says what happened to it", () => {
    const c = compareRun(
      run([leg("A", "finished", { paths: ["src/a.ts"] }), leg("B", "failed", null)]),
    );
    expect(c.columns).toHaveLength(1);
    expect(c.unmeasured).toEqual([
      { legId: expect.any(String), agentName: "B", status: "failed" },
    ]);
  });

  /// A verdict on work still in flight is a verdict that will be wrong in
  /// thirty seconds.
  it("lists a running leg as neither measured nor unmeasured", () => {
    const c = compareRun(
      run([leg("A", "finished", { paths: ["src/a.ts"] }), leg("B", "running", null)]),
    );
    expect(c.columns).toHaveLength(1);
    expect(c.unmeasured).toHaveLength(0);
  });

  /// "It ran and changed nothing" and "we could not measure it" are different
  /// answers, and only one of them is a problem.
  it("keeps a zero-file measurement as a column", () => {
    const c = compareRun(
      run([leg("A", "finished", { paths: [] }), leg("B", "finished", { paths: ["src/b.ts"] })]),
    );
    expect(c.columns).toHaveLength(2);
    expect(c.columns[0].files).toBe(0);
  });
});

describe("rows", () => {
  it("unions the files across legs", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["src/a.ts", "src/shared.ts"] }),
        leg("B", "finished", { paths: ["src/b.ts", "src/shared.ts"] }),
      ]),
    );
    expect(c.rows.map((r) => r.path).sort()).toEqual(["src/a.ts", "src/b.ts", "src/shared.ts"]);
  });

  it("marks a file every measured leg touched as shared", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["src/shared.ts"] }),
        leg("B", "finished", { paths: ["src/shared.ts"] }),
      ]),
    );
    expect(c.rows[0].shared).toBe(true);
    expect(c.sharedCount).toBe(1);
  });

  /// Highlighting the whole diff of the only leg would mean nothing, and the
  /// word "shared" would be actively misleading.
  it("marks nothing shared when only one leg was measured", () => {
    const c = compareRun(
      run([leg("A", "finished", { paths: ["src/a.ts"] }), leg("B", "failed", null)]),
    );
    expect(c.sharedCount).toBe(0);
    expect(c.comparable).toBe(false);
  });

  /// A failed leg must not make the surviving legs' common files stop counting
  /// as agreement — "every leg" means every leg that produced something.
  it("counts agreement across measured legs only", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["src/shared.ts"] }),
        leg("B", "finished", { paths: ["src/shared.ts"] }),
        leg("C", "failed", null),
      ]),
    );
    expect(c.sharedCount).toBe(1);
  });

  it("orders agreement first, then by how many legs touched it, then by path", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["z.ts", "two.ts", "all.ts"] }),
        leg("B", "finished", { paths: ["two.ts", "all.ts"] }),
        leg("C", "finished", { paths: ["a.ts", "all.ts"] }),
      ]),
    );
    expect(c.rows.map((r) => r.path)).toEqual(["all.ts", "two.ts", "a.ts", "z.ts"]);
  });

  it("reports each leg's unique files", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["only-a.ts", "shared.ts"] }),
        leg("B", "finished", { paths: ["shared.ts"] }),
      ]),
    );
    expect(c.columns[0].uniquePaths).toEqual(["only-a.ts"]);
    expect(c.columns[1].uniquePaths).toEqual([]);
  });
});

describe("the suggestion", () => {
  /// Smallest *among those that covered the agreed files* — not smallest
  /// outright, which would reward a leg that did less of the job.
  it("prefers the smallest diff that still touches every agreed file", () => {
    const c = compareRun(
      run([
        leg("Thorough", "finished", {
          paths: ["shared.ts", "extra.ts"],
          additions: 200,
          deletions: 50,
        }),
        leg("Tidy", "finished", { paths: ["shared.ts"], additions: 20, deletions: 5 }),
        leg("Lazy", "finished", { paths: ["shared.ts"], additions: 2, deletions: 0 }),
      ]),
    );
    // `shared.ts` is the only file all three touched, so all three qualify and
    // the smallest wins.
    expect(suggestedLeg(c)).toBe(c.columns[2].legId);
  });

  /// The regression guard for a circularity the first version had. Defining
  /// consensus as "every leg" means a leg that skips a file removes it from the
  /// set — so no leg can ever be penalised for skipping anything, and the
  /// heuristic recommends whoever did the least work. A majority breaks it.
  it("skips a leg that missed a majority file, however small it is", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["one.ts", "two.ts"], additions: 100, deletions: 0 }),
        leg("B", "finished", { paths: ["one.ts", "two.ts"], additions: 90, deletions: 0 }),
        leg("Tiny", "finished", { paths: ["one.ts"], additions: 1, deletions: 0 }),
      ]),
    );
    // `two.ts` is consensus (2 of 3) even though it is not shared by all three.
    expect(consensusPaths(c)).toEqual(["one.ts", "two.ts"]);
    expect(c.sharedCount).toBe(1);
    expect(suggestedLeg(c)).toBe(c.columns[1].legId);
  });

  it("needs more than half, not merely more than one", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["a.ts", "half.ts"] }),
        leg("B", "finished", { paths: ["b.ts", "half.ts"] }),
        leg("C", "finished", { paths: ["c.ts"] }),
        leg("D", "finished", { paths: ["d.ts"] }),
      ]),
    );
    // `half.ts` is 2 of 4 — a tie is not a consensus.
    expect(consensusPaths(c)).toEqual([]);
  });

  /// With no overlap the choice would come down to size alone, which is not a
  /// recommendation — it is a coin toss with a number on it.
  it("declines to suggest when no file was touched by every leg", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["a.ts"], additions: 1, deletions: 0 }),
        leg("B", "finished", { paths: ["b.ts"], additions: 900, deletions: 0 }),
      ]),
    );
    expect(suggestedLeg(c)).toBeNull();
  });

  it("declines to suggest with nothing to compare", () => {
    expect(suggestedLeg(compareRun(run([leg("A", "finished", { paths: ["a.ts"] })])))).toBeNull();
  });
});

describe("the summary line", () => {
  it("says how much they agree and where they differ", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["shared.ts", "a.ts"] }),
        leg("B", "finished", { paths: ["shared.ts", "b.ts"] }),
      ]),
    );
    expect(comparisonSummary(c)).toBe("1 file touched by every leg, 2 where they differ.");
  });

  it("says so when the approaches do not overlap at all", () => {
    const c = compareRun(
      run([leg("A", "finished", { paths: ["a.ts"] }), leg("B", "finished", { paths: ["b.ts"] })]),
    );
    expect(comparisonSummary(c)).toMatch(/do not overlap/);
  });

  it("says so when they agree completely", () => {
    const c = compareRun(
      run([
        leg("A", "finished", { paths: ["a.ts"] }),
        leg("B", "finished", { paths: ["a.ts"] }),
      ]),
    );
    expect(comparisonSummary(c)).toBe("Every leg touched the same 1 file.");
  });

  /// "Nothing to compare" and "nothing happened" are different facts, and a
  /// surface that conflates them sends the user looking for a bug.
  it("distinguishes one leg from no legs", () => {
    expect(comparisonSummary(compareRun(run([leg("A", "finished", { paths: ["a.ts"] })])))).toMatch(
      /only one leg/i,
    );
    expect(comparisonSummary(compareRun(run([leg("A", "failed", null)])))).toMatch(
      /no leg produced a diff yet/i,
    );
  });
});
