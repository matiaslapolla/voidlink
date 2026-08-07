/// Where a dragged sidebar lands. The mirror of `paneDrop.test.ts`, and it
/// exists for the same reason: the whole gesture is arithmetic on rectangles,
/// and a drop that resolves to the wrong edge is a bug a screenshot cannot see.
import { describe, expect, it } from "vitest";
import {
  DOCK_EDGE_ZONE,
  describeDockDrop,
  dockEdgeAt,
  dockInsertionBefore,
  dockPreviewRect,
} from "./sidebarDrop";

const SIZE = { width: 1000, height: 600 };

describe("dockEdgeAt", () => {
  it("reads the outer fifth of each side as that edge", () => {
    expect(dockEdgeAt(SIZE, { x: 10, y: 300 })).toBe("left");
    expect(dockEdgeAt(SIZE, { x: 199, y: 20 })).toBe("left");
    expect(dockEdgeAt(SIZE, { x: 990, y: 300 })).toBe("right");
    expect(dockEdgeAt(SIZE, { x: 801, y: 580 })).toBe("right");
  });

  it("refuses the middle band, so a drop there changes nothing", () => {
    for (const x of [200, 500, 800]) {
      expect(dockEdgeAt(SIZE, { x, y: 300 })).toBeNull();
    }
  });

  it("does not care about the vertical position — there is no top or bottom edge", () => {
    for (const y of [0, 1, 300, 599]) {
      expect(dockEdgeAt(SIZE, { x: 5, y })).toBe("left");
      expect(dockEdgeAt(SIZE, { x: 995, y })).toBe("right");
    }
  });

  it("keeps the zone a fraction, not a pixel count", () => {
    const narrow = { width: 400, height: 600 };
    expect(dockEdgeAt(narrow, { x: 400 * DOCK_EDGE_ZONE - 1, y: 10 })).toBe("left");
    expect(dockEdgeAt(narrow, { x: 400 * DOCK_EDGE_ZONE + 1, y: 10 })).toBeNull();
  });

  it("refuses a degenerate box rather than picking an edge of nothing", () => {
    expect(dockEdgeAt({ width: 0, height: 0 }, { x: 0, y: 0 })).toBeNull();
    expect(dockEdgeAt({ width: 1000, height: 0 }, { x: 5, y: 0 })).toBeNull();
  });
});

describe("dockPreviewRect", () => {
  it("draws the panel where it will actually be, at the width it will have", () => {
    expect(dockPreviewRect(SIZE, "left", 256)).toEqual({
      x: 0,
      y: 0,
      width: 256,
      height: 600,
    });
    expect(dockPreviewRect(SIZE, "right", 256)).toEqual({
      x: 744,
      y: 0,
      width: 256,
      height: 600,
    });
  });

  it("never previews a panel wider than half the window", () => {
    const r = dockPreviewRect(SIZE, "right", 4000);
    expect(r.width).toBe(500);
    expect(r.x).toBe(500);
  });
});

describe("describeDockDrop", () => {
  it("says what the release will do", () => {
    expect(describeDockDrop("left", "Git", false)).toBe("Dock Git left");
    expect(describeDockDrop("right", "Files", false)).toBe("Dock Files right");
  });

  it("says nothing where a release would do nothing", () => {
    expect(describeDockDrop(null, "Git", false)).toBeNull();
    // Dropped back exactly where it came from: promising a move that will not
    // happen is worse than no label at all.
    expect(describeDockDrop("left", "Git", true)).toBeNull();
  });
});

describe("dockInsertionBefore", () => {
  it("names the neighbour the panel lands in front of", () => {
    expect(dockInsertionBefore(["workspaces", "git"], 1)).toBe("git");
  });

  it("returns null past the end of the stack", () => {
    expect(dockInsertionBefore(["workspaces", "git"], 2)).toBeNull();
    expect(dockInsertionBefore([], 0)).toBeNull();
  });
});
