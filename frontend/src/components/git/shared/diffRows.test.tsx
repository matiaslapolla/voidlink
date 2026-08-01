/// How a hunk's lines become rows, in both diff layouts.
///
/// The audit's Track 1 "Lower": `\ No newline at end of file` rendered as a
/// literal row of the file — in the split view, in a gutter, with a line number
/// beside it, as if the author had typed the sentence. It is a note about the
/// line above it, and both row builders had to learn the difference.
import { describe, expect, it } from "vitest";
import type { DiffLine } from "@/types/git";
import { hasNoNewlineMarker, inlineRowsForHunk, pairHunkLines } from "./SplitDiffRenderer";

function line(origin: DiffLine["origin"], content: string, old_: number | null, new_: number | null): DiffLine {
  return { origin, content, oldLineno: old_, newLineno: new_ };
}

/// What libgit2 emits for a file whose last line lost its trailing newline:
/// the deletion, its marker, the addition, its marker.
const withMarkers: DiffLine[] = [
  line("-", "two", 1, null),
  line("\\", "No newline at end of file", null, null),
  line("+", "three", null, 1),
  line("\\", "No newline at end of file", null, null),
];

describe("the no-newline marker", () => {
  it("is not paired as a line in the split view", () => {
    const pairs = pairHunkLines(withMarkers);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].left?.content).toBe("two");
    expect(pairs[0].right?.content).toBe("three");
  });

  it("is not a row in the inline view", () => {
    const rows = inlineRowsForHunk(withMarkers);
    expect(rows.map((r) => r.line.content)).toEqual(["two", "three"]);
  });

  it("is still reported, so the hunk can say so once", () => {
    expect(hasNoNewlineMarker(withMarkers)).toBe(true);
    expect(hasNoNewlineMarker([line(" ", "unchanged", 1, 1)])).toBe(false);
  });

  /// The marker sat between a deletion and an addition that are the same
  /// edit. Treated as context it split them, so the word-level highlight —
  /// which only runs on a paired `-`/`+` — was lost on exactly the line the
  /// marker was about.
  it("does not split a deletion from the addition that replaced it", () => {
    const pairs = pairHunkLines(withMarkers);
    expect(pairs[0].segments).toBeDefined();
  });
});

describe("ordinary pairing is unchanged", () => {
  it("pairs deletions with additions and leaves context alone", () => {
    const rows = pairHunkLines([
      line(" ", "keep", 1, 1),
      line("-", "old", 2, null),
      line("+", "new", null, 2),
      line("-", "orphan", 3, null),
    ]);
    expect(rows[0].context?.content).toBe("keep");
    expect(rows[1].left?.content).toBe("old");
    expect(rows[1].right?.content).toBe("new");
    expect(rows[2].left?.content).toBe("orphan");
    expect(rows[2].right).toBeNull();
  });
});
