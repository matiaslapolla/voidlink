/// The dock model and its two migrations.
///
/// `sidebarsSwapped` was a boolean two builds of users have in localStorage,
/// and `files` was the explorer's id before the sidebar grew from three ids to
/// five. So the interesting cases here are all about a blob written by *some
/// other* build: an old one that only has the boolean, one that has `files`
/// but not `explorer`, this one, and a future one that docks a sixth panel
/// this build has never heard of. None of them may throw, and none of them may
/// lose an arrangement the user set.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCK_ORDER,
  DEFAULT_DOCK_SIDE,
  SWAPPED_DOCK_SIDE,
  mirrorArrangement,
  moveInDockOrder,
  parseDetachedSidebars,
  parseDockOrder,
  parseDockSide,
  sidebarsOnSide,
  slotOrder,
  type SidebarId,
} from "./dock";

describe("parseDockSide", () => {
  it("maps sidebarsSwapped:true to the arrangement it produced", () => {
    // The old flag swapped the two sidebar slots and never touched the rail,
    // so a swapped layout was rail, git, workbench, explorer (with terminals
    // and agents following the explorer — they used to be stacked inside it).
    expect(parseDockSide(undefined, true)).toEqual(SWAPPED_DOCK_SIDE);
    expect(parseDockSide(undefined, true)).toMatchObject({
      workspaces: "left",
      git: "left",
      explorer: "right",
      terminals: "right",
      agents: "right",
    });
  });

  it("maps sidebarsSwapped:false — and a blob with neither — to the default", () => {
    expect(parseDockSide(undefined, false)).toEqual(DEFAULT_DOCK_SIDE);
    expect(parseDockSide(undefined, undefined)).toEqual(DEFAULT_DOCK_SIDE);
    expect(parseDockSide(null, null)).toEqual(DEFAULT_DOCK_SIDE);
  });

  it("leaves a blob already in the new shape alone, and is idempotent", () => {
    const saved = {
      workspaces: "right",
      explorer: "right",
      terminals: "right",
      git: "left",
      agents: "left",
    } as const;
    const once = parseDockSide(saved);
    expect(once).toEqual(saved);
    expect(parseDockSide(once)).toEqual(saved);
    // Even with a stale boolean still sitting beside it: the new field wins,
    // which is what makes re-hydrating a blob this build wrote a no-op.
    expect(parseDockSide(saved, true)).toEqual(saved);
  });

  it("drops an unknown sidebar id without throwing", () => {
    const parsed = parseDockSide({ explorer: "right", panegroup: "left", 7: "left" });
    expect(parsed).toEqual({ ...DEFAULT_DOCK_SIDE, explorer: "right" });
    expect("panegroup" in parsed).toBe(false);
  });

  it("drops a side the shell has no branch for", () => {
    expect(parseDockSide({ git: "top", explorer: "right" })).toEqual({
      ...DEFAULT_DOCK_SIDE,
      explorer: "right",
    });
  });

  it("survives a blob of the wrong type entirely", () => {
    for (const junk of ["swapped", 3, [], true]) {
      expect(parseDockSide(junk)).toEqual(DEFAULT_DOCK_SIDE);
    }
  });

  it("hands out its own record rather than the module-level default", () => {
    const a = parseDockSide(undefined);
    expect(a).not.toBe(DEFAULT_DOCK_SIDE);
    a.explorer = "right";
    expect(DEFAULT_DOCK_SIDE.explorer).toBe("left");
  });

  // ── The `files` → `explorer` migration ────────────────────────────────────
  describe("the files → explorer rename", () => {
    it("hydrates a `files` key written by main as `explorer`, at the same edge", () => {
      const legacyBlob = { workspaces: "left", files: "right", git: "left" };
      expect(parseDockSide(legacyBlob)).toEqual({
        ...DEFAULT_DOCK_SIDE,
        workspaces: "left",
        explorer: "right",
        git: "left",
      });
      expect("files" in parseDockSide(legacyBlob)).toBe(false);
    });

    it("is idempotent once migrated", () => {
      const legacyBlob = { files: "right" };
      const once = parseDockSide(legacyBlob);
      const twice = parseDockSide(once);
      expect(twice).toEqual(once);
    });

    it("prefers an explicit `explorer` over a stale `files` in the same blob", () => {
      // Not a realistic blob (no build ever writes both), but the resolution
      // order should still be sane rather than accidental key-order dependent.
      const mixed = { files: "right", explorer: "left" };
      expect(parseDockSide(mixed).explorer).toBe("left");
    });
  });
});

describe("parseDockOrder", () => {
  it("keeps the user's order", () => {
    expect(parseDockOrder(["git", "workspaces", "explorer"])).toEqual([
      "git",
      "workspaces",
      "explorer",
      "terminals",
      "agents",
    ]);
  });

  it("repairs rather than rejects: unknown ids and duplicates go, missing ones append", () => {
    expect(parseDockOrder(["git", "git", "panegroup", 4])).toEqual([
      "git",
      "workspaces",
      "explorer",
      "terminals",
      "agents",
    ]);
    expect(parseDockOrder(null)).toEqual(DEFAULT_DOCK_ORDER);
  });

  it("migrates a `files` entry to `explorer`, at the position `files` had", () => {
    expect(parseDockOrder(["git", "files", "workspaces"])).toEqual([
      "git",
      "explorer",
      "workspaces",
      "terminals",
      "agents",
    ]);
  });

  it("does not duplicate explorer when both files and explorer appear", () => {
    // The second occurrence (however it got there) is a duplicate once
    // normalized, and duplicates are dropped like any other repeat entry.
    expect(parseDockOrder(["files", "explorer", "git"])).toEqual([
      "explorer",
      "git",
      "workspaces",
      "terminals",
      "agents",
    ]);
  });
});

describe("parseDetachedSidebars", () => {
  it("keeps known ids, drops the rest, and never repeats one", () => {
    expect(parseDetachedSidebars(["git", "git", "panegroup"])).toEqual(["git"]);
    expect(parseDetachedSidebars("git")).toEqual([]);
    expect(parseDetachedSidebars(undefined)).toEqual([]);
  });

  it("migrates a detached `files` to `explorer`", () => {
    expect(parseDetachedSidebars(["files"])).toEqual(["explorer"]);
    expect(parseDetachedSidebars(["files", "git"])).toEqual(["explorer", "git"]);
  });
});

describe("sidebarsOnSide over five ids", () => {
  const order: SidebarId[] = ["workspaces", "explorer", "terminals", "agents", "git"];

  it("reads one screen order for both edges", () => {
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "left")).toEqual([
      "workspaces",
      "explorer",
      "terminals",
      "agents",
    ]);
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "right")).toEqual(["git"]);
  });

  it("leaves a detached panel out of both", () => {
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "left", ["terminals"])).toEqual([
      "workspaces",
      "explorer",
      "agents",
    ]);
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "right", ["git"])).toEqual([]);
  });

  it("groups several panels sharing one edge", () => {
    const allLeft: Record<SidebarId, "left" | "right"> = {
      workspaces: "left",
      explorer: "left",
      terminals: "left",
      agents: "left",
      git: "left",
    };
    expect(sidebarsOnSide(order, allLeft, "left")).toEqual(order);
    expect(sidebarsOnSide(order, allLeft, "right")).toEqual([]);
  });
});

describe("moveInDockOrder over five ids", () => {
  const order: SidebarId[] = ["workspaces", "explorer", "terminals", "agents", "git"];

  it("lands the panel in front of the id it was dropped on", () => {
    expect(moveInDockOrder(order, "git", "explorer")).toEqual([
      "workspaces",
      "git",
      "explorer",
      "terminals",
      "agents",
    ]);
  });

  it("sends it to the end for a null target", () => {
    expect(moveInDockOrder(order, "workspaces", null)).toEqual([
      "explorer",
      "terminals",
      "agents",
      "git",
      "workspaces",
    ]);
  });

  it("moves nothing when a panel is dropped on itself", () => {
    expect(moveInDockOrder(order, "agents", "agents")).toEqual(order);
  });

  it("reorders two panels already sharing an edge without disturbing a third", () => {
    // terminals and agents both start on the left; swap them and workspaces
    // (also left) and explorer (also left) stay exactly where they were.
    expect(moveInDockOrder(order, "agents", "terminals")).toEqual([
      "workspaces",
      "explorer",
      "agents",
      "terminals",
      "git",
    ]);
  });
});

describe("mirrorArrangement over five ids", () => {
  it("puts every panel on the other edge, outermost staying outermost", () => {
    const next = mirrorArrangement({
      sides: DEFAULT_DOCK_SIDE,
      order: DEFAULT_DOCK_ORDER,
    });
    expect(next.sides).toEqual({
      workspaces: "right",
      explorer: "right",
      terminals: "right",
      agents: "right",
      git: "left",
    });
    expect(next.order).toEqual(["git", "agents", "terminals", "explorer", "workspaces"]);
  });

  it("is its own inverse — the property the old ⌘\\ toggle had", () => {
    const start = { sides: SWAPPED_DOCK_SIDE, order: DEFAULT_DOCK_ORDER };
    const there = mirrorArrangement(start);
    const back = mirrorArrangement(there);
    expect(back.sides).toEqual(start.sides);
    expect(back.order).toEqual([...start.order]);
  });
});

describe("slotOrder", () => {
  it("keeps every left panel before the workbench and every right one after", () => {
    for (let i = 0; i < 5; i++) {
      expect(slotOrder("left", i)).toBeLessThan(0);
      expect(slotOrder("right", i)).toBeGreaterThan(0);
    }
  });

  it("preserves screen order within an edge", () => {
    expect(slotOrder("left", 0)).toBeLessThan(slotOrder("left", 1));
    expect(slotOrder("right", 0)).toBeLessThan(slotOrder("right", 1));
  });
});
