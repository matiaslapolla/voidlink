import { beforeEach, describe, expect, it } from "vitest";
import type { ActivitySignal } from "@/components/layout/StatusLed";
import {
  acknowledgeTab,
  clearTabActivity,
  escalate,
  noteBell,
  noteFinished,
  noteRunning,
  resetActivity,
  setVisibleTabs,
  signalsOf,
  tabMark,
} from "./activity";

const sig = (m: Record<string, ActivitySignal[]>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, v as readonly ActivitySignal[]]));
const groups = (m: Record<string, string[]>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, v as readonly string[]]));

beforeEach(() => resetActivity());

describe("the signal registry", () => {
  it("raises and clears the three terminal events independently", () => {
    setVisibleTabs([]);
    noteBell("t1");
    expect(signalsOf("t1")).toEqual(["bell"]);

    noteRunning("t1", true);
    expect(new Set(signalsOf("t1"))).toEqual(new Set(["bell", "running"]));

    noteFinished("t1", true);
    expect(new Set(signalsOf("t1"))).toEqual(new Set(["bell", "finished"]));
  });

  /// MASTER §7.5.3 rule 2 applied through the store rather than through
  /// `highestSignal` directly: a tab carrying several signals shows exactly
  /// one mark, and it is the failure.
  it("shows one mark, the highest, when a tab carries several", () => {
    setVisibleTabs([]);
    noteBell("t1");
    noteRunning("t1", true);
    noteFinished("t1", false);
    expect(signalsOf("t1")).toContain("failed");
    expect(tabMark("t1")).toBe("failed");
    // Even with a dirty buffer folded in — the case a "last signal wins"
    // implementation gets backwards.
    expect(tabMark("t1", "dirty")).toBe("failed");
  });

  it("does not raise finished for work the user watched happen", () => {
    setVisibleTabs(["t1"]);
    noteRunning("t1", true);
    noteFinished("t1", true);
    expect(signalsOf("t1")).toEqual([]);
  });

  it("does raise failed for work the user watched happen", () => {
    setVisibleTabs(["t1"]);
    noteFinished("t1", false);
    expect(signalsOf("t1")).toEqual(["failed"]);
  });

  it("suppresses a bell in a pane the user is already looking at", () => {
    setVisibleTabs(["t1"]);
    noteBell("t1");
    expect(signalsOf("t1")).toEqual([]);
  });

  /// §7.5.3: bell and finished clear on focus; failed never does. Glancing at
  /// a pane is not the same as having read the error in it.
  it("clears bell and finished on focus but never failed", () => {
    setVisibleTabs([]);
    noteBell("t1");
    noteFinished("t1", true);
    noteFinished("t2", false);
    setVisibleTabs(["t1", "t2"]);
    expect(signalsOf("t1")).toEqual([]);
    expect(signalsOf("t2")).toEqual(["failed"]);
    acknowledgeTab("t2");
    expect(signalsOf("t2")).toEqual([]);
  });

  it("drops everything a closed tab was signalling", () => {
    setVisibleTabs([]);
    noteFinished("t1", false);
    clearTabActivity("t1");
    expect(signalsOf("t1")).toEqual([]);
  });
});

/// The load-bearing requirement of the whole wave: a user must never have to
/// open a pane to learn something happened in it (§7.5.3 rule 1).
describe("escalate", () => {
  const base = {
    groupTabs: groups({ A: ["a1"], B: ["b1", "b2"] }),
    visibleGroupIds: new Set(["A", "B"]),
    focusedGroupId: "A",
    zen: false,
  };

  it("escalates a signal in a background group to that group's header", () => {
    const out = escalate({ ...base, tabSignals: sig({ b1: ["failed"] }) });
    expect(out.groups.get("B")).toBe("failed");
    expect(out.statusBar).toBeNull();
  });

  it("does not mark the focused group's own header", () => {
    const out = escalate({ ...base, tabSignals: sig({ a1: ["bell"] }) });
    expect(out.groups.has("A")).toBe(false);
    expect(out.statusBar).toBeNull();
  });

  it("aggregates a group's tabs to one mark, the highest", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ b1: ["finished"], b2: ["running", "dirty"] }),
    });
    expect(out.groups.get("B")).toBe("running");
  });

  /// The acceptance test spelled out in the prompt: with B maximized away, a
  /// failure in B has no header to land on and must reach the status bar.
  it("escalates past a maximized sibling to the status bar", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ b1: ["failed"] }),
      visibleGroupIds: new Set(["A"]),
    });
    expect(out.groups.has("B")).toBe(false);
    expect(out.statusBar).toEqual({ signal: "failed", tabIds: ["b1"] });
  });

  /// Zen renders no tab strips at all, so there is no header slot anywhere —
  /// even for a group whose pane body is still on screen.
  it("escalates every group to the status bar under zen", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ a1: ["bell"], b1: ["finished"] }),
      zen: true,
    });
    expect(out.groups.size).toBe(0);
    expect(out.statusBar?.signal).toBe("bell");
    expect(out.statusBar?.tabIds.sort()).toEqual(["a1", "b1"]);
  });

  /// A collapsed tab group renders none of its members, so it is a new place
  /// for a signal to die in. The chip is the finer stop; the status bar is
  /// still the last one.
  it("escalates a signal inside a collapsed tab group to the group chip", () => {
    const out = escalate({
      ...base,
      focusedGroupId: "B",
      tabSignals: sig({ b1: ["failed"] }),
      collapsedTabGroups: new Map([["tg1", { paneGroupId: "B", tabIds: ["b1", "b2"] }]]),
    });
    expect(out.tabGroups.get("tg1")).toBe("failed");
    expect(out.statusBar).toBeNull();
  });

  it("marks an expanded group's chip with nothing — its tabs wear their own", () => {
    const out = escalate({ ...base, tabSignals: sig({ b1: ["failed"] }) });
    expect(out.tabGroups.size).toBe(0);
  });

  /// The same tab, same collapsed group, in a pane that is maximized away:
  /// the chip is off screen too, so the status bar still has to carry it.
  it("still reaches the status bar when the collapsed group's pane is hidden", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ b1: ["failed"] }),
      visibleGroupIds: new Set(["A"]),
      collapsedTabGroups: new Map([["tg1", { paneGroupId: "B", tabIds: ["b1", "b2"] }]]),
    });
    expect(out.tabGroups.size).toBe(0);
    expect(out.statusBar).toEqual({ signal: "failed", tabIds: ["b1"] });
  });

  it("gives a collapsed chip one mark, the highest of its hidden members", () => {
    const out = escalate({
      ...base,
      focusedGroupId: "B",
      tabSignals: sig({ b1: ["finished"], b2: ["running"] }),
      collapsedTabGroups: new Map([["tg1", { paneGroupId: "B", tabIds: ["b1", "b2"] }]]),
    });
    expect(out.tabGroups.get("tg1")).toBe("running");
  });

  it("reports nothing when nothing is signalling", () => {
    const out = escalate({ ...base, tabSignals: sig({}) });
    expect(out.groups.size).toBe(0);
    expect(out.statusBar).toBeNull();
  });

  it("takes the highest signal across every hidden group for the status bar", () => {
    const out = escalate({
      ...base,
      groupTabs: groups({ A: ["a1"], B: ["b1"], C: ["c1"] }),
      tabSignals: sig({ b1: ["finished"], c1: ["failed"] }),
      visibleGroupIds: new Set(["A"]),
    });
    expect(out.statusBar?.signal).toBe("failed");
    expect(out.statusBar?.tabIds.sort()).toEqual(["b1", "c1"]);
  });
});
