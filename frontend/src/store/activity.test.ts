import { beforeEach, describe, expect, it } from "vitest";
import type { ActivitySignal } from "@/components/layout/StatusLed";
import {
  acknowledgeTab,
  clearTabActivity,
  escalate,
  noteBell,
  noteFinished,
  noteRunning,
  noteWorking,
  resetActivity,
  setVisibleTabs,
  setWindowFocused,
  signalsOf,
  tabMark,
} from "./activity";

const sig = (m: Record<string, ActivitySignal[]>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, v as readonly ActivitySignal[]]));
const groups = (m: Record<string, string[]>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, v as readonly string[]]));

beforeEach(() => resetActivity());

describe("the signal registry", () => {
  it("raises and clears the terminal events independently", () => {
    setVisibleTabs([]);
    // A bell is a `notify` — cyan, and above `working` in precedence. That
    // ordering is the point: it used to be `bell`, below `running`, so a
    // notification from inside a live TUI could never render.
    noteBell("t1");
    expect(signalsOf("t1")).toEqual(["notify"]);

    noteWorking("t1", true);
    expect(new Set(signalsOf("t1"))).toEqual(new Set(["notify", "working"]));
    expect(tabMark("t1")).toBe("notify");

    // A completion the user missed is the same news as a bell, so it lands on
    // the same mark rather than a second, differently-coloured one.
    noteFinished("t1", true);
    expect(signalsOf("t1")).toEqual(["notify"]);
  });

  /// MASTER §7.5.3 rule 2 applied through the store rather than through
  /// `highestSignal` directly: a tab carrying several signals shows exactly
  /// one mark, and it is the failure.
  it("shows one mark, the highest, when a tab carries several", () => {
    setVisibleTabs([]);
    noteBell("t1");
    noteWorking("t1", true);
    noteFinished("t1", false);
    expect(signalsOf("t1")).toContain("failed");
    expect(tabMark("t1")).toBe("failed");
    // Even with a dirty buffer folded in — the case a "last signal wins"
    // implementation gets backwards.
    expect(tabMark("t1", "dirty")).toBe("failed");
  });

  it("does not raise notify for work the user watched happen", () => {
    setVisibleTabs(["t1"]);
    noteWorking("t1", true);
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

  /// §7.5.3: notify and finished clear on focus; failed never does. Glancing at
  /// a pane is not the same as having read the error in it.
  it("clears notify and finished on focus but never failed", () => {
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
    const out = escalate({ ...base, tabSignals: sig({ a1: ["notify"] }) });
    expect(out.groups.has("A")).toBe(false);
    expect(out.statusBar).toBeNull();
  });

  it("aggregates a group's tabs to one mark, the highest", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ b1: ["finished"], b2: ["working", "dirty"] }),
    });
    expect(out.groups.get("B")).toBe("working");
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
      tabSignals: sig({ a1: ["notify"], b1: ["finished"] }),
      zen: true,
    });
    expect(out.groups.size).toBe(0);
    expect(out.statusBar?.signal).toBe("notify");
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
      tabSignals: sig({ b1: ["finished"], b2: ["working"] }),
      collapsedTabGroups: new Map([["tg1", { paneGroupId: "B", tabIds: ["b1", "b2"] }]]),
    });
    expect(out.tabGroups.get("tg1")).toBe("working");
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

/// A tab can be on screen and still not be *seen*: the OS window it lives in may
/// be behind something else. `visible` alone conflated the two, so a bell in the
/// front tab of a backgrounded window was dropped rather than badged — the one
/// case §7.5.3 rule 1 exists for.
describe("OS window focus", () => {
  it("badges a bell in the front tab of an unfocused window", () => {
    setVisibleTabs(["t1"]);
    setWindowFocused(false);
    noteBell("t1");
    expect(signalsOf("t1")).toEqual(["notify"]);
  });

  it("still suppresses a bell in the front tab of the focused window", () => {
    setVisibleTabs(["t1"]);
    setWindowFocused(true);
    noteBell("t1");
    expect(signalsOf("t1")).toEqual([]);
  });

  it("clears on the window coming back, not only on a tab switch", () => {
    setVisibleTabs(["t1"]);
    setWindowFocused(false);
    noteBell("t1");
    expect(signalsOf("t1")).toEqual(["notify"]);

    // Alt-tabbing back is the same act of seeing as bringing the tab forward.
    setWindowFocused(true);
    expect(signalsOf("t1")).toEqual([]);
  });

  it("does not clear a failure when the window comes back", () => {
    setVisibleTabs(["t1"]);
    setWindowFocused(false);
    noteFinished("t1", false);
    setWindowFocused(true);
    expect(signalsOf("t1")).toEqual(["failed"]);
  });
});

/// `noteRunning` (VoidLink fetching something for a tab) and `noteWorking` (the
/// user's own shell) are separate signals in separate hues. Clearing one must not
/// clear the other.
describe("running versus working", () => {
  it("keeps them independent", () => {
    setVisibleTabs([]);
    noteRunning("t1", true);
    noteWorking("t1", true);
    expect(new Set(signalsOf("t1"))).toEqual(new Set(["running", "working"]));
    noteWorking("t1", false);
    expect(signalsOf("t1")).toEqual(["running"]);
  });
});

/// §7.5.3 rule 1 one container up.
///
/// The violation this closes is not "the mark went to the wrong surface" — it
/// is that the mark went **nowhere**. `groupTabs` only ever describes the
/// worktree on screen, because that is the only one with a pane tree, so a
/// signal in any other worktree matched no group, fell out of every branch, and
/// reached no surface at all. It went unnoticed because until agents ran in
/// several worktrees at once, nothing ever signalled outside the one being
/// looked at.
describe("escalate across worktrees", () => {
  const base = {
    groupTabs: groups({ A: ["a1"] }),
    visibleGroupIds: new Set(["A"]),
    focusedGroupId: "A",
    zen: false,
    activeWorktreeId: "wt-main",
    tabWorktree: new Map([
      ["a1", "wt-main"],
      ["x1", "wt-feature"],
      ["x2", "wt-feature"],
      ["y1", "wt-hotfix"],
    ]),
  };

  it("marks the rail row of a worktree the user is not in", () => {
    const out = escalate({ ...base, tabSignals: sig({ x1: ["failed"] }) });
    expect(out.worktrees.get("wt-feature")).toBe("failed");
  });

  /// The regression guard for the actual bug: before the worktree axis existed
  /// this signal produced an empty `groups`, a null `statusBar`, and nothing
  /// else — three empty answers and no fourth place to look.
  it("does not silently drop a signal that belongs to no rendered group", () => {
    const out = escalate({ ...base, tabSignals: sig({ x1: ["failed"] }) });
    expect(out.groups.size).toBe(0);
    expect(out.statusBar).toBeNull();
    expect(out.worktrees.size).toBe(1);
  });

  it("aggregates a worktree's tabs to the highest single mark", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ x1: ["finished"], x2: ["failed"] }),
    });
    expect(out.worktrees.get("wt-feature")).toBe("failed");
  });

  it("keeps two worktrees apart", () => {
    const out = escalate({
      ...base,
      tabSignals: sig({ x1: ["working"], y1: ["failed"] }),
    });
    expect(out.worktrees.get("wt-feature")).toBe("working");
    expect(out.worktrees.get("wt-hotfix")).toBe("failed");
  });

  /// The active worktree's signals are already resolved by the tab, header and
  /// status-bar rules. A rail dot repeating them would be a fourth surface
  /// saying what three already say.
  it("never marks the worktree that is on screen", () => {
    const out = escalate({ ...base, tabSignals: sig({ a1: ["failed"] }) });
    expect(out.worktrees.size).toBe(0);
  });

  /// A tab that closed between the snapshot and the call has no worktree. A
  /// mark for a pane that no longer exists would escalate forever with nowhere
  /// to send the user.
  it("drops a signal from a tab with no known worktree", () => {
    const out = escalate({ ...base, tabSignals: sig({ ghost: ["failed"] }) });
    expect(out.worktrees.size).toBe(0);
  });

  it("does nothing when the caller has one worktree and passes no map", () => {
    const out = escalate({
      groupTabs: groups({ A: ["a1"] }),
      visibleGroupIds: new Set(["A"]),
      focusedGroupId: null,
      zen: false,
      tabSignals: sig({ a1: ["failed"] }),
    });
    expect(out.worktrees.size).toBe(0);
    expect(out.worktreeStatusBar).toBeNull();
  });

  describe("the status-bar half", () => {
    /// With the rail up, the rail is the right home — MASTER §7.6 is explicit
    /// that a chip duplicating a visible surface is a dead affordance.
    it("stays silent while the rail is on screen", () => {
      const out = escalate({ ...base, tabSignals: sig({ x1: ["failed"] }) });
      expect(out.worktrees.get("wt-feature")).toBe("failed");
      expect(out.worktreeStatusBar).toBeNull();
    });

    /// Zen hides the rail, and then the status bar is the only surface left.
    /// This is the case that makes the segment mandatory rather than
    /// decorative.
    it("carries the mark under zen, naming the worktrees", () => {
      const out = escalate({
        ...base,
        zen: true,
        tabSignals: sig({ x1: ["failed"], y1: ["working"] }),
      });
      expect(out.worktreeStatusBar?.signal).toBe("failed");
      expect(new Set(out.worktreeStatusBar?.worktreeIds)).toEqual(
        new Set(["wt-feature", "wt-hotfix"]),
      );
    });

    /// Passed explicitly so a future focus mode that also hides the rail does
    /// not silently strand the mark.
    it("honours an explicit railVisible over the zen default", () => {
      const out = escalate({
        ...base,
        railVisible: false,
        tabSignals: sig({ x1: ["notify"] }),
      });
      expect(out.worktreeStatusBar?.signal).toBe("notify");
    });
  });
});
