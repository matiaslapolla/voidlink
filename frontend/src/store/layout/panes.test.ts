/// The split-tree reducer's contract.
///
/// Two properties matter more than the rest and are asserted first: the default
/// layout must resolve to *today's* workbench (one strip, every tab, registry
/// order), and closing the last tab in a group must take the group with it.
/// The first is what lets this land without a migration; the second is what
/// stops a split from rotting into dead rectangles.
import { describe, expect, it } from "vitest";
import {
  groupCount,
  groupList,
  groupOwning,
  moveTabToGroup,
  normalizeRatios,
  parsePaneLayout,
  parsePaneLayouts,
  pruneClosedTabs,
  removeGroup,
  resolveGroupTabs,
  serializePaneLayout,
  setGroupActiveTab,
  setSplitRatios,
  singleGroupLayout,
  splitGroup,
  type PaneNode,
} from "./panes";

const TABS = ["t1", "t2", "t3", "t4"];

/// A serialised flat `n`-way split — the shape a persisted layout takes when a
/// user has split one row many times. Built as raw JSON because `splitGroup`
/// only ever produces two-child splits.
function flatSplit(n: number): unknown {
  return {
    kind: "split",
    id: "s",
    orientation: "row",
    ratios: Array(n).fill(1 / n),
    children: Array.from({ length: n }, (_, i) => ({
      kind: "group",
      id: `g${i}`,
      group: { id: `g${i}`, tabIds: [], activeTabId: null },
    })),
  };
}

/// Split `n - 1` times, alternating orientation, so the tree is `n` groups deep
/// in a nest of two-child splits. Returns the tree and the id of the last group
/// created — the deepest one, and the awkward one to operate on.
function splitToDepth(n: number): { layout: PaneNode; last: string } {
  let layout: PaneNode = singleGroupLayout("g1");
  let last = "g1";
  for (let i = 1; i < n; i++) {
    const r = splitGroup(layout, last, i % 2 === 0 ? "column" : "row", "after");
    expect(r.newGroupId).not.toBeNull();
    layout = r.layout;
    last = r.newGroupId!;
  }
  return { layout, last };
}

/// A two-group tree with `t3` moved into the second group.
function twoGroups() {
  const base = singleGroupLayout("g1");
  const { layout, newGroupId } = splitGroup(base, "g1", "row", "after");
  expect(newGroupId).not.toBeNull();
  return { layout: moveTabToGroup(layout, "t3", newGroupId!, null), right: newGroupId! };
}

describe("the default layout", () => {
  it("is one group that claims nothing", () => {
    const layout = singleGroupLayout("g1");
    expect(groupCount(layout)).toBe(1);
    expect(groupList(layout)[0]).toEqual({ id: "g1", tabIds: [], activeTabId: null });
  });

  it("resolves to every tab, in registry order — today's workbench", () => {
    const layout = singleGroupLayout("g1");
    expect(resolveGroupTabs(layout, TABS).get("g1")).toEqual(TABS);
  });

  it("keeps unclaimed tabs on the first group once a split exists", () => {
    const { layout, right } = twoGroups();
    const resolved = resolveGroupTabs(layout, TABS);
    expect(resolved.get("g1")).toEqual(["t1", "t2", "t4"]);
    expect(resolved.get(right)).toEqual(["t3"]);
  });

  it("never renders a claim on a tab that has been closed", () => {
    const { layout, right } = twoGroups();
    const resolved = resolveGroupTabs(layout, ["t1", "t2"]);
    expect(resolved.get(right)).toEqual([]);
    expect(resolved.get("g1")).toEqual(["t1", "t2"]);
  });
});

describe("splitting", () => {
  it("puts the new group on the requested side", () => {
    const before = splitGroup(singleGroupLayout("g1"), "g1", "row", "before");
    expect(groupList(before.layout).map((g) => g.id)).toEqual([before.newGroupId, "g1"]);
    const after = splitGroup(singleGroupLayout("g1"), "g1", "row", "after");
    expect(groupList(after.layout).map((g) => g.id)).toEqual(["g1", after.newGroupId]);
  });

  it("splits evenly", () => {
    const { layout } = splitGroup(singleGroupLayout("g1"), "g1", "column", "after");
    expect(layout.kind).toBe("split");
    if (layout.kind !== "split") return;
    expect(layout.orientation).toBe("column");
    expect(layout.ratios).toEqual([0.5, 0.5]);
  });

  it("nests recursively", () => {
    let layout = singleGroupLayout("g1");
    const a = splitGroup(layout, "g1", "row", "after");
    layout = a.layout;
    const b = splitGroup(layout, a.newGroupId!, "column", "after");
    expect(groupCount(b.layout)).toBe(3);
  });

  /// There is no cap. This is the test the old `MAX_GROUPS` assertion became:
  /// splitting far past the number that used to be the ceiling keeps producing
  /// real, distinct groups rather than silently returning the same tree.
  it("keeps splitting past the number that used to be the cap", () => {
    const { layout } = splitToDepth(16);
    expect(groupCount(layout)).toBe(16);
    expect(new Set(groupList(layout).map((g) => g.id)).size).toBe(16);
  });

  it("keeps every split's ratios summing to one however deep the nest goes", () => {
    const { layout } = splitToDepth(32);
    const walk = (node: PaneNode) => {
      if (node.kind !== "split") return;
      expect(node.ratios.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(node.ratios.every((r) => r > 0)).toBe(true);
      node.children.forEach(walk);
    };
    walk(layout);
  });

  /// The old floor was a fraction (`MIN_RATIO`), which cannot survive an
  /// unbounded count — eleven panes cannot each have a tenth. The contract now
  /// is only "sums to one, nothing zero or negative", at any count, and the
  /// usable-width question moved to `MIN_PANE_PX` in `paneDrop`.
  it("normalises to a positive distribution at any count", () => {
    for (const n of [2, 8, 20, 50]) {
      const even = normalizeRatios([], n);
      expect(even).toHaveLength(n);
      expect(even.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(even.every((r) => r > 0)).toBe(true);

      // A hand-edited blob that starves every pane but one still sums to 1 and
      // still leaves every pane on screen, however small.
      const starved = normalizeRatios([0.99, ...Array(n - 1).fill(0.0001)], n);
      expect(starved.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
      expect(starved.every((r) => r > 0)).toBe(true);
      // Proportions are *preserved*, not flattened: the old code fell back to
      // even ratios above ten panes, discarding a layout the user arranged.
      expect(starved[0]).toBeGreaterThan(starved[1] * 100);
    }
  });

  it("collapses back down one group at a time from a 20-way nest", () => {
    let layout = splitToDepth(20).layout;
    for (let n = 20; n > 1; n--) {
      const victim = groupList(layout)[groupList(layout).length - 1];
      layout = removeGroup(layout, victim.id);
      expect(groupCount(layout)).toBe(n - 1);
      const ratios = collectRatios(layout);
      expect(ratios.every((r) => r > 0)).toBe(true);
    }
    expect(layout.kind).toBe("group");
  });

  /// Removing one child of a *flat* n-way split is the case the nested walk
  /// above never reaches: the split survives with one fewer child and has to
  /// renormalise in place.
  it("renormalises a flat 20-way split when one group is removed", () => {
    const layout = parsePaneLayout(flatSplit(20));
    expect(layout).not.toBeNull();
    const after = removeGroup(layout!, "g7");
    expect(groupCount(after)).toBe(19);
    expect(groupList(after).some((g) => g.id === "g7")).toBe(false);
    if (after.kind !== "split") throw new Error("expected a split");
    expect(after.ratios).toHaveLength(19);
    expect(after.ratios.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(after.ratios.every((r) => r > 0)).toBe(true);
  });

  /// A tree saved by an older build, or by a bigger window, is not malformed.
  /// The count check that used to reject this is what the cap removal deleted.
  it("loads a stored tree with far more groups than the old cap", () => {
    const back = parsePaneLayout(flatSplit(20));
    expect(back).not.toBeNull();
    expect(groupCount(back!)).toBe(20);
  });

  it("ignores a split of a group that does not exist", () => {
    const layout = singleGroupLayout("g1");
    expect(splitGroup(layout, "nope", "row", "after").layout).toBe(layout);
  });
});

describe("removing a group", () => {
  it("collapses the split that held it", () => {
    const { layout, right } = twoGroups();
    const after = removeGroup(layout, right);
    expect(after.kind).toBe("group");
    expect(groupCount(after)).toBe(1);
  });

  it("renormalises the ratios of a split it does not collapse", () => {
    let layout: PaneNode = singleGroupLayout("g1");
    const a = splitGroup(layout, "g1", "row", "after");
    const b = splitGroup(a.layout, a.newGroupId!, "row", "after");
    layout = b.layout;
    const after = removeGroup(layout, b.newGroupId!);
    const total = collectRatios(after).reduce((x, y) => x + y, 0);
    expect(groupCount(after)).toBe(2);
    expect(total).toBeCloseTo(1, 10);
  });

  it("never removes the last group", () => {
    const layout = singleGroupLayout("g1");
    expect(removeGroup(layout, "g1")).toBe(layout);
  });
});

function collectRatios(node: PaneNode): number[] {
  if (node.kind === "group") return [];
  return [...node.ratios, ...node.children.flatMap(collectRatios)];
}

describe("moving a tab between groups", () => {
  it("claims it in the target and drops every other claim", () => {
    const { layout, right } = twoGroups();
    const after = moveTabToGroup(layout, "t3", "g1", null);
    const resolved = resolveGroupTabs(after, TABS);
    expect(resolved.get(right)).toEqual([]);
    expect(resolved.get("g1")).toContain("t3");
  });

  it("lands before the tab it was dropped on", () => {
    const { layout, right } = twoGroups();
    let after = moveTabToGroup(layout, "t1", right, null);
    after = moveTabToGroup(after, "t2", right, "t3");
    expect(resolveGroupTabs(after, TABS).get(right)).toEqual(["t2", "t3", "t1"]);
  });

  it("focuses the tab it just received", () => {
    const { layout, right } = twoGroups();
    const after = moveTabToGroup(layout, "t1", right, null);
    expect(findGroupById(after, right).activeTabId).toBe("t1");
  });

  it("re-focuses the source group when it loses the tab it was showing", () => {
    const { layout, right } = twoGroups();
    let after = moveTabToGroup(layout, "t1", right, null);
    after = moveTabToGroup(after, "t2", right, null);
    // `right` now shows t2; move it away and t1 (its remaining tab) takes over.
    after = moveTabToGroup(after, "t2", "g1", null);
    expect(findGroupById(after, right).activeTabId).toBe("t1");
  });

  it("ignores a move into a group that does not exist", () => {
    const { layout } = twoGroups();
    expect(moveTabToGroup(layout, "t1", "nope", null)).toBe(layout);
  });

  it("reports which group owns a tab, unclaimed ones included", () => {
    const { layout, right } = twoGroups();
    expect(groupOwning(layout, "t3", TABS)).toBe(right);
    expect(groupOwning(layout, "t1", TABS)).toBe("g1");
    expect(groupOwning(layout, "gone", TABS)).toBeNull();
  });
});

function findGroupById(node: PaneNode, id: string) {
  const g = groupList(node).find((x) => x.id === id);
  if (!g) throw new Error(`no group ${id}`);
  return g;
}

describe("pruning closed tabs", () => {
  it("collapses a group whose last tab closed", () => {
    const { layout } = twoGroups();
    const after = pruneClosedTabs(layout, ["t1", "t2", "t4"]);
    expect(groupCount(after)).toBe(1);
    expect(after.kind).toBe("group");
  });

  it("keeps the first group even with nothing claimed — it holds the rest", () => {
    const layout = singleGroupLayout("g1");
    expect(groupCount(pruneClosedTabs(layout, []))).toBe(1);
  });

  it("drops a stale active pointer without dropping the group", () => {
    const { layout, right } = twoGroups();
    let after = moveTabToGroup(layout, "t1", right, null);
    after = pruneClosedTabs(after, ["t2", "t3", "t4"]);
    const g = findGroupById(after, right);
    expect(g.tabIds).toEqual(["t3"]);
    expect(g.activeTabId).toBeNull();
  });

  it("is idempotent", () => {
    const { layout } = twoGroups();
    const once = pruneClosedTabs(layout, ["t1", "t2"]);
    expect(pruneClosedTabs(once, ["t1", "t2"])).toEqual(once);
  });
});

describe("ratios", () => {
  it("normalise to one", () => {
    expect(normalizeRatios([2, 2], 2).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(normalizeRatios([], 3).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  /// A lopsided pair is honoured, not corrected. The reducer used to pull the
  /// small side up to `MIN_RATIO`; the splitter's px floor is what keeps a pane
  /// draggable now, and second-guessing a stored ratio here would only fight it.
  it("keep a lopsided pair lopsided, and both panes alive", () => {
    const [a, b] = normalizeRatios([0.999, 0.001], 2);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b);
    expect(a + b).toBeCloseTo(1, 10);
  });

  it("survive a NaN or a negative from disk", () => {
    const out = normalizeRatios([Number.NaN, -3], 2);
    expect(out.every((r) => Number.isFinite(r) && r > 0)).toBe(true);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("are settable per split", () => {
    const { layout } = splitGroup(singleGroupLayout("g1"), "g1", "row", "after");
    if (layout.kind !== "split") throw new Error("expected a split");
    const after = setSplitRatios(layout, layout.id, [0.7, 0.3]);
    if (after.kind !== "split") throw new Error("expected a split");
    expect(after.ratios[0]).toBeCloseTo(0.7, 5);
  });
});

describe("the geometry serializer", () => {
  it("round-trips a nested tree", () => {
    let layout: PaneNode = singleGroupLayout("g1");
    const a = splitGroup(layout, "g1", "row", "after");
    const b = splitGroup(a.layout, a.newGroupId!, "column", "after");
    layout = moveTabToGroup(b.layout, "t3", b.newGroupId!, null);
    layout = setGroupActiveTab(layout, "g1", "t1");

    const back = parsePaneLayout(JSON.parse(JSON.stringify(serializePaneLayout(layout))));
    expect(back).toEqual(layout);
  });

  it("rejects duplicate group ids, which would make claims ambiguous", () => {
    expect(
      parsePaneLayout({
        kind: "split",
        id: "s",
        orientation: "row",
        ratios: [0.5, 0.5],
        children: [
          { kind: "group", id: "g", group: { id: "g", tabIds: [], activeTabId: null } },
          { kind: "group", id: "g", group: { id: "g", tabIds: [], activeTabId: null } },
        ],
      }),
    ).toBeNull();
  });

  it("rejects garbage rather than half-honouring it", () => {
    expect(parsePaneLayout(null)).toBeNull();
    expect(parsePaneLayout("nope")).toBeNull();
    expect(parsePaneLayout({ kind: "split", orientation: "diagonal" })).toBeNull();
    expect(parsePaneLayout({ kind: "split", orientation: "row", children: [] })).toBeNull();
  });

  it("seeds the default for every worktree the blob misses or mangles", () => {
    const out = parsePaneLayouts({ "wt-a": "garbage" }, ["wt-a", "wt-b"]);
    expect(groupCount(out["wt-a"])).toBe(1);
    expect(groupCount(out["wt-b"])).toBe(1);
    expect(out["wt-a"].id).not.toBe(out["wt-b"].id);
  });
});
