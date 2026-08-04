/// Folding two git diffs into one list.
///
/// The case every assertion circles is the partially-staged file: stage a
/// function, keep editing it, and one path is in both diffs with two genuinely
/// different sets of hunks. Listing it twice misreports how many files changed;
/// listing it once and keeping one diff misreports what changed. It has to
/// appear once and carry both.
import { describe, expect, it } from "vitest";
import type { FileDiff } from "@/types/git";
import {
  assembleCombinedDiff,
  combinedRows,
  pathOf,
  untrackedExplanation,
} from "./combinedDiff";

function file(
  path: string,
  over: Partial<FileDiff> = {},
): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    status: "modified",
    hunks: [],
    isBinary: false,
    additions: 1,
    deletions: 1,
    oldBlobOid: null,
    ...over,
  };
}

describe("assembling the two diffs", () => {
  it("sections files by which diff they came from", () => {
    const out = assembleCombinedDiff({
      staged: [file("a.ts")],
      unstaged: [file("b.ts"), file("c.ts", { status: "untracked" })],
    });
    expect(out.groups.map((g) => g.section)).toEqual(["staged", "unstaged", "untracked"]);
    expect(out.groups[0].entries.map((e) => e.path)).toEqual(["a.ts"]);
    expect(out.groups[1].entries.map((e) => e.path)).toEqual(["b.ts"]);
    expect(out.groups[2].entries.map((e) => e.path)).toEqual(["c.ts"]);
  });

  it("omits a section nothing is in, rather than showing an empty heading", () => {
    const out = assembleCombinedDiff({ staged: [file("a.ts")], unstaged: [] });
    expect(out.groups.map((g) => g.section)).toEqual(["staged"]);
  });

  it("sorts by path inside a section", () => {
    const out = assembleCombinedDiff({
      staged: [file("z.ts"), file("a.ts"), file("m.ts")],
      unstaged: [],
    });
    expect(out.entries.map((e) => e.path)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("is empty for a clean worktree", () => {
    const out = assembleCombinedDiff({ staged: [], unstaged: [] });
    expect(out.entries).toEqual([]);
    expect(out.groups).toEqual([]);
    expect(out.totalAdditions).toBe(0);
    expect(out.partiallyStagedCount).toBe(0);
  });
});

describe("a file that is staged AND modified", () => {
  const both = () =>
    assembleCombinedDiff({
      staged: [file("src/parse.ts", { additions: 10, deletions: 2 })],
      unstaged: [file("src/parse.ts", { additions: 3, deletions: 1 })],
    });

  /// The headline requirement: once, not twice.
  it("appears exactly once", () => {
    const out = both();
    expect(out.entries).toHaveLength(1);
    expect(out.entries.filter((e) => e.path === "src/parse.ts")).toHaveLength(1);
  });

  it("carries both diffs, in staged-then-unstaged order", () => {
    const [entry] = both().entries;
    expect(entry.states.map((s) => s.section)).toEqual(["staged", "unstaged"]);
    expect(entry.states[0].file.additions).toBe(10);
    expect(entry.states[1].file.additions).toBe(3);
  });

  /// Filed under staged, because that is the first section it belongs to and
  /// the one a commit would take.
  it("is filed under the first section it belongs to", () => {
    expect(both().entries[0].section).toBe("staged");
    expect(both().groups.map((g) => g.section)).toEqual(["staged"]);
  });

  it("totals the whole change on the row, not half of it", () => {
    const [entry] = both().entries;
    expect(entry.additions).toBe(13);
    expect(entry.deletions).toBe(3);
  });

  /// "3 files are partly staged" is the most surprising thing a working tree
  /// can be, and nothing else in the app says it.
  it("is counted as partially staged", () => {
    expect(both().partiallyStagedCount).toBe(1);
    const single = assembleCombinedDiff({ staged: [file("a.ts")], unstaged: [file("b.ts")] });
    expect(single.partiallyStagedCount).toBe(0);
  });

  it("does not double-count in the totals", () => {
    const out = both();
    expect(out.totalAdditions).toBe(13);
    expect(out.totalDeletions).toBe(3);
  });
});

describe("untracked files", () => {
  /// They arrive inside the unstaged diff, tagged by status. Splitting on
  /// status rather than fetching a third list is what stops the two from
  /// disagreeing about which files exist.
  it("are separated out of the unstaged diff by status", () => {
    const out = assembleCombinedDiff({
      staged: [],
      unstaged: [file("tracked.ts"), file("new.ts", { status: "untracked", oldPath: null })],
    });
    expect(out.groups.find((g) => g.section === "unstaged")!.entries.map((e) => e.path)).toEqual([
      "tracked.ts",
    ]);
    expect(out.groups.find((g) => g.section === "untracked")!.entries.map((e) => e.path)).toEqual([
      "new.ts",
    ]);
  });

  /// The legibility requirement. All-green with nothing to explain it is
  /// indistinguishable from a total rewrite.
  it("come with a sentence saying why every line is an addition", () => {
    const f = file("new.ts", { status: "untracked", oldPath: null, additions: 400, deletions: 0 });
    expect(untrackedExplanation(f)).toContain("no previous version");
    expect(untrackedExplanation(f)).toContain("400 lines");
    expect(untrackedExplanation({ ...f, additions: 1 })).toContain("1 line are");
  });
});

describe("what it refuses to be confused by", () => {
  /// libgit2 emits one delta per path, but the assembly must not depend on
  /// that: a duplicate would double the additions and the total would be
  /// silently wrong rather than visibly broken.
  it("deduplicates within one diff", () => {
    const out = assembleCombinedDiff({
      staged: [file("a.ts", { additions: 5 }), file("a.ts", { additions: 5 })],
      unstaged: [],
    });
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].additions).toBe(5);
    expect(out.entries[0].states).toHaveLength(1);
  });

  it("drops a delta with no path at all rather than listing an unnamed row", () => {
    const out = assembleCombinedDiff({
      staged: [{ ...file("x"), oldPath: null, newPath: null }],
      unstaged: [],
    });
    expect(out.entries).toEqual([]);
  });

  /// A deletion has only an old path; an addition only a new one. Both are
  /// addressable and both must be listed.
  it("identifies a file by its new path, falling back to the old one", () => {
    expect(pathOf(file("a.ts", { oldPath: "was.ts" }))).toBe("a.ts");
    expect(pathOf({ ...file("a.ts"), newPath: null })).toBe("a.ts");
  });

  it("records a rename on the row so the header can show both names", () => {
    const out = assembleCombinedDiff({
      staged: [file("new.ts", { oldPath: "old.ts", status: "renamed" })],
      unstaged: [],
    });
    expect(out.entries[0].renamedFrom).toBe("old.ts");
    expect(
      assembleCombinedDiff({ staged: [file("same.ts")], unstaged: [] }).entries[0].renamedFrom,
    ).toBeNull();
  });
});

describe("the rows a windowed list renders", () => {
  const diff = () =>
    assembleCombinedDiff({
      staged: [file("a.ts"), file("b.ts")],
      unstaged: [file("b.ts"), file("c.ts", { status: "untracked" })],
    });

  /// The property the whole design rests on: hundreds of files cost hundreds
  /// of *header* rows and not one hunk until something is opened.
  it("gives a collapsed file exactly one row", () => {
    const rows = combinedRows(diff(), () => false);
    expect(rows.filter((r) => r.kind === "body")).toHaveLength(0);
    expect(rows.map((r) => r.key)).toEqual([
      "section:staged",
      "file:a.ts",
      "file:b.ts",
      "section:untracked",
      "file:c.ts",
    ]);
  });

  it("adds one body row per state when a file is expanded", () => {
    const rows = combinedRows(diff(), (p) => p === "b.ts");
    expect(rows.map((r) => r.key)).toEqual([
      "section:staged",
      "file:a.ts",
      "file:b.ts",
      "body:b.ts:staged",
      "body:b.ts:unstaged",
      "section:untracked",
      "file:c.ts",
    ]);
  });

  /// Two states of one file produce two body rows that must not share a key,
  /// or the windowing would reuse one element for both and the second diff
  /// would render the first one's hunks.
  it("keys the two bodies of a partially-staged file apart", () => {
    const rows = combinedRows(diff(), () => true);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("counts each section on its heading row", () => {
    const rows = combinedRows(diff(), () => false);
    const sections = rows.filter((r) => r.kind === "section");
    expect(sections.map((s) => [s.section, s.count])).toEqual([
      ["staged", 2],
      ["untracked", 1],
    ]);
  });

  it("renders nothing at all for a clean worktree", () => {
    expect(combinedRows(assembleCombinedDiff({ staged: [], unstaged: [] }), () => true)).toEqual([]);
  });
});
