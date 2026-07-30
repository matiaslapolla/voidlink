import { describe, expect, it } from "vitest";
import { reconstructOriginal, workingTreeSides } from "./diffModel";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";

/// Build a hunk the way `src-tauri/src/git/diff.rs` emits one: content with the
/// trailing newline already stripped, origins as single characters.
function hunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: [DiffLine["origin"], string][],
): DiffHunk {
  return {
    oldStart,
    oldLines,
    newStart,
    newLines,
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    lines: lines.map(([origin, content]) => ({
      origin,
      content,
      oldLineno: null,
      newLineno: null,
    })),
  };
}

function fileDiff(hunks: DiffHunk[], overrides: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: "a.ts",
    newPath: "a.ts",
    status: "modified",
    hunks,
    isBinary: false,
    oldBlobOid: null,
    additions: 0,
    deletions: 0,
    ...overrides,
  };
}

describe("reconstructOriginal", () => {
  it("returns the text unchanged when nothing was modified", () => {
    expect(reconstructOriginal("a\nb\nc\n", [])).toBe("a\nb\nc\n");
  });

  it("puts back a replaced line", () => {
    const working = "one\nTWO\nthree\n";
    const out = reconstructOriginal(working, [
      hunk(1, 3, 1, 3, [
        [" ", "one"],
        ["-", "two"],
        ["+", "TWO"],
        [" ", "three"],
      ]),
    ]);
    expect(out).toBe("one\ntwo\nthree\n");
  });

  it("puts back lines that were deleted", () => {
    // git reports a pure deletion as `@@ -2,2 +1,0 @@`: new_start is the line
    // the removal follows, and new_lines is zero.
    const working = "one\nfour\n";
    const out = reconstructOriginal(working, [
      hunk(2, 2, 1, 0, [
        ["-", "two"],
        ["-", "three"],
      ]),
    ]);
    expect(out).toBe("one\ntwo\nthree\nfour\n");
  });

  it("drops lines that were added", () => {
    const working = "one\ntwo\nthree\n";
    const out = reconstructOriginal(working, [
      hunk(1, 0, 2, 2, [
        ["+", "two"],
        ["+", "three"],
      ]),
    ]);
    expect(out).toBe("one\n");
  });

  it("copies untouched regions between two distant hunks", () => {
    const working = ["A", "b", "c", "d", "e", "f", "G"].join("\n");
    const out = reconstructOriginal(working, [
      hunk(1, 1, 1, 1, [
        ["-", "a"],
        ["+", "A"],
      ]),
      hunk(7, 1, 7, 1, [
        ["-", "g"],
        ["+", "G"],
      ]),
    ]);
    expect(out).toBe(["a", "b", "c", "d", "e", "f", "g"].join("\n"));
  });

  it("applies hunks in new-file order regardless of the order given", () => {
    const working = ["A", "b", "C"].join("\n");
    const hunks = [
      hunk(3, 1, 3, 1, [
        ["-", "c"],
        ["+", "C"],
      ]),
      hunk(1, 1, 1, 1, [
        ["-", "a"],
        ["+", "A"],
      ]),
    ];
    expect(reconstructOriginal(working, hunks)).toBe("a\nb\nc");
  });

  it("treats `~` context lines as present on both sides", () => {
    const working = "one\nTWO\n";
    const out = reconstructOriginal(working, [
      hunk(1, 2, 1, 2, [
        ["~", "one"],
        ["-", "two"],
        ["+", "TWO"],
      ]),
    ]);
    expect(out).toBe("one\ntwo\n");
  });

  it("ignores libgit2's no-newline-at-EOF annotation", () => {
    // That marker arrives as content, not as file text; splicing it in would
    // put a literal `\ No newline at end of file` line into the original.
    const working = "one\nTWO";
    const out = reconstructOriginal(working, [
      hunk(1, 2, 1, 2, [
        [" ", "one"],
        ["-", "two"],
        ["~", "\\ No newline at end of file"],
        ["+", "TWO"],
      ]),
    ]);
    expect(out).toBe("one\ntwo");
  });

  it("mirrors the working tree's trailing-newline state", () => {
    // Hunk content carries no EOF information, so a reconstruction must not
    // invent (or lose) a final newline relative to the file beside it.
    const withNewline = reconstructOriginal("a\nb\n", [
      hunk(2, 1, 2, 1, [
        ["-", "B"],
        ["+", "b"],
      ]),
    ]);
    expect(withNewline.endsWith("\n")).toBe(true);

    const without = reconstructOriginal("a\nb", [
      hunk(2, 1, 2, 1, [
        ["-", "B"],
        ["+", "b"],
      ]),
    ]);
    expect(without.endsWith("\n")).toBe(false);
  });
});

describe("workingTreeSides", () => {
  it("shows identical sides when the file has no diff at all", () => {
    const sides = workingTreeSides("a\nb\n", null);
    expect(sides.original).toBe("a\nb\n");
    expect(sides.modified).toBe("a\nb\n");
    expect(sides.unavailable).toBeNull();
  });

  it("gives an added file an empty original", () => {
    const sides = workingTreeSides("new\n", fileDiff([], { status: "added" }));
    expect(sides.original).toBe("");
    expect(sides.modified).toBe("new\n");
  });

  it("gives a deleted file an empty modified side and recovers its content", () => {
    const sides = workingTreeSides(
      "",
      fileDiff(
        [
          hunk(1, 2, 0, 0, [
            ["-", "gone one"],
            ["-", "gone two"],
          ]),
        ],
        { status: "deleted" },
      ),
    );
    expect(sides.modified).toBe("");
    expect(sides.original).toBe("gone one\ngone two");
  });

  it("refuses to diff a binary blob", () => {
    const sides = workingTreeSides("\u0000\u0001", fileDiff([], { isBinary: true }));
    expect(sides.unavailable).toMatch(/binary/i);
  });
});
