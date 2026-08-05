/// What a line selection turns into before it reaches git.
///
/// The invariant every test here is really about: the patch's pre-image must
/// be byte-identical to the side git is about to apply it to. Lines the user
/// did not pick are therefore not *absent* — the ones on the pre-image side are
/// present as context, and only the ones on the post-image side disappear.
/// Getting that backwards produces a patch that still parses, still looks
/// plausible, and applies at the wrong offset.
///
/// The other half of this contract — that the resulting patch actually applies
/// and stages exactly those lines — is proven against a real repository in
/// `src-tauri/src/git/apply_hunk.rs`, because only git can answer it.
import { describe, expect, it } from "vitest";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";
import {
  applyLineClick,
  buildLineSelectionDiff,
  lineStagingBlock,
  selectableIndices,
  selectionSizeFor,
} from "./linePatch";

function line(
  origin: DiffLine["origin"],
  content: string,
  old_: number | null,
  new_: number | null,
): DiffLine {
  return { origin, content, oldLineno: old_, newLineno: new_ };
}

/// Three context lines around two deletions and two additions — enough that
/// "picked one of two" is a different patch from "picked both".
///
///   0  " keep-a"
///   1  "-old-1"
///   2  "-old-2"
///   3  "+new-1"
///   4  "+new-2"
///   5  " keep-b"
const HUNK: DiffHunk = {
  oldStart: 10,
  oldLines: 4,
  newStart: 10,
  newLines: 4,
  header: "@@ -10,4 +10,4 @@ fn parse",
  lines: [
    line(" ", "keep-a", 10, 10),
    line("-", "old-1", 11, null),
    line("-", "old-2", 12, null),
    line("+", "new-1", null, 11),
    line("+", "new-2", null, 12),
    line(" ", "keep-b", 13, 13),
  ],
};

const FILE: FileDiff = {
  oldPath: "src/parse.rs",
  newPath: "src/parse.rs",
  status: "modified",
  hunks: [HUNK],
  isBinary: false,
  additions: 2,
  deletions: 2,
  oldBlobOid: "deadbeef",
};

/// The patch as a reader would see it: origin plus content, in order.
function shape(file: FileDiff): string[] {
  return file.hunks[0].lines.map((l) => `${l.origin}${l.content}`);
}

describe("staging a subset of lines (forward)", () => {
  /// One of two additions. The index holds the old side, so *both* deletions
  /// have to still be there — the picked one as a deletion, the other as
  /// context — or the patch describes a file the index does not contain.
  it("keeps every deletion, as context where it was not picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [3], "forward")!;
    expect(shape(out)).toEqual([
      " keep-a",
      " old-1",
      " old-2",
      "+new-1",
      " keep-b",
    ]);
  });

  /// The mirror: picking a deletion and no addition removes that line and adds
  /// nothing. The unpicked additions are dropped outright — they are not in
  /// the index, so writing them as context would invent content.
  it("drops the additions that were not picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [1], "forward")!;
    expect(shape(out)).toEqual([
      " keep-a",
      "-old-1",
      " old-2",
      " keep-b",
    ]);
  });

  it("stages a deletion and an addition together when both are picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [2, 4], "forward")!;
    expect(shape(out)).toEqual([
      " keep-a",
      " old-1",
      "-old-2",
      "+new-2",
      " keep-b",
    ]);
  });

  it("reproduces the whole hunk when every changed line is picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [1, 2, 3, 4], "forward")!;
    expect(shape(out)).toEqual(shape(FILE));
  });

  /// The counts in the header have to describe the body that follows them.
  it("recomputes the hunk's own line counts from what it ships", () => {
    const out = buildLineSelectionDiff(FILE, 0, [3], "forward")!;
    const h = out.hunks[0];
    // Old side: two real context lines plus the two neutralised deletions.
    expect(h.oldLines).toBe(4);
    // New side: those same four, plus the one addition being staged. The
    // patch grows the file by exactly one line, which is the whole claim.
    expect(h.newLines).toBe(5);
    // Start positions are untouched — neutralising a line does not move it.
    expect(h.oldStart).toBe(10);
    expect(h.newStart).toBe(10);
  });
});

describe("unstaging and discarding a subset of lines (reverse)", () => {
  /// Reverse is un-applied against the *new* side, so now it is the additions
  /// that must all be present and the unpicked deletions that go.
  it("keeps every addition, as context where it was not picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [1], "reverse")!;
    expect(shape(out)).toEqual([
      " keep-a",
      "-old-1",
      " new-1",
      " new-2",
      " keep-b",
    ]);
  });

  it("drops the deletions that were not picked", () => {
    const out = buildLineSelectionDiff(FILE, 0, [4], "reverse")!;
    expect(shape(out)).toEqual([
      " keep-a",
      " new-1",
      "+new-2",
      " keep-b",
    ]);
  });

  /// The two directions genuinely differ. If they ever collapse into the same
  /// output, one of them is wrong and the wrongness is silent.
  it("is not the same patch as the forward direction", () => {
    const fwd = buildLineSelectionDiff(FILE, 0, [3], "forward")!;
    const rev = buildLineSelectionDiff(FILE, 0, [3], "reverse")!;
    expect(shape(rev)).not.toEqual(shape(fwd));
  });
});

describe("what it refuses", () => {
  /// The single most important assertion in this file. An empty selection
  /// falling through to "then do the whole hunk" is how a user who clicked to
  /// deselect their last line ends up staging four lines they had decided
  /// against.
  it("refuses an empty selection rather than falling back to the whole hunk", () => {
    expect(buildLineSelectionDiff(FILE, 0, [], "forward")).toBeNull();
    expect(buildLineSelectionDiff(FILE, 0, [], "reverse")).toBeNull();
  });

  it("refuses a selection that names only context lines", () => {
    expect(buildLineSelectionDiff(FILE, 0, [0, 5], "forward")).toBeNull();
  });

  it("ignores indices that are not in the hunk at all", () => {
    const out = buildLineSelectionDiff(FILE, 0, [3, 99, -1], "forward")!;
    expect(shape(out)).toEqual([" keep-a", " old-1", " old-2", "+new-1", " keep-b"]);
  });

  it("refuses a hunk index that does not exist", () => {
    expect(buildLineSelectionDiff(FILE, 7, [1], "forward")).toBeNull();
  });

  /// A `\ No newline at end of file` marker is a statement about the line
  /// above it. Neutralising that line moves the statement to a line it was
  /// never about, and the failure would be a silently corrupted last line.
  it("refuses a hunk that carries a no-newline marker", () => {
    const withMarker: FileDiff = {
      ...FILE,
      hunks: [
        {
          ...HUNK,
          lines: [...HUNK.lines, line("\\", "No newline at end of file", null, null)],
        },
      ],
    };
    expect(lineStagingBlock(withMarker, withMarker.hunks[0])).toBe("no-newline");
    expect(buildLineSelectionDiff(withMarker, 0, [3], "forward")).toBeNull();
  });

  it("refuses a binary file and a hunk with nothing changed in it", () => {
    expect(lineStagingBlock({ ...FILE, isBinary: true }, HUNK)).toBe("binary");
    const contextOnly: DiffHunk = { ...HUNK, lines: [line(" ", "keep", 1, 1)] };
    expect(lineStagingBlock(FILE, contextOnly)).toBe("no-lines");
    expect(lineStagingBlock(FILE, undefined)).toBe("no-lines");
  });

  it("lets an ordinary hunk through", () => {
    expect(lineStagingBlock(FILE, HUNK)).toBeNull();
  });
});

describe("what the round trip carries", () => {
  /// The stale-basis guard in Rust rests entirely on `oldBlobOid`. Dropping it
  /// while building the filtered diff would turn the guard off for exactly the
  /// operation that most needs it.
  it("carries the basis oid, paths and status through untouched", () => {
    const out = buildLineSelectionDiff(FILE, 0, [3], "forward")!;
    expect(out.oldBlobOid).toBe("deadbeef");
    expect(out.oldPath).toBe("src/parse.rs");
    expect(out.newPath).toBe("src/parse.rs");
    expect(out.status).toBe("modified");
  });

  /// One hunk, so the caller passes index 0 and cannot address anything else.
  it("holds exactly one hunk, whichever hunk was chosen", () => {
    const two: FileDiff = { ...FILE, hunks: [HUNK, { ...HUNK, header: "@@ -90,4 +90,4 @@" }] };
    const out = buildLineSelectionDiff(two, 1, [3], "forward")!;
    expect(out.hunks).toHaveLength(1);
    expect(out.hunks[0].header).toBe("@@ -90,4 +90,4 @@");
  });

  it("does not mutate the diff it was given", () => {
    const before = JSON.stringify(FILE);
    buildLineSelectionDiff(FILE, 0, [1, 3], "forward");
    expect(JSON.stringify(FILE)).toBe(before);
  });
});

describe("click and shift-click", () => {
  it("offers only added and removed lines", () => {
    expect(selectableIndices(HUNK)).toEqual([1, 2, 3, 4]);
  });

  it("adds a line, then toggles it back off and clears the selection", () => {
    const first = applyLineClick(null, null, HUNK, 0, 3, false);
    expect(first.selection).toEqual({ hunkIndex: 0, lines: [3] });
    expect(first.anchor).toBe(3);

    const second = applyLineClick(first.selection, first.anchor, HUNK, 0, 3, false);
    // Not an empty selection — *no* selection, so the buttons go back to
    // meaning "the whole hunk" rather than meaning nothing.
    expect(second.selection).toBeNull();
    expect(second.anchor).toBeNull();
  });

  it("accumulates plain clicks in order regardless of the order clicked", () => {
    let s = applyLineClick(null, null, HUNK, 0, 4, false);
    s = applyLineClick(s.selection, s.anchor, HUNK, 0, 1, false);
    expect(s.selection).toEqual({ hunkIndex: 0, lines: [1, 4] });
  });

  /// Shift-click fills the run between the anchor and the click, skipping the
  /// context lines in between — a selection that included context would ask
  /// for lines that are not a choice.
  it("selects the changed lines between the anchor and a shift-click", () => {
    const anchored = applyLineClick(null, null, HUNK, 0, 1, false);
    const ranged = applyLineClick(anchored.selection, anchored.anchor, HUNK, 0, 4, true);
    expect(ranged.selection).toEqual({ hunkIndex: 0, lines: [1, 2, 3, 4] });
    // The anchor stays put, so a second shift-click re-ranges rather than
    // walking the anchor along behind the cursor.
    expect(ranged.anchor).toBe(1);
    const narrowed = applyLineClick(ranged.selection, ranged.anchor, HUNK, 0, 2, true);
    expect(narrowed.selection).toEqual({ hunkIndex: 0, lines: [1, 2] });
  });

  it("works backwards as well as forwards", () => {
    const anchored = applyLineClick(null, null, HUNK, 0, 4, false);
    const ranged = applyLineClick(anchored.selection, anchored.anchor, HUNK, 0, 2, true);
    expect(ranged.selection).toEqual({ hunkIndex: 0, lines: [2, 3, 4] });
  });

  /// A selection spanning two hunks would have to become two patches, and the
  /// second failing after the first landed is a half-applied action with no
  /// undo. Clicking into another hunk starts over instead.
  it("starts over when the click lands in a different hunk", () => {
    const first = applyLineClick(null, null, HUNK, 0, 1, false);
    const other = applyLineClick(first.selection, first.anchor, HUNK, 1, 3, false);
    expect(other.selection).toEqual({ hunkIndex: 1, lines: [3] });
  });

  it("shift-clicking into a different hunk starts over too, not a cross-hunk range", () => {
    const first = applyLineClick(null, null, HUNK, 0, 1, false);
    const other = applyLineClick(first.selection, first.anchor, HUNK, 1, 4, true);
    expect(other.selection).toEqual({ hunkIndex: 1, lines: [4] });
  });

  it("ignores a click on a context line", () => {
    const s = applyLineClick(null, null, HUNK, 0, 0, false);
    expect(s.selection).toBeNull();
  });
});

describe("what the button says", () => {
  /// Zero is the caller's signal to act on the whole hunk, which is why the
  /// count has to be per hunk and not per file.
  it("counts only the hunk it is asked about", () => {
    const sel = { hunkIndex: 1, lines: [3, 4] };
    expect(selectionSizeFor(sel, 1)).toBe(2);
    expect(selectionSizeFor(sel, 0)).toBe(0);
    expect(selectionSizeFor(null, 1)).toBe(0);
  });
});
