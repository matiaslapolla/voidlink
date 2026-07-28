/// The split-tree reducer's contract.
///
/// Two properties matter more than the rest and are asserted first: the default
/// layout must resolve to *today's* workbench (one strip, every tab, registry
/// order), and closing the last tab in a group must take the group with it.
/// The first is what lets this land without a migration; the second is what
/// stops a split from rotting into dead rectangles.
import { describe, expect, it } from "vitest";
import {
  MAX_GROUPS,
  canSplit,
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

  it("refuses past the four-group cap, leaving the tree untouched", () => {
    let layout: PaneNode = singleGroupLayout("g1");
    let last = "g1";
    for (let i = 1; i < MAX_GROUPS; i++) {
      const r = splitGroup(layout, last, "row", "after");
      layout = r.layout;
      last = r.newGroupId!;
    }
    expect(groupCount(layout)).toBe(MAX_GROUPS);
    expect(canSplit(layout)).toBe(false);

    const refused = splitGroup(layout, last, "row", "after");
    expect(refused.newGroupId).toBeNull();
    expect(refused.layout).toBe(layout);
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

  it("refuse to starve a pane out of existence", () => {
    const [a, b] = normalizeRatios([0.999, 0.001], 2);
    expect(b).toBeGreaterThanOrEqual(0.09);
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

  it("rejects a tree with more groups than the cap", () => {
    const overfull = {
      kind: "split",
      id: "s",
      orientation: "row",
      ratios: [0.2, 0.2, 0.2, 0.2, 0.2],
      children: Array.from({ length: 5 }, (_, i) => ({
        kind: "group",
        id: `g${i}`,
        group: { id: `g${i}`, tabIds: [], activeTabId: null },
      })),
    };
    expect(parsePaneLayout(overfull)).toBeNull();
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
