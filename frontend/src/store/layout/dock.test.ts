/// The dock model and its one migration.
///
/// `sidebarsSwapped` was a boolean two builds of users have in localStorage, so
/// the interesting cases here are all about a blob written by *some other*
/// build: an old one that only has the boolean, this one, and a future one that
/// docks a panel this build has never heard of. None of them may throw, and
/// none of them may lose an arrangement the user set.
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
    // so a swapped layout was rail, git, workbench, files.
    expect(parseDockSide(undefined, true)).toEqual(SWAPPED_DOCK_SIDE);
    expect(parseDockSide(undefined, true)).toMatchObject({
      workspaces: "left",
      git: "left",
      files: "right",
    });
  });

  it("maps sidebarsSwapped:false — and a blob with neither — to the default", () => {
    expect(parseDockSide(undefined, false)).toEqual(DEFAULT_DOCK_SIDE);
    expect(parseDockSide(undefined, undefined)).toEqual(DEFAULT_DOCK_SIDE);
    expect(parseDockSide(null, null)).toEqual(DEFAULT_DOCK_SIDE);
  });

  it("leaves a blob already in the new shape alone, and is idempotent", () => {
    const saved = { workspaces: "right", files: "right", git: "left" } as const;
    const once = parseDockSide(saved);
    expect(once).toEqual(saved);
    expect(parseDockSide(once)).toEqual(saved);
    // Even with a stale boolean still sitting beside it: the new field wins,
    // which is what makes re-hydrating a blob this build wrote a no-op.
    expect(parseDockSide(saved, true)).toEqual(saved);
  });

  it("drops an unknown sidebar id without throwing", () => {
    const parsed = parseDockSide({ files: "right", terminals: "left", 7: "left" });
    expect(parsed).toEqual({ ...DEFAULT_DOCK_SIDE, files: "right" });
    expect("terminals" in parsed).toBe(false);
  });

  it("drops a side the shell has no branch for", () => {
    expect(parseDockSide({ git: "top", files: "right" })).toEqual({
      ...DEFAULT_DOCK_SIDE,
      files: "right",
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
    a.files = "right";
    expect(DEFAULT_DOCK_SIDE.files).toBe("left");
  });
});

describe("parseDockOrder", () => {
  it("keeps the user's order", () => {
    expect(parseDockOrder(["git", "workspaces", "files"])).toEqual([
      "git",
      "workspaces",
      "files",
    ]);
  });

  it("repairs rather than rejects: unknown ids and duplicates go, missing ones append", () => {
    expect(parseDockOrder(["git", "git", "terminals", 4])).toEqual([
      "git",
      "workspaces",
      "files",
    ]);
    expect(parseDockOrder(null)).toEqual(DEFAULT_DOCK_ORDER);
  });
});

describe("parseDetachedSidebars", () => {
  it("keeps known ids, drops the rest, and never repeats one", () => {
    expect(parseDetachedSidebars(["git", "git", "terminals"])).toEqual(["git"]);
    expect(parseDetachedSidebars("git")).toEqual([]);
    expect(parseDetachedSidebars(undefined)).toEqual([]);
  });
});

describe("sidebarsOnSide", () => {
  const order: SidebarId[] = ["workspaces", "files", "git"];

  it("reads one screen order for both edges", () => {
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "left")).toEqual([
      "workspaces",
      "files",
    ]);
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "right")).toEqual(["git"]);
  });

  it("leaves a detached panel out of both", () => {
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "left", ["files"])).toEqual([
      "workspaces",
    ]);
    expect(sidebarsOnSide(order, DEFAULT_DOCK_SIDE, "right", ["git"])).toEqual([]);
  });
});

describe("moveInDockOrder", () => {
  const order: SidebarId[] = ["workspaces", "files", "git"];

  it("lands the panel in front of the id it was dropped on", () => {
    expect(moveInDockOrder(order, "git", "files")).toEqual([
      "workspaces",
      "git",
      "files",
    ]);
  });

  it("sends it to the end for a null target", () => {
    expect(moveInDockOrder(order, "workspaces", null)).toEqual([
      "files",
      "git",
      "workspaces",
    ]);
  });

  it("moves nothing when a panel is dropped on itself", () => {
    expect(moveInDockOrder(order, "files", "files")).toEqual(order);
  });
});

describe("mirrorArrangement", () => {
  it("puts every panel on the other edge, outermost staying outermost", () => {
    const next = mirrorArrangement({
      sides: DEFAULT_DOCK_SIDE,
      order: DEFAULT_DOCK_ORDER,
    });
    expect(next.sides).toEqual({ workspaces: "right", files: "right", git: "left" });
    expect(next.order).toEqual(["git", "files", "workspaces"]);
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
    for (let i = 0; i < 3; i++) {
      expect(slotOrder("left", i)).toBeLessThan(0);
      expect(slotOrder("right", i)).toBeGreaterThan(0);
    }
  });

  it("preserves screen order within an edge", () => {
    expect(slotOrder("left", 0)).toBeLessThan(slotOrder("left", 1));
    expect(slotOrder("right", 0)).toBeLessThan(slotOrder("right", 1));
  });
});
