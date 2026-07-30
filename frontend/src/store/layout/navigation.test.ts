/// The two reducers behind `Ctrl+Tab` and back/forward.
///
/// Both are pure by design, so everything the workbench prompt's Wave 3
/// acceptance asks for — activation reorders the MRU, close removes, a held
/// modifier commits on release, back/forward crosses groups, no duplicate
/// consecutive entries, bounded length — is exercised here rather than through
/// a mounted component.
import { describe, expect, it } from "vitest";
import type { ActiveItem } from "./tabs";
import {
  NAV_HISTORY_LIMIT,
  canNavigateBack,
  canNavigateForward,
  emptyNavHistory,
  mruIndexAfter,
  mruOrder,
  parseGroupMru,
  parseNavHistory,
  pruneMru,
  pruneNav,
  pushNav,
  removeFromMru,
  stepNav,
  touchMru,
  type NavEntry,
  type NavHistory,
} from "./navigation";

const term = (id: string): ActiveItem => ({ type: "terminal", id });

function entry(groupId: string | null, id: string, line?: number): NavEntry {
  return { groupId, item: term(id), ...(line === undefined ? {} : { line }) };
}

describe("tab MRU", () => {
  it("puts the activated tab at the front", () => {
    expect(touchMru(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("is a no-op when the tab is already in front", () => {
    const list = ["a", "b"];
    expect(touchMru(list, "a")).toBe(list);
  });

  it("adds a tab it has never seen", () => {
    expect(touchMru(["a"], "z")).toEqual(["z", "a"]);
  });

  it("removes a closed tab", () => {
    expect(removeFromMru(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("returns the same list when there is nothing to remove", () => {
    const list = ["a", "b"];
    expect(removeFromMru(list, "zz")).toBe(list);
  });

  it("prunes entries whose tabs are gone, keeping order", () => {
    expect(pruneMru(["c", "a", "b"], ["a", "c"])).toEqual(["c", "a"]);
  });

  it("prunes to the same reference when every entry is live", () => {
    const list = ["a", "b"];
    expect(pruneMru(list, ["b", "a", "c"])).toBe(list);
  });

  describe("candidate order", () => {
    it("is recency first, then untouched tabs in strip order", () => {
      expect(mruOrder(["c", "a"], ["a", "b", "c", "d"])).toEqual(["c", "a", "b", "d"]);
    });

    it("ignores recency for tabs that belong to another group", () => {
      expect(mruOrder(["x", "c"], ["a", "c"])).toEqual(["c", "a"]);
    });

    it("still cycles a group whose tabs have never been activated", () => {
      expect(mruOrder([], ["a", "b"])).toEqual(["a", "b"]);
    });
  });

  describe("cycling with a held modifier", () => {
    // One press of Ctrl+Tab is one step from the tab you are on, which sits at
    // index 0 of a freshly built order. Releasing commits whatever index the
    // presses accumulated to.
    const order = () => mruOrder(["a", "b", "c"], ["a", "b", "c"]);

    it("commits the previously-used tab after one press", () => {
      const list = order();
      expect(list[mruIndexAfter(list.length, 1)]).toBe("b");
    });

    it("walks further while the modifier is still down", () => {
      const list = order();
      expect(list[mruIndexAfter(list.length, 2)]).toBe("c");
    });

    it("wraps in both directions", () => {
      const list = order();
      expect(list[mruIndexAfter(list.length, 3)]).toBe("a");
      expect(list[mruIndexAfter(list.length, -1)]).toBe("c");
    });

    it("reorders on commit, so the next cycle starts from the new tab", () => {
      const list = order();
      const committed = list[mruIndexAfter(list.length, 1)];
      const after = touchMru(["a", "b", "c"], committed);
      expect(after).toEqual(["b", "a", "c"]);
      // And cycling again from there returns to where you came from — the
      // alt-tab property that makes the chord useful for two-file work.
      const next = mruOrder(after, ["a", "b", "c"]);
      expect(next[mruIndexAfter(next.length, 1)]).toBe("a");
    });

    it("has nothing to commit in a group with a single tab", () => {
      const list = mruOrder(["a"], ["a"]);
      expect(list[mruIndexAfter(list.length, 1)]).toBe("a");
    });
  });
});

describe("navigation history", () => {
  it("starts empty and refuses to move", () => {
    const h = emptyNavHistory();
    expect(canNavigateBack(h)).toBe(false);
    expect(canNavigateForward(h)).toBe(false);
    expect(stepNav(h, -1).entry).toBeNull();
  });

  it("records visits in order", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g1", "b"));
    expect(h.entries.map((e) => e.item.id)).toEqual(["a", "b"]);
    expect(h.index).toBe(1);
  });

  it("collapses a duplicate consecutive entry", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g1", "a"));
    h = pushNav(h, entry("g1", "a"));
    expect(h.entries).toHaveLength(1);
  });

  it("treats the same tab in a different group as a different place", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g2", "a"));
    expect(h.entries).toHaveLength(2);
  });

  it("treats a different line in the same file as a different place", () => {
    let h = pushNav(emptyNavHistory(), entry(null, "f", 10));
    h = pushNav(h, entry(null, "f", 40));
    expect(h.entries).toHaveLength(2);
  });

  it("goes back and forward across groups", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g2", "b"));
    h = pushNav(h, entry("g1", "c"));

    const back1 = stepNav(h, -1);
    expect(back1.entry?.item.id).toBe("b");
    expect(back1.entry?.groupId).toBe("g2");

    const back2 = stepNav(back1.history, -1);
    expect(back2.entry?.item.id).toBe("a");
    expect(canNavigateBack(back2.history)).toBe(false);
    expect(stepNav(back2.history, -1).entry).toBeNull();

    const fwd = stepNav(back2.history, 1);
    expect(fwd.entry?.item.id).toBe("b");
    expect(canNavigateForward(fwd.history)).toBe(true);
  });

  it("re-reporting the entry a back step landed on does not push a duplicate", () => {
    // This is what makes back/forward work without a suppression flag: the
    // activation the back step causes reports the same place it just moved to.
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g1", "b"));
    const back = stepNav(h, -1);
    const after = pushNav(back.history, entry("g1", "a"));
    expect(after).toBe(back.history);
    expect(canNavigateForward(after)).toBe(true);
  });

  it("truncates the forward tail when a new place is visited after going back", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g1", "b"));
    h = pushNav(h, entry("g1", "c"));
    const back = stepNav(h, -1);
    const next = pushNav(back.history, entry("g1", "d"));
    expect(next.entries.map((e) => e.item.id)).toEqual(["a", "b", "d"]);
    expect(canNavigateForward(next)).toBe(false);
  });

  it("is bounded, dropping the oldest entries", () => {
    let h = emptyNavHistory();
    for (let i = 0; i < NAV_HISTORY_LIMIT + 20; i++) {
      h = pushNav(h, entry("g1", `t${i}`));
    }
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(h.index).toBe(NAV_HISTORY_LIMIT - 1);
    expect(h.entries[0].item.id).toBe("t20");
  });

  it("prunes entries for closed tabs and keeps the cursor in range", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, entry("g1", "b"));
    h = pushNav(h, entry("g1", "c"));
    const pruned = pruneNav(h, ["a", "c"]);
    expect(pruned.entries.map((e) => e.item.id)).toEqual(["a", "c"]);
    expect(pruned.index).toBe(1);
  });

  it("prunes to the same reference when everything is live", () => {
    const h = pushNav(emptyNavHistory(), entry("g1", "a"));
    expect(pruneNav(h, ["a"])).toBe(h);
  });

  it("empties out when every target is gone", () => {
    const h = pushNav(emptyNavHistory(), entry("g1", "a"));
    expect(pruneNav(h, [])).toEqual(emptyNavHistory());
  });
});

describe("persistence", () => {
  it("round-trips a history through JSON", () => {
    let h = pushNav(emptyNavHistory(), entry("g1", "a"));
    h = pushNav(h, { groupId: null, item: { type: "file", id: "f", path: "/x.ts" }, line: 12 });
    const back = stepNav(h, -1).history;
    const parsed = parseNavHistory(JSON.parse(JSON.stringify(back)) as unknown);
    expect(parsed).toEqual(back);
  });

  it("drops a malformed row rather than the whole history", () => {
    const parsed = parseNavHistory({
      entries: [
        { groupId: "g1", item: { type: "terminal", id: "a" } },
        { groupId: "g1", item: { type: "nope", id: "b" } },
        { groupId: "g1", item: { type: "file", id: "c" } },
      ],
      index: 2,
    });
    expect(parsed.entries.map((e) => e.item.id)).toEqual(["a"]);
    expect(parsed.index).toBe(0);
  });

  it("keeps a persisted pointer at an agent thread", () => {
    // Agent tabs are navigable peers of terminals, so back/forward has to
    // survive a reload pointed at one rather than silently dropping the row.
    const parsed = parseNavHistory({
      entries: [{ groupId: "g1", item: { type: "agent", id: "a1" } }],
      index: 0,
    });
    expect(parsed.entries.map((e) => e.item.type)).toEqual(["agent"]);
  });

  it("clamps an out-of-range stored cursor", () => {
    const parsed: NavHistory = parseNavHistory({
      entries: [{ groupId: null, item: { type: "terminal", id: "a" } }],
      index: 99,
    });
    expect(parsed.index).toBe(0);
  });

  it("falls back to an empty history for a corrupt blob", () => {
    expect(parseNavHistory("nonsense")).toEqual(emptyNavHistory());
    expect(parseNavHistory(null)).toEqual(emptyNavHistory());
  });

  it("keeps only string ids in a persisted MRU list", () => {
    expect(parseGroupMru({ g1: ["a", 3, "b"], g2: "nope" })).toEqual({ g1: ["a", "b"] });
  });
});
