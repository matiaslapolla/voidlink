import { describe, expect, it } from "vitest";
import { applyResolution, parseConflicts, replaceBlock, resolutionText } from "./conflictMarkers";

/// A plain two-sided conflict, the shape `merge.conflictStyle=merge` produces.
const TWO_SIDED = [
  "top",
  "<<<<<<< HEAD",
  "ours line",
  "=======",
  "theirs line",
  ">>>>>>> feature",
  "bottom",
].join("\n");

/// diff3 style: the common ancestor is spelled out between `|||||||` and `=`.
const DIFF3 = [
  "top",
  "<<<<<<< HEAD",
  "ours line",
  "||||||| merged common ancestors",
  "base line",
  "=======",
  "theirs line",
  ">>>>>>> feature",
  "bottom",
].join("\n");

describe("parseConflicts", () => {
  it("reads both sides and the marker labels", () => {
    const { blocks } = parseConflicts(TWO_SIDED);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      startLine: 1,
      endLine: 5,
      ours: "ours line",
      theirs: "theirs line",
      base: null,
      oursLabel: "HEAD",
      theirsLabel: "feature",
    });
  });

  it("reads the common ancestor out of diff3 markers", () => {
    const { blocks } = parseConflicts(DIFF3);
    expect(blocks[0].base).toBe("base line");
    expect(blocks[0].ours).toBe("ours line");
    expect(blocks[0].theirs).toBe("theirs line");
  });

  it("finds every block in a multi-conflict file", () => {
    const { blocks } = parseConflicts(`${TWO_SIDED}\n${DIFF3}`);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].base).toBe("base line");
  });

  it("skips a block with no closing marker instead of looping forever", () => {
    const truncated = ["<<<<<<< HEAD", "ours line", "======="].join("\n");
    expect(parseConflicts(truncated).blocks).toEqual([]);
  });

  it("skips a malformed block but still finds a well-formed one after it", () => {
    const mixed = ["<<<<<<< HEAD", "orphan", TWO_SIDED].join("\n");
    const { blocks } = parseConflicts(mixed);
    // The orphan `<<<` swallows the real block's opener, so what survives is
    // the region from the orphan to the first `>>>` — one block, not zero,
    // and crucially the parser terminates.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].theirs).toBe("theirs line");
  });

  it("defaults the labels when git wrote bare markers", () => {
    const bare = ["<<<<<<<", "a", "=======", "b", ">>>>>>>"].join("\n");
    const { blocks } = parseConflicts(bare);
    expect(blocks[0].oursLabel).toBe("ours");
    expect(blocks[0].theirsLabel).toBe("theirs");
  });
});

describe("resolutionText", () => {
  const block = parseConflicts(TWO_SIDED).blocks[0];

  it("takes one side verbatim", () => {
    expect(resolutionText(block, "ours")).toBe("ours line");
    expect(resolutionText(block, "theirs")).toBe("theirs line");
  });

  it("joins both sides with exactly one newline", () => {
    expect(resolutionText(block, "both")).toBe("ours line\ntheirs line");
  });

  it("does not double the newline when ours already ends in one", () => {
    const trailing = { ...block, ours: "ours line\n" };
    expect(resolutionText(trailing, "both")).toBe("ours line\ntheirs line");
  });

  it("drops the separator entirely when ours is empty", () => {
    const empty = { ...block, ours: "" };
    expect(resolutionText(empty, "both")).toBe("theirs line");
  });
});

describe("applyResolution", () => {
  it("splices the chosen side in and removes every marker", () => {
    const out = applyResolution(TWO_SIDED, parseConflicts(TWO_SIDED).blocks[0], "ours");
    expect(out).toBe("top\nours line\nbottom");
    expect(parseConflicts(out).blocks).toEqual([]);
  });

  it("removes the base section along with the rest of a diff3 block", () => {
    const out = applyResolution(DIFF3, parseConflicts(DIFF3).blocks[0], "theirs");
    expect(out).toBe("top\ntheirs line\nbottom");
    expect(out).not.toContain("base line");
  });

  it("resolves a multi-conflict file one block at a time", () => {
    // Re-parsing between passes is the point: splicing shifts every later
    // block's line numbers, so stale offsets would corrupt the second edit.
    let buffer = `${TWO_SIDED}\n${DIFF3}`;
    for (let i = 0; i < 2; i++) {
      const block = parseConflicts(buffer).blocks[0];
      buffer = applyResolution(buffer, block, "both");
    }
    expect(parseConflicts(buffer).blocks).toEqual([]);
    expect(buffer).toBe(
      ["top", "ours line", "theirs line", "bottom", "top", "ours line", "theirs line", "bottom"].join(
        "\n",
      ),
    );
  });

  it("deletes the block outright when the replacement is empty", () => {
    const out = replaceBlock(TWO_SIDED, parseConflicts(TWO_SIDED).blocks[0], "");
    expect(out).toBe("top\nbottom");
  });
});
