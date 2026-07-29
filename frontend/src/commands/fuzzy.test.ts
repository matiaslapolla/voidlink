/// The shared matcher. Its scores were already load-bearing (two copies of them
/// ranked the palette and the file finder); what is new and worth pinning is
/// `ranges` — the palette, the file finder and both switchers tint exactly what
/// this returns, so an off-by-one here is a visible one.
import { describe, expect, it } from "vitest";
import { bestFuzzyMatch, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches everything at rest, with nothing highlighted", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ score: 0, ranges: [] });
  });

  it("returns null when the characters are not there in order", () => {
    expect(fuzzyMatch("abc", "cb")).toBeNull();
    expect(fuzzyMatch("abc", "abcd")).toBeNull();
  });

  it("highlights a contiguous substring as one range", () => {
    expect(fuzzyMatch("commit graph", "mit")?.ranges).toEqual([[3, 6]]);
  });

  it("is case-insensitive but highlights the original casing's positions", () => {
    expect(fuzzyMatch("CommitGraph", "graph")?.ranges).toEqual([[6, 11]]);
  });

  it("merges adjacent subsequence hits into runs", () => {
    // Leftmost-greedy: "tog h" hits t(0) o(1) g(2), the space at 6, h at 11.
    // The first three collapse into one range rather than three.
    expect(fuzzyMatch("toggle graph", "tog h")?.ranges).toEqual([
      [0, 3],
      [6, 7],
      [11, 12],
    ]);
  });

  it("prefers an earlier substring match", () => {
    const early = fuzzyMatch("stage all", "st")!;
    const late = fuzzyMatch("unstage all", "st")!;
    expect(early.score).toBeGreaterThan(late.score);
  });

  it("prefers a substring over a scattered subsequence", () => {
    const substring = fuzzyMatch("open file", "file")!;
    const scattered = fuzzyMatch("fetch invalid lever", "file")!;
    expect(substring.score).toBeGreaterThan(scattered.score);
  });

  it("penalises gaps in a subsequence match", () => {
    const tight = fuzzyMatch("abc", "ac")!;
    const loose = fuzzyMatch("axxxxc", "ac")!;
    expect(tight.score).toBeGreaterThan(loose.score);
  });

  describe("pathAware", () => {
    it("ranks a hit in the file name above the same hit in a directory", () => {
      const inName = fuzzyMatch("src/store/layout.ts", "layout", { pathAware: true })!;
      const inDir = fuzzyMatch("src/layout/store.ts", "layout", { pathAware: true })!;
      expect(inName.score).toBeGreaterThan(inDir.score);
    });

    it("changes nothing when the flag is off", () => {
      const a = fuzzyMatch("src/store/layout.ts", "layout")!;
      const b = fuzzyMatch("src/layout/store.ts", "layout")!;
      expect(a.score).toBeLessThan(b.score);
    });
  });
});

describe("bestFuzzyMatch", () => {
  it("reports which field won, so the row highlights the text it matched", () => {
    const best = bestFuzzyMatch(["Refresh git status", "Git"], "git")!;
    expect(best.field).toBe(1);
  });

  it("prefers the field with the better score", () => {
    const best = bestFuzzyMatch(["git", "Terminal"], "git")!;
    expect(best.field).toBe(0);
    expect(best.match.ranges).toEqual([[0, 3]]);
  });

  it("is null only when no field matches", () => {
    expect(bestFuzzyMatch(["alpha", "beta"], "zz")).toBeNull();
  });

  it("matches every row on an empty query", () => {
    expect(bestFuzzyMatch(["alpha", ""], "")).toEqual({
      field: 0,
      match: { score: 0, ranges: [] },
    });
  });
});
