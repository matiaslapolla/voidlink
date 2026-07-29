import { describe, expect, it } from "vitest";
import {
  dropIntentAt,
  previewRect,
  ratiosAfterDrag,
  resolveActiveTabId,
  SPLIT_CAP_REASON,
} from "./paneDrop";

const SIZE = { width: 1000, height: 500 };
const ok = { canSplit: true };

describe("dropIntentAt", () => {
  it("treats the centre as a same-group drop", () => {
    expect(dropIntentAt(SIZE, { x: 500, y: 250 }, ok)).toEqual({ kind: "body" });
  });

  it("keeps the whole 60% middle band out of the edge zones", () => {
    for (const x of [201, 500, 799]) {
      for (const y of [101, 250, 399]) {
        expect(dropIntentAt(SIZE, { x, y }, ok).kind).toBe("body");
      }
    }
  });

  it("reads each outer 20% as a split of that edge", () => {
    expect(dropIntentAt(SIZE, { x: 40, y: 250 }, ok)).toMatchObject({
      kind: "edge",
      orientation: "row",
      placement: "before",
    });
    expect(dropIntentAt(SIZE, { x: 960, y: 250 }, ok)).toMatchObject({
      orientation: "row",
      placement: "after",
    });
    expect(dropIntentAt(SIZE, { x: 500, y: 10 }, ok)).toMatchObject({
      orientation: "column",
      placement: "before",
    });
    expect(dropIntentAt(SIZE, { x: 500, y: 490 }, ok)).toMatchObject({
      orientation: "column",
      placement: "after",
    });
  });

  it("resolves a corner to the edge the pointer is proportionally nearer", () => {
    // 2% in from the left, 4% down from the top: the left edge is nearer.
    expect(dropIntentAt(SIZE, { x: 20, y: 20 }, ok)).toMatchObject({
      orientation: "row",
      placement: "before",
    });
    // 10% in from the left, 1% down: now the top edge wins.
    expect(dropIntentAt(SIZE, { x: 100, y: 5 }, ok)).toMatchObject({
      orientation: "column",
      placement: "before",
    });
  });

  it("previews the exact geometry the new group would occupy", () => {
    const intent = dropIntentAt(SIZE, { x: 960, y: 250 }, ok);
    expect(intent).toMatchObject({
      preview: { x: 500, y: 0, width: 500, height: 500 },
    });
    expect(dropIntentAt(SIZE, { x: 500, y: 490 }, ok)).toMatchObject({
      preview: { x: 0, y: 250, width: 1000, height: 250 },
    });
  });

  it("refuses the edge zones at the four-group cap, with the reason", () => {
    expect(dropIntentAt(SIZE, { x: 10, y: 250 }, { canSplit: false })).toEqual({
      kind: "refused",
      reason: SPLIT_CAP_REASON,
    });
    // The centre still accepts — moving a tab between existing groups is not
    // what the cap is about.
    expect(dropIntentAt(SIZE, { x: 500, y: 250 }, { canSplit: false }).kind).toBe("body");
  });

  it("has no edges in a degenerate box", () => {
    expect(dropIntentAt({ width: 0, height: 0 }, { x: 0, y: 0 }, ok).kind).toBe("body");
  });
});

describe("previewRect", () => {
  it("splits the pane in half on the named side", () => {
    expect(previewRect(SIZE, "row", "before")).toEqual({ x: 0, y: 0, width: 500, height: 500 });
    expect(previewRect(SIZE, "column", "before")).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 250,
    });
  });
});

describe("resolveActiveTabId", () => {
  it("shows the worktree-wide active item when this group holds it", () => {
    expect(resolveActiveTabId(["a", "b"], "a", "b")).toBe("b");
  });

  it("falls back to the group's own memory when it does not", () => {
    expect(resolveActiveTabId(["a", "b"], "a", "z")).toBe("a");
  });

  it("ignores a remembered tab that is no longer in the group", () => {
    expect(resolveActiveTabId(["a", "b"], "gone", null)).toBeNull();
  });

  it("is null for an empty group", () => {
    expect(resolveActiveTabId([], "a", "a")).toBeNull();
  });

  it("shows its first tab once the active item has moved to another group", () => {
    expect(resolveActiveTabId(["a", "b"], null, "z", true)).toBe("a");
  });

  it("stays blank when there is no active item anywhere — today's behaviour", () => {
    expect(resolveActiveTabId(["a", "b"], null, null, false)).toBeNull();
  });
});

describe("ratiosAfterDrag", () => {
  it("moves the pair either side of the handle and nothing else", () => {
    expect(ratiosAfterDrag([0.5, 0.5], 0, 300, 1000)).toEqual([0.3, 0.7]);
    expect(ratiosAfterDrag([0.25, 0.25, 0.5], 1, 400, 1000)).toEqual([0.25, 0.4, 0.35]);
  });

  it("never lets a drag hand a sibling a negative share", () => {
    expect(ratiosAfterDrag([0.5, 0.5], 0, 5000, 1000)).toEqual([1, 0]);
    expect(ratiosAfterDrag([0.5, 0.5], 0, -200, 1000)).toEqual([0, 1]);
  });

  it("is a no-op for a handle that is not between two children", () => {
    expect(ratiosAfterDrag([0.5, 0.5], 1, 300, 1000)).toEqual([0.5, 0.5]);
    expect(ratiosAfterDrag([0.5, 0.5], 0, 300, 0)).toEqual([0.5, 0.5]);
  });
});
