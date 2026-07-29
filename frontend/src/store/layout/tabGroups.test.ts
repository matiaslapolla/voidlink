/// The tab-group reducer's contract.
///
/// The property asserted hardest is the one the whole feature hangs off: tab
/// groups are a *second* axis over `panes.ts`'s claim model, so a tab in no
/// group must render exactly as it does now, and moving a group between panes
/// must go through `moveTabToGroup` rather than around it.
import { describe, expect, it } from "vitest";
import {
  addTabToGroup,
  allTabGroups,
  createTabGroup,
  deriveTabGroups,
  dissolveTabGroup,
  effectiveTabGroups,
  emptyTabGroupState,
  findTabGroup,
  materializeAutoGroups,
  moveTabGroupToPane,
  paneOfTabGroup,
  parseTabGroupState,
  parseTabGroupStates,
  pruneTabGroups,
  recolorTabGroup,
  removeTabFromGroup,
  renameTabGroup,
  reorderTabGroups,
  serializeTabGroupState,
  setAutoGroupMode,
  stripEntries,
  tabGroupOf,
  toggleTabGroupCollapsed,
  visibleStripTabIds,
  type TabGroupState,
} from "./tabGroups";
import {
  moveTabToGroup,
  resolveGroupTabs,
  singleGroupLayout,
  splitGroup,
  type PaneNode,
} from "./panes";

const TABS = ["t1", "t2", "t3", "t4"];

/// One pane holding every tab — the default layout's resolution.
const onePane = (ids: readonly string[] = TABS) =>
  new Map<string, readonly string[]>([["p1", [...ids]]]);

/// A state with one group `G` in pane `p1` holding t1 and t2.
function withGroup(): { state: TabGroupState; groupId: string } {
  const { state, groupId } = createTabGroup(emptyTabGroupState(), "p1", {
    label: "Review",
    tabIds: ["t1", "t2"],
  });
  return { state, groupId };
}

describe("creating, naming and colouring", () => {
  it("creates a named group in a pane", () => {
    const { state, groupId } = withGroup();
    const group = findTabGroup(state, groupId);
    expect(group?.label).toBe("Review");
    expect(group?.tabIds).toEqual(["t1", "t2"]);
    expect(group?.collapsed).toBe(false);
    expect(paneOfTabGroup(state, groupId)).toBe("p1");
  });

  it("gives each group in a strip a different colour", () => {
    const first = createTabGroup(emptyTabGroupState(), "p1", { tabIds: ["t1"] });
    const second = createTabGroup(first.state, "p1", { tabIds: ["t2"] });
    const colors = allTabGroups(second.state).map((g) => g.color);
    expect(new Set(colors).size).toBe(2);
  });

  it("renames and recolours", () => {
    const { state, groupId } = withGroup();
    const named = renameTabGroup(state, groupId, "  Shipping  ");
    expect(findTabGroup(named, groupId)?.label).toBe("Shipping");
    const colored = recolorTabGroup(named, groupId, "chart-4");
    expect(findTabGroup(colored, groupId)?.color).toBe("chart-4");
  });

  it("refuses a blank rename rather than leaving a nameless chip", () => {
    const { state, groupId } = withGroup();
    expect(renameTabGroup(state, groupId, "   ")).toBe(state);
  });

  it("collapses and expands", () => {
    const { state, groupId } = withGroup();
    const collapsed = toggleTabGroupCollapsed(state, groupId);
    expect(findTabGroup(collapsed, groupId)?.collapsed).toBe(true);
    expect(findTabGroup(toggleTabGroupCollapsed(collapsed, groupId), groupId)?.collapsed).toBe(
      false,
    );
  });

  it("dissolves, leaving the tabs in the strip", () => {
    const { state, groupId } = withGroup();
    const after = dissolveTabGroup(state, groupId);
    expect(findTabGroup(after, groupId)).toBeNull();
    expect(stripEntries(TABS, [])).toEqual(TABS.map((tabId) => ({ kind: "tab", tabId })));
    expect(visibleStripTabIds(stripEntries(TABS, []))).toEqual(TABS);
  });
});

describe("membership", () => {
  it("adds a tab, landing before the one it was dropped on", () => {
    const { state, groupId } = withGroup();
    const after = addTabToGroup(state, groupId, "t3", "t2");
    expect(findTabGroup(after, groupId)?.tabIds).toEqual(["t1", "t3", "t2"]);
  });

  it("appends when there is nothing to land before", () => {
    const { state, groupId } = withGroup();
    expect(findTabGroup(addTabToGroup(state, groupId, "t3", null), groupId)?.tabIds).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("keeps a tab in at most one group", () => {
    const first = createTabGroup(emptyTabGroupState(), "p1", { tabIds: ["t1", "t2"] });
    const second = createTabGroup(first.state, "p1", { tabIds: ["t3"] });
    const after = addTabToGroup(second.state, second.groupId, "t1", null);
    expect(findTabGroup(after, first.groupId)?.tabIds).toEqual(["t2"]);
    expect(findTabGroup(after, second.groupId)?.tabIds).toEqual(["t3", "t1"]);
    expect(tabGroupOf(after, "t1")?.id).toBe(second.groupId);
  });

  it("removes a tab from whatever group holds it", () => {
    const { state, groupId } = withGroup();
    const after = removeTabFromGroup(state, "t1");
    expect(findTabGroup(after, groupId)?.tabIds).toEqual(["t2"]);
  });

  it("removes the group when its last member leaves", () => {
    const { state, groupId } = createTabGroup(emptyTabGroupState(), "p1", { tabIds: ["t1"] });
    expect(findTabGroup(removeTabFromGroup(state, "t1"), groupId)).toBeNull();
  });

  it("does not resurrect a group that emptied while re-adding its own tab", () => {
    const { state, groupId } = createTabGroup(emptyTabGroupState(), "p1", { tabIds: ["t1"] });
    const after = addTabToGroup(state, groupId, "t1", null);
    expect(findTabGroup(after, groupId)?.tabIds).toEqual(["t1"]);
  });

  it("ignores an add into a group that does not exist", () => {
    const { state } = withGroup();
    expect(addTabToGroup(state, "nope", "t3", null)).toBe(state);
  });
});

describe("strip order", () => {
  it("leaves a tab in no group exactly where it was", () => {
    const { state } = withGroup();
    const entries = stripEntries(TABS, state.byPane.p1);
    expect(entries.filter((e) => e.kind === "tab")).toEqual([
      { kind: "tab", tabId: "t3" },
      { kind: "tab", tabId: "t4" },
    ]);
  });

  it("renders a group as one entry holding its live members", () => {
    const { state, groupId } = withGroup();
    const entries = stripEntries(TABS, state.byPane.p1);
    const group = entries.find((e) => e.kind === "group");
    expect(group).toEqual({
      kind: "group",
      group: findTabGroup(state, groupId),
      tabIds: ["t1", "t2"],
    });
  });

  it("renders no ghost for a group referencing a closed tab", () => {
    const { state } = withGroup();
    const entries = stripEntries(["t2", "t3"], state.byPane.p1);
    expect(entries).toEqual([
      { kind: "group", group: state.byPane.p1[0], tabIds: ["t2"] },
      { kind: "tab", tabId: "t3" },
    ]);
  });

  it("emits nothing for a group whose members have all closed", () => {
    const { state } = withGroup();
    expect(stripEntries(["t3"], state.byPane.p1)).toEqual([{ kind: "tab", tabId: "t3" }]);
  });

  it("hides a collapsed group's members from the rendered tab list", () => {
    const { state, groupId } = withGroup();
    const collapsed = toggleTabGroupCollapsed(state, groupId);
    expect(visibleStripTabIds(stripEntries(TABS, collapsed.byPane.p1))).toEqual(["t3", "t4"]);
    expect(visibleStripTabIds(stripEntries(TABS, state.byPane.p1))).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("orders groups by the strip's array order, which is what reorder moves", () => {
    const a = createTabGroup(emptyTabGroupState(), "p1", { label: "A", tabIds: ["t1"] });
    const b = createTabGroup(a.state, "p1", { label: "B", tabIds: ["t2"] });
    expect(b.state.byPane.p1.map((g) => g.label)).toEqual(["A", "B"]);
    const moved = reorderTabGroups(b.state, b.groupId, a.groupId);
    expect(moved.byPane.p1.map((g) => g.label)).toEqual(["B", "A"]);
    const entries = stripEntries(TABS, moved.byPane.p1);
    expect(entries.map((e) => (e.kind === "group" ? e.group.label : e.tabId))).toEqual([
      "B",
      "A",
      "t3",
      "t4",
    ]);
  });

  it("reorders to the end when there is nothing to land before", () => {
    const a = createTabGroup(emptyTabGroupState(), "p1", { label: "A", tabIds: ["t1"] });
    const b = createTabGroup(a.state, "p1", { label: "B", tabIds: ["t2"] });
    const moved = reorderTabGroups(b.state, a.groupId, null);
    expect(moved.byPane.p1.map((g) => g.label)).toEqual(["B", "A"]);
  });
});

describe("moving a whole group between pane groups", () => {
  /// Two panes, `g1` (the first, holding everything unclaimed) and `right`.
  function twoPanes() {
    const base = singleGroupLayout("g1");
    const { layout, newGroupId } = splitGroup(base, "g1", "row", "after");
    expect(newGroupId).not.toBeNull();
    return { layout, right: newGroupId! };
  }

  it("re-claims every member through the pane reducer", () => {
    const { layout, right } = twoPanes();
    const { state, groupId } = createTabGroup(emptyTabGroupState(), "g1", {
      label: "Review",
      tabIds: ["t1", "t2"],
    });

    const moved = moveTabGroupToPane(state, layout, groupId, right);

    const resolved = resolveGroupTabs(moved.layout, TABS);
    expect(resolved.get(right)).toEqual(["t1", "t2"]);
    expect(resolved.get("g1")).toEqual(["t3", "t4"]);
    expect(paneOfTabGroup(moved.state, groupId)).toBe(right);
    expect(findTabGroup(moved.state, groupId)?.tabIds).toEqual(["t1", "t2"]);
  });

  it("produces the same claims a per-tab move would", () => {
    const { layout, right } = twoPanes();
    const { state, groupId } = createTabGroup(emptyTabGroupState(), "g1", {
      tabIds: ["t1", "t2"],
    });
    const viaGroup = moveTabGroupToPane(state, layout, groupId, right).layout;
    let byHand: PaneNode = layout;
    byHand = moveTabToGroup(byHand, "t1", right, null);
    byHand = moveTabToGroup(byHand, "t2", right, null);
    expect(resolveGroupTabs(viaGroup, TABS)).toEqual(resolveGroupTabs(byHand, TABS));
  });

  it("is a no-op into its own pane or into a pane that does not exist", () => {
    const { layout } = twoPanes();
    const { state, groupId } = createTabGroup(emptyTabGroupState(), "g1", { tabIds: ["t1"] });
    expect(moveTabGroupToPane(state, layout, groupId, "g1").state).toBe(state);
    const nowhere = moveTabGroupToPane(state, layout, groupId, "nope");
    expect(nowhere.state).toBe(state);
    expect(nowhere.layout).toBe(layout);
  });
});

describe("pruning", () => {
  it("forgets closed tabs and the groups they emptied", () => {
    const { state, groupId } = withGroup();
    const after = pruneTabGroups(state, onePane(["t2", "t3"]));
    expect(findTabGroup(after, groupId)?.tabIds).toEqual(["t2"]);
    expect(pruneTabGroups(after, onePane(["t3"])).byPane).toEqual({});
  });

  it("drops groups on a pane that no longer exists", () => {
    const { state } = withGroup();
    expect(pruneTabGroups(state, new Map()).byPane).toEqual({});
  });

  it("drops a member that moved to another pane", () => {
    const { state, groupId } = withGroup();
    const after = pruneTabGroups(
      state,
      new Map<string, readonly string[]>([
        ["p1", ["t1", "t3"]],
        ["p2", ["t2"]],
      ]),
    );
    expect(findTabGroup(after, groupId)?.tabIds).toEqual(["t1"]);
  });

  it("returns its input by reference when nothing changed", () => {
    const { state } = withGroup();
    expect(pruneTabGroups(state, onePane())).toBe(state);
  });
});

describe("auto-grouping", () => {
  const KINDS: Record<string, string> = { t1: "terminal", t2: "terminal", t3: "browser" };
  const derivation = {
    key: (tabId: string) => KINDS[tabId] ?? null,
    label: (key: string) => key,
  };

  it("derives a read-only group per bucket", () => {
    const derived = deriveTabGroups(onePane(["t1", "t2", "t3"]), derivation);
    expect(derived.p1).toHaveLength(1);
    expect(derived.p1[0]).toMatchObject({
      label: "terminal",
      tabIds: ["t1", "t2"],
      derived: true,
    });
  });

  it("leaves a bucket of one ungrouped — a chip around a single tab is noise", () => {
    expect(deriveTabGroups(onePane(["t3"]), derivation)).toEqual({});
  });

  it("replaces the manual arrangement while a mode is on", () => {
    const { state } = withGroup();
    const auto = setAutoGroupMode(state, "kind");
    const effective = effectiveTabGroups(auto, onePane(["t1", "t2", "t3"]), derivation);
    expect(effective.p1.map((g) => g.label)).toEqual(["terminal"]);
  });

  it("materialises the derivation and drops back to off on a hand-edit", () => {
    const auto = setAutoGroupMode(emptyTabGroupState(), "kind");
    const manual = materializeAutoGroups(auto, onePane(["t1", "t2", "t3"]), derivation);
    expect(manual.mode).toBe("off");
    const group = allTabGroups(manual)[0];
    expect(group.derived).toBeUndefined();
    const renamed = renameTabGroup(manual, group.id, "Shells");
    expect(findTabGroup(renamed, group.id)?.label).toBe("Shells");
    expect(effectiveTabGroups(renamed, onePane(["t1", "t2", "t3"]), derivation).p1[0].label).toBe(
      "Shells",
    );
  });

  it("is a no-op to materialise a worktree that is already manual", () => {
    const { state } = withGroup();
    expect(materializeAutoGroups(state, onePane(), derivation)).toBe(state);
  });
});

describe("persistence", () => {
  it("round-trips serialize → JSON → parse", () => {
    const { state, groupId } = withGroup();
    const collapsed = toggleTabGroupCollapsed(recolorTabGroup(state, groupId, "chart-3"), groupId);
    const back = parseTabGroupState(
      JSON.parse(JSON.stringify(serializeTabGroupState(collapsed))),
    );
    expect(back).toEqual(collapsed);
  });

  it("does not persist a derivation — it is a function of the mode and the tabs", () => {
    const auto = setAutoGroupMode(withGroup().state, "kind");
    expect(serializeTabGroupState(auto)).toEqual({ mode: "kind", byPane: {} });
  });

  it("parses a malformed blob to null rather than half-applying it", () => {
    expect(parseTabGroupState(null)).toBeNull();
    expect(parseTabGroupState("nope")).toBeNull();
    expect(parseTabGroupState({ mode: "off" })).toBeNull();
    expect(parseTabGroupState({ mode: "off", byPane: { p1: "nope" } })).toBeNull();
    expect(
      parseTabGroupState({ mode: "off", byPane: { p1: [{ id: "a", label: "A" }] } }),
    ).toBeNull();
    expect(
      parseTabGroupState({
        mode: "off",
        byPane: { p1: [{ id: "a", label: "A", tabIds: ["t1", 7] }] },
      }),
    ).toBeNull();
  });

  it("rejects duplicate group ids and a tab claimed by two groups", () => {
    const dupeId = {
      mode: "off",
      byPane: {
        p1: [{ id: "a", label: "A", tabIds: ["t1"] }],
        p2: [{ id: "a", label: "B", tabIds: ["t2"] }],
      },
    };
    expect(parseTabGroupState(dupeId)).toBeNull();
    const dupeTab = {
      mode: "off",
      byPane: {
        p1: [
          { id: "a", label: "A", tabIds: ["t1"] },
          { id: "b", label: "B", tabIds: ["t1"] },
        ],
      },
    };
    expect(parseTabGroupState(dupeTab)).toBeNull();
  });

  it("defaults an unknown colour and an unknown mode rather than rejecting", () => {
    const parsed = parseTabGroupState({
      mode: "sideways",
      byPane: { p1: [{ id: "a", label: "A", color: "neon", tabIds: ["t1"] }] },
    });
    expect(parsed?.mode).toBe("off");
    expect(parsed?.byPane.p1[0].color).toBe("chart-1");
  });

  it("seeds the empty default for every worktree the blob misses or mangles", () => {
    const out = parseTabGroupStates({ "wt-a": "garbage" }, ["wt-a", "wt-b"]);
    expect(out["wt-a"]).toEqual(emptyTabGroupState());
    expect(out["wt-b"]).toEqual(emptyTabGroupState());
  });
});
