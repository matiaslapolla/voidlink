import { describe, expect, it } from "vitest";
import {
  clampFraction,
  closeGroup,
  cycleFocus,
  DEFAULT_SPLIT_FRACTION,
  focusGroup,
  isSplit,
  MIN_SPLIT_FRACTION,
  SINGLE_GROUP,
  splitEditor,
  unsplit,
} from "./editorGroups";

describe("SINGLE_GROUP", () => {
  it("is the unsplit layout the editor has always had", () => {
    expect(SINGLE_GROUP.groups).toEqual(["primary"]);
    expect(SINGLE_GROUP.focused).toBe("primary");
    expect(isSplit(SINGLE_GROUP)).toBe(false);
  });
});

describe("splitEditor", () => {
  it("adds the second group and focuses it", () => {
    const next = splitEditor(SINGLE_GROUP, "horizontal");
    expect(next.groups).toEqual(["primary", "secondary"]);
    expect(next.focused).toBe("secondary");
    expect(next.orientation).toBe("horizontal");
  });

  it("is a no-op when already split the same way", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    expect(splitEditor(split, "horizontal")).toBe(split);
  });

  it("re-orients instead of adding a third group", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    const rotated = splitEditor(split, "vertical");
    expect(rotated.groups).toEqual(["primary", "secondary"]);
    expect(rotated.orientation).toBe("vertical");
    // Re-orienting is not a new pane, so it must not move focus.
    expect(rotated.focused).toBe(split.focused);
  });

  it("re-adds the missing id after the first group was the one closed", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    const secondaryOnly = closeGroup(split, "primary");
    expect(secondaryOnly.groups).toEqual(["secondary"]);
    const resplit = splitEditor(secondaryOnly, "horizontal");
    expect(resplit.groups).toEqual(["secondary", "primary"]);
    expect(resplit.focused).toBe("primary");
  });
});

describe("closeGroup", () => {
  it("never drops below one group", () => {
    expect(closeGroup(SINGLE_GROUP, "primary")).toBe(SINGLE_GROUP);
  });

  it("moves focus to the survivor", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    expect(split.focused).toBe("secondary");
    const closed = closeGroup(split, "secondary");
    expect(closed.groups).toEqual(["primary"]);
    expect(closed.focused).toBe("primary");
  });

  it("ignores a group that is not in the layout", () => {
    expect(closeGroup(SINGLE_GROUP, "secondary")).toBe(SINGLE_GROUP);
  });
});

describe("unsplit", () => {
  it("keeps the focused group and drops the other", () => {
    const split = splitEditor(SINGLE_GROUP, "vertical");
    const kept = unsplit(split);
    expect(kept.groups).toEqual(["secondary"]);
    expect(kept.focused).toBe("secondary");
  });

  it("is a no-op on a single group", () => {
    expect(unsplit(SINGLE_GROUP)).toBe(SINGLE_GROUP);
  });
});

describe("focusGroup", () => {
  it("returns the same object when nothing changes", () => {
    expect(focusGroup(SINGLE_GROUP, "primary")).toBe(SINGLE_GROUP);
    expect(focusGroup(SINGLE_GROUP, "secondary")).toBe(SINGLE_GROUP);
  });

  it("moves focus within the layout", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    expect(focusGroup(split, "primary").focused).toBe("primary");
  });
});

describe("cycleFocus", () => {
  it("wraps between the two groups", () => {
    const split = splitEditor(SINGLE_GROUP, "horizontal");
    const a = cycleFocus(split);
    expect(a.focused).toBe("primary");
    expect(cycleFocus(a).focused).toBe("secondary");
  });

  it("is a no-op with one group, so the command is safe to bind", () => {
    expect(cycleFocus(SINGLE_GROUP)).toBe(SINGLE_GROUP);
  });
});

describe("clampFraction", () => {
  it("keeps both panes reachable", () => {
    expect(clampFraction(0)).toBe(MIN_SPLIT_FRACTION);
    expect(clampFraction(1)).toBe(1 - MIN_SPLIT_FRACTION);
    expect(clampFraction(-4)).toBe(MIN_SPLIT_FRACTION);
  });

  it("passes a sane fraction through", () => {
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(0.72)).toBe(0.72);
  });

  it("falls back to the default for a non-number", () => {
    expect(clampFraction(Number.NaN)).toBe(DEFAULT_SPLIT_FRACTION);
    expect(clampFraction(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SPLIT_FRACTION);
  });
});
