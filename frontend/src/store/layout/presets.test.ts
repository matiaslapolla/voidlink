/// Named layout presets.
///
/// The property the whole feature turns on is the degrade: a preset applied to
/// a worktree that is missing half the tabs it names must place what exists,
/// keep the geometry, and never throw. An arrangement that half-fits is still
/// an arrangement.
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyLayoutPreset,
  captureLayoutPreset,
  parsePreset,
  presetsFor,
  removePreset,
  renamePreset,
  resetPresetsForTest,
  upsertPreset,
} from "./presets";
import {
  groupCount,
  groupList,
  moveTabToGroup,
  resolveGroupTabs,
  setGroupActiveTab,
  singleGroupLayout,
  splitGroup,
  type PaneNode,
} from "./panes";
import { createTabGroup, emptyTabGroupState } from "./tabGroups";
import { PANEL_BOUNDS, type PanelWidths } from "./prefs";

const PANELS: PanelWidths = {
  rail: 200,
  sidebar: 300,
  gitSidebar: 400,
  sidebarTerminalsHeight: 180,
  sidebarAgentsHeight: 220,
};

/// Two panes: `g1` holds t1 and t2, `right` holds t3 and t4, and t1/t2 are in a
/// tab group called Review.
function arrangement() {
  const base = singleGroupLayout("g1");
  const { layout: split, newGroupId } = splitGroup(base, "g1", "row", "after");
  const right = newGroupId!;
  let layout: PaneNode = split;
  layout = moveTabToGroup(layout, "t3", right, null);
  layout = moveTabToGroup(layout, "t4", right, null);
  layout = setGroupActiveTab(layout, "g1", "t2");
  const { state } = createTabGroup(emptyTabGroupState(), "g1", {
    label: "Review",
    tabIds: ["t1", "t2"],
  });
  return { layout, right, tabGroups: state };
}

beforeEach(() => resetPresetsForTest());

describe("capturing", () => {
  it("captures the tree, the groups, the front tabs and the panel widths", () => {
    const { layout, tabGroups } = arrangement();
    const preset = captureLayoutPreset("Review", layout, tabGroups, PANELS)!;
    expect(preset.name).toBe("Review");
    expect(preset.panels).toEqual(PANELS);
    // Per-group front tabs ride inside the tree rather than in a second field.
    const back = applyLayoutPreset(preset, ["t1", "t2", "t3", "t4"]);
    expect(groupList(back.layout).find((g) => g.id === "g1")?.activeTabId).toBe("t2");
  });

  it("refuses a blank name rather than saving an unfindable preset", () => {
    const { layout, tabGroups } = arrangement();
    expect(captureLayoutPreset("   ", layout, tabGroups, PANELS)).toBeNull();
  });
});

describe("applying", () => {
  it("round-trips an arrangement whose tabs are all open", () => {
    const { layout, right, tabGroups } = arrangement();
    const preset = captureLayoutPreset("Review", layout, tabGroups, PANELS)!;
    const applied = applyLayoutPreset(preset, ["t1", "t2", "t3", "t4"]);
    expect(resolveGroupTabs(applied.layout, ["t1", "t2", "t3", "t4"])).toEqual(
      resolveGroupTabs(layout, ["t1", "t2", "t3", "t4"]),
    );
    expect(applied.tabGroups.byPane.g1[0].label).toBe("Review");
    expect(applied.tabGroups.byPane.g1[0].tabIds).toEqual(["t1", "t2"]);
    expect(groupCount(applied.layout)).toBe(2);
    expect(right).toBeTruthy();
  });

  /// The acceptance case: half the referenced tabs are gone.
  it("places what exists, keeps the geometry, and does not throw", () => {
    const { layout, right, tabGroups } = arrangement();
    const preset = captureLayoutPreset("Review", layout, tabGroups, PANELS)!;

    const applied = applyLayoutPreset(preset, ["t1", "t3"]);

    // Both panes still exist — the arrangement is the point, not its contents.
    expect(groupCount(applied.layout)).toBe(2);
    const resolved = resolveGroupTabs(applied.layout, ["t1", "t3"]);
    expect(resolved.get("g1")).toEqual(["t1"]);
    expect(resolved.get(right)).toEqual(["t3"]);
    // The group survives with its one live member; the dead id leaves no ghost.
    expect(applied.tabGroups.byPane.g1[0].tabIds).toEqual(["t1"]);
  });

  it("drops a group whose every member is gone", () => {
    const { layout, tabGroups } = arrangement();
    const preset = captureLayoutPreset("Review", layout, tabGroups, PANELS)!;
    const applied = applyLayoutPreset(preset, ["t3", "t4"]);
    expect(applied.tabGroups.byPane).toEqual({});
    expect(groupCount(applied.layout)).toBe(2);
  });

  it("places nothing at all, rather than failing, into an empty worktree", () => {
    const { layout, tabGroups } = arrangement();
    const preset = captureLayoutPreset("Review", layout, tabGroups, PANELS)!;
    const applied = applyLayoutPreset(preset, []);
    expect(groupCount(applied.layout)).toBe(2);
    expect(applied.tabGroups.byPane).toEqual({});
  });

  it("falls back to the single-group default on a corrupt tree", () => {
    const applied = applyLayoutPreset(
      { version: 1, name: "x", savedAt: 0, panes: "nope", tabGroups: null, panels: PANELS },
      ["t1"],
    );
    expect(groupCount(applied.layout)).toBe(1);
  });

  it("clamps panel widths a hand-edited preset put out of bounds", () => {
    const applied = applyLayoutPreset(
      {
        version: 1,
        name: "x",
        savedAt: 0,
        panes: null,
        tabGroups: null,
        panels: {
          rail: 9999,
          sidebar: -5,
          gitSidebar: Number.NaN,
          sidebarTerminalsHeight: 180,
          sidebarAgentsHeight: 220,
        } as PanelWidths,
      },
      [],
    );
    expect(applied.panels.rail).toBe(PANEL_BOUNDS.rail.max);
    expect(applied.panels.sidebar).toBe(PANEL_BOUNDS.sidebar.min);
    expect(applied.panels.gitSidebar).toBe(PANEL_BOUNDS.gitSidebar.default);
  });
});

describe("the preset list", () => {
  const save = (name: string, savedAt = 1) => {
    const { layout, tabGroups } = arrangement();
    const preset = captureLayoutPreset(name, layout, tabGroups, PANELS)!;
    upsertPreset("ws-1", { ...preset, savedAt });
  };

  it("upserts by name so re-saving updates rather than duplicates", () => {
    save("Review", 1);
    save("Review", 2);
    expect(presetsFor("ws-1")).toHaveLength(1);
    expect(presetsFor("ws-1")[0].savedAt).toBe(2);
  });

  it("is per workspace", () => {
    save("Review");
    expect(presetsFor("ws-2")).toEqual([]);
  });

  it("renames in place, keeping savedAt", () => {
    save("Review", 7);
    expect(renamePreset("ws-1", "Review", "  Shipping  ")).toBe("ok");
    expect(presetsFor("ws-1")[0]).toMatchObject({ name: "Shipping", savedAt: 7 });
    expect(renamePreset("ws-1", "Nope", "x")).toBe("not-found");
    expect(renamePreset("ws-1", "Shipping", "  ")).toBe("empty-name");
    save("Other", 1);
    expect(renamePreset("ws-1", "Other", "Shipping")).toBe("duplicate");
  });

  it("deletes", () => {
    save("Review");
    removePreset("ws-1", "Review");
    expect(presetsFor("ws-1")).toEqual([]);
  });

  it("drops a stored preset too broken to name", () => {
    expect(parsePreset(null)).toBeNull();
    expect(parsePreset({ savedAt: 1 })).toBeNull();
    expect(parsePreset({ name: "" })).toBeNull();
    expect(parsePreset({ name: "ok" })?.panels).toEqual({
      rail: PANEL_BOUNDS.rail.default,
      sidebar: PANEL_BOUNDS.sidebar.default,
      gitSidebar: PANEL_BOUNDS.gitSidebar.default,
      sidebarTerminalsHeight: PANEL_BOUNDS.sidebarTerminalsHeight.default,
      sidebarAgentsHeight: PANEL_BOUNDS.sidebarAgentsHeight.default,
    });
  });
});
