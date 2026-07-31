/// Lane routing for the commit graph.
///
/// This file exists because the router shipped with none, and the defect that
/// prompted it — a fork point erasing the earlier child's edge — was invisible
/// to every kind of testing except drawing the DAG and checking that the lines
/// join up. So the centrepiece here is `assertEdgesConnect`, a structural
/// invariant over the whole layout rather than a set of hand-written expected
/// coordinates: for every parent edge in the input, the gutter must contain an
/// unbroken chain of segments from the child's row to the parent's row.
///
/// Hand-written coordinate expectations would pin the *current* drawing to the
/// pixel and still not notice a missing line, which is exactly how this got
/// through the first time.

import { describe, expect, it } from "vitest";
import { computeLanes, type GraphLayout, gutterRange } from "./lanes";
import type { GraphCommit } from "@/types/history";

/// A DAG written as `oid: parents`, in the order the revwalk would emit it
/// (children before parents).
function graph(spec: Record<string, string[]>): GraphCommit[] {
  return Object.entries(spec).map(([oid, parentOids]) => ({
    oid,
    shortOid: oid.slice(0, 7),
    parentOids,
    summary: oid,
    authorName: "Test",
    authorTime: 0,
    commitTime: 0,
    refs: [],
    isHead: false,
  }));
}

/// Every parent edge must be traceable through the gutter.
///
/// Walking down from the child's row, a lane occupies some column in each gap.
/// A segment's `bottom` in gap `g` has to be matched by some segment's `top` in
/// gap `g + 1`, or the line is drawn into empty space. The chain ends when it
/// arrives at the parent's dot.
function assertEdgesConnect(layout: GraphLayout) {
  const rowOf = new Map<string, number>();
  layout.rows.forEach((r, i) => rowOf.set(r.commit.oid, i));

  const broken: string[] = [];

  for (const [i, row] of layout.rows.entries()) {
    for (const parent of row.commit.parentOids) {
      const target = rowOf.get(parent);
      // A parent outside the loaded window has nothing to connect to; that is
      // truncation, not breakage.
      if (target === undefined) continue;

      // Start at whichever segment leaves this dot.
      let carried = row.segments
        .filter((s) => s.top === row.col)
        .map((s) => s.bottom);
      if (carried.length === 0) {
        broken.push(`${row.commit.oid} -> ${parent}: nothing leaves the dot`);
        continue;
      }

      let reached = false;
      for (let g = i + 1; g <= target; g++) {
        if (g === target) {
          reached = carried.includes(layout.rows[g].col);
          break;
        }
        const next = layout.rows[g].segments
          .filter((s) => carried.includes(s.top))
          .map((s) => s.bottom);
        if (next.length === 0) break;
        carried = next;
      }
      if (!reached) {
        broken.push(`${row.commit.oid} -> ${parent}: chain dies before the parent`);
      }
    }
  }

  expect(broken).toEqual([]);
}

/// Two *distinct* lanes may not end the same gap in the same column unless
/// they are converging on the next commit's dot.
///
/// Grouped by `lane`, not by segment count: a dot connecting into an existing
/// lane produces two segments with the same `lane` landing in the same column,
/// and that is the whole point of the fix — they are one lane being joined,
/// not two lanes colliding.
function assertNoCollisions(layout: GraphLayout) {
  layout.rows.forEach((row, i) => {
    const next = layout.rows[i + 1];
    const lanesByColumn = new Map<number, Set<number>>();
    for (const s of row.segments) {
      const set = lanesByColumn.get(s.bottom) ?? new Set<number>();
      set.add(s.lane);
      lanesByColumn.set(s.bottom, set);
    }
    for (const [col, lanes] of lanesByColumn) {
      if (lanes.size > 1 && next && col !== next.col) {
        throw new Error(
          `row ${i}: lanes ${[...lanes].join(", ")} all land in column ${col}, ` +
            `which is not the next dot (column ${next.col})`,
        );
      }
    }
  });
}

describe("fork points", () => {
  /// The regression. Two branches off one base: both children must keep a
  /// visible line down to it.
  ///
  /// Before the fix the second child's dot connector overwrote the first
  /// child's pass-through, and b1's line stopped dead one row above `base`.
  it("keeps both children connected to a shared parent", () => {
    const layout = computeLanes(
      graph({
        t1: ["b1"],
        t2: ["b2"],
        b1: ["base"],
        b2: ["base"],
        base: [],
      }),
    );
    assertEdgesConnect(layout);
    assertNoCollisions(layout);
  });

  it("emits a pass-through as well as a connector when a dot joins an existing lane", () => {
    const layout = computeLanes(
      graph({ b1: ["base"], b2: ["base"], base: [] }),
    );
    // b1 opens the lane to `base`. On b2's row that lane must still be drawn
    // *and* b2 must connect into it — two segments, not one.
    const b2Row = layout.rows[1];
    expect(b2Row.segments.length).toBeGreaterThanOrEqual(2);
    const tops = b2Row.segments.map((s) => s.top).sort();
    expect(new Set(tops).size).toBe(2);
  });

  it("survives a wide fan-in", () => {
    const spec: Record<string, string[]> = {};
    for (let i = 0; i < 8; i++) spec[`tip${i}`] = ["base"];
    spec.base = [];
    const layout = computeLanes(graph(spec));
    assertEdgesConnect(layout);
    assertNoCollisions(layout);
  });
});

describe("merges", () => {
  it("connects both parents of a two-parent merge", () => {
    const layout = computeLanes(
      graph({
        m: ["a", "b"],
        a: ["base"],
        b: ["base"],
        base: [],
      }),
    );
    assertEdgesConnect(layout);
    assertNoCollisions(layout);
  });

  it("connects every parent of an octopus merge", () => {
    const layout = computeLanes(
      graph({
        m: ["p1", "p2", "p3"],
        p1: ["r"],
        p2: ["r"],
        p3: ["r"],
        r: [],
      }),
    );
    assertEdgesConnect(layout);
    assertNoCollisions(layout);
  });

  /// A merge whose second parent is also an ancestor of its first — the shape
  /// that produced a break at gap 0.
  it("handles a second parent that the first parent also reaches", () => {
    const layout = computeLanes(graph({ A: ["B", "C"], B: ["C"], C: [] }));
    assertEdgesConnect(layout);
    assertNoCollisions(layout);
  });

  it("collapses a parent listed twice into one lane", () => {
    const layout = computeLanes(graph({ m: ["p", "p"], p: [] }));
    assertEdgesConnect(layout);
    // One parent, so one lane — and the connector must not be drawn on top of
    // itself.
    const segs = layout.rows[0].segments;
    expect(segs).toHaveLength(1);
    expect(layout.maxCols).toBe(1);
  });
});

describe("roots and reuse", () => {
  it("releases the column of a root commit", () => {
    const layout = computeLanes(graph({ a: ["r"], r: [], b: [] }));
    assertEdgesConnect(layout);
    // `r` has no parents, so nothing flows out of its row into `b`'s.
    expect(layout.rows[1].segments).toHaveLength(0);
  });

  it("does not connect two disconnected roots", () => {
    const layout = computeLanes(graph({ r1: [], r2: [] }));
    expect(layout.rows[0].segments).toHaveLength(0);
    expect(layout.maxCols).toBe(1);
  });

  it("reuses a column after its branch ends", () => {
    const layout = computeLanes(
      graph({ side: ["base"], base: [], later: [] }),
    );
    assertEdgesConnect(layout);
    expect(layout.maxCols).toBe(1);
  });
});

describe("truncation", () => {
  /// A parent outside the loaded window keeps its lane occupied rather than
  /// vanishing — the line should run to the bottom of what we have.
  it("keeps a lane for a parent that was not loaded", () => {
    const layout = computeLanes(graph({ a: ["missing"], b: [] }));
    expect(layout.rows[0].segments).toHaveLength(1);
    expect(layout.rows[0].segments[0].bottom).toBe(0);
  });

  it("is empty for an empty history", () => {
    const layout = computeLanes([]);
    expect(layout.rows).toEqual([]);
    // Never zero: the gutter width is derived from this.
    expect(layout.maxCols).toBe(1);
  });
});

describe("colour stability", () => {
  /// A lane's colour index is its own column, so a connector drawn from a
  /// merge dot into another lane is stroked in the lane's colour rather than
  /// the dot's.
  it("labels a connector with the lane it joins, not the dot it leaves", () => {
    const layout = computeLanes(graph({ b1: ["base"], b2: ["base"], base: [] }));
    // The connector from b2's dot (column 1) into base's lane (column 0)
    // carries lane 0.
    const connector = layout.rows[1].segments.find((s) => s.top === 1 && s.bottom === 0);
    expect(connector?.lane).toBe(0);
  });
});

/// The window into history almost never ends where history does. The last row
/// used to emit no segments at all, so every in-flight lane stopped one row
/// early and nothing distinguished "this is the root commit" from "we asked
/// for 200".
describe("the truncation boundary", () => {
  it("reports the lanes that continue past the last row", () => {
    // `b` is the last row we fetched, and it has a parent we did not.
    const layout = computeLanes(graph({ a: ["b"], b: ["c-not-fetched"] }));
    expect(layout.truncatedLanes.length).toBeGreaterThan(0);
  });

  it("draws those lanes to the bottom edge instead of stopping them short", () => {
    const layout = computeLanes(graph({ a: ["b"], b: ["c-not-fetched"] }));
    const last = layout.rows[layout.rows.length - 1];
    expect(last.segments.length).toBeGreaterThan(0);
    for (const lane of layout.truncatedLanes) {
      expect(last.segments.some((seg) => seg.lane === lane)).toBe(true);
    }
  });

  it("says nothing is truncated when the history really does end", () => {
    // `b` is a root commit: no parents, nothing left in flight.
    const layout = computeLanes(graph({ a: ["b"], b: [] }));
    expect(layout.truncatedLanes).toEqual([]);
    expect(layout.rows[layout.rows.length - 1].segments).toEqual([]);
  });

  it("has nothing to say about an empty graph", () => {
    const layout = computeLanes([]);
    expect(layout.truncatedLanes).toEqual([]);
  });

  /// A lane the last dot itself opened must leave *from* the dot, not appear
  /// beside it.
  it("starts a lane the last row created at that row's dot", () => {
    const layout = computeLanes(graph({ a: [], b: ["parent-not-fetched"] }));
    const last = layout.rows[layout.rows.length - 1];
    expect(last.segments.every((seg) => seg.top === last.col)).toBe(true);
  });
});

/// GRAPH-P4's windowing, at the one point that is provable without a browser.
///
/// jsdom has no layout engine, so `createVirtualizer` measures a zero-height
/// scroll container and reports whatever it likes — the virtualization itself is
/// browser-project work. What *is* testable here is the arithmetic that decides
/// which rows the gutter draws, and that arithmetic is where the interesting bug
/// lives: a gutter drawn to exactly the visible window loses the edge entering
/// the top and the one leaving the bottom, so the graph looks severed at both
/// ends — and only while scrolling.
describe("gutterRange", () => {
  it("draws one row past the window on each side", () => {
    expect(gutterRange(100, 10, 20)).toEqual([9, 21]);
  });

  /// The bug the widening exists to prevent, stated as an invariant: every
  /// visible row's *outgoing* segment has a row below it to land on.
  it("always includes the row below the last visible one", () => {
    const [, last] = gutterRange(100, 10, 20);
    expect(last).toBeGreaterThan(20);
  });

  it("clamps at the top of the history", () => {
    expect(gutterRange(100, 0, 9)).toEqual([0, 10]);
  });

  it("clamps at the bottom of the history", () => {
    expect(gutterRange(100, 90, 99)).toEqual([89, 99]);
  });

  it("handles a window covering everything", () => {
    expect(gutterRange(5, 0, 4)).toEqual([0, 4]);
  });

  /// An empty range rather than `[0, 0]`, so `slice(first, last + 1)` yields
  /// nothing instead of one undefined row.
  it("returns an empty range for an empty history", () => {
    const [first, last] = gutterRange(0, 0, 0);
    expect(last).toBeLessThan(first);
  });
});
