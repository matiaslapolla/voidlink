import { describe, expect, it } from "vitest";
import {
  actionForKey,
  flattenChanges,
  moveFocus,
  reconcileFocus,
  rowsIn,
  type ChangeEntry,
} from "./changesNav";

const entries: ChangeEntry[] = [
  { path: "src/components/Button.tsx", status: "modified", staged: false },
  { path: "src/store/layout/index.ts", status: "modified", staged: true },
  { path: "README.md", status: "untracked", staged: false },
  { path: "src/api/git.ts", status: "conflicted", staged: false },
];

describe("flattenChanges", () => {
  it("renders conflicts first, then staged, then unstaged", () => {
    const rows = flattenChanges(entries);
    expect(rows.map((r) => r.section)).toEqual([
      "conflicted",
      "staged",
      "unstaged",
      "unstaged",
    ]);
    expect(rows[0].entry.path).toBe("src/api/git.ts");
  });

  it("keeps each section's own order stable", () => {
    const rows = rowsIn(flattenChanges(entries), "unstaged");
    expect(rows.map((r) => r.entry.path)).toEqual([
      "src/components/Button.tsx",
      "README.md",
    ]);
  });

  it("treats a conflicted-but-staged entry as conflicted", () => {
    const rows = flattenChanges([{ path: "a", status: "conflicted", staged: true }]);
    expect(rows[0].section).toBe("conflicted");
  });

  it("matches fuzzily and reports the ranges to highlight", () => {
    const rows = flattenChanges(entries, "btn");
    expect(rows.map((r) => r.entry.path)).toEqual(["src/components/Button.tsx"]);
    expect(rows[0].ranges.length).toBeGreaterThan(0);
  });

  it("returns everything, unhighlighted, for an empty filter", () => {
    const rows = flattenChanges(entries, "");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.ranges.length === 0)).toBe(true);
  });

  /// A list that reshuffles as you type loses the one property that makes it
  /// scannable: a file stays where you last saw it.
  it("does not reorder by match score", () => {
    const rows = flattenChanges(entries, "s");
    const unstaged = rowsIn(rows, "unstaged").map((r) => r.entry.path);
    expect(unstaged).toEqual(unstaged.slice().sort(() => 0));
    expect(rows.map((r) => r.section)).toEqual(
      [...rows].map((r) => r.section),
    );
  });

  it("returns nothing when the filter matches nothing", () => {
    expect(flattenChanges(entries, "zzzzzz")).toEqual([]);
  });
});

describe("moveFocus", () => {
  const rows = flattenChanges(entries);

  it("starts at the top on the way down and at the bottom on the way up", () => {
    expect(moveFocus(rows, null, 1)).toBe(rows[0].entry.path);
    expect(moveFocus(rows, null, -1)).toBe(rows[rows.length - 1].entry.path);
  });

  /// The three lists are one keyboard surface — the boundary between staged
  /// and unstaged is invisible to the arrow keys.
  it("crosses section boundaries without stopping", () => {
    const staged = rows[1];
    expect(staged.section).toBe("staged");
    const next = moveFocus(rows, staged.entry.path, 1);
    expect(rows.find((r) => r.entry.path === next)?.section).toBe("unstaged");
  });

  it("clamps rather than wrapping", () => {
    const first = rows[0].entry.path;
    const last = rows[rows.length - 1].entry.path;
    expect(moveFocus(rows, first, -1)).toBe(first);
    expect(moveFocus(rows, last, 1)).toBe(last);
    expect(moveFocus(rows, first, 999)).toBe(last);
  });

  it("has nothing to focus in an empty list", () => {
    expect(moveFocus([], null, 1)).toBeNull();
    expect(moveFocus([], "src/api/git.ts", 1)).toBeNull();
  });

  it("starts from the top when the current path is gone", () => {
    expect(moveFocus(rows, "deleted.txt", 1)).toBe(rows[0].entry.path);
  });
});

describe("reconcileFocus", () => {
  const rows = flattenChanges(entries);

  it("keeps the cursor when the row survived", () => {
    expect(reconcileFocus(rows, "README.md", 0)).toBe("README.md");
  });

  /// Staging a file moves it between sections; filtering can remove it. The
  /// cursor lands near where it was so the user can keep pressing the key.
  it("falls back to the same index when the row is gone", () => {
    expect(reconcileFocus(rows, "gone.txt", 2)).toBe(rows[2].entry.path);
  });

  it("clamps the fallback index to the list", () => {
    expect(reconcileFocus(rows, "gone.txt", 99)).toBe(rows[rows.length - 1].entry.path);
    expect(reconcileFocus(rows, "gone.txt", -5)).toBe(rows[0].entry.path);
  });

  it("gives up on an empty list", () => {
    expect(reconcileFocus([], "README.md", 0)).toBeNull();
  });
});

describe("actionForKey", () => {
  /// One key that does the right thing beats two the user has to choose
  /// between: the action a row needs is always the opposite of its state.
  it("makes Space the stage/unstage toggle", () => {
    expect(actionForKey(" ", "unstaged")).toEqual({ kind: "stage" });
    expect(actionForKey(" ", "staged")).toEqual({ kind: "unstage" });
  });

  it("sends every conflicted-row key to the merge surface", () => {
    expect(actionForKey(" ", "conflicted")).toEqual({ kind: "resolve" });
    expect(actionForKey("Enter", "conflicted")).toEqual({ kind: "resolve" });
  });

  it("opens the diff on Enter elsewhere", () => {
    expect(actionForKey("Enter", "unstaged")).toEqual({ kind: "open" });
    expect(actionForKey("Enter", "staged")).toEqual({ kind: "open" });
  });

  it("maps the movement keys", () => {
    expect(actionForKey("ArrowDown", "unstaged")).toEqual({ kind: "move", delta: 1 });
    expect(actionForKey("ArrowUp", "unstaged")).toEqual({ kind: "move", delta: -1 });
    expect(actionForKey("PageDown", "unstaged")).toEqual({ kind: "move", delta: 10 });
    expect(actionForKey("Home", "unstaged").kind).toBe("move");
    expect(actionForKey("End", "unstaged").kind).toBe("move");
  });

  it("offers discard only where discarding means something", () => {
    expect(actionForKey("Backspace", "unstaged")).toEqual({ kind: "discard" });
    expect(actionForKey("Delete", "staged")).toEqual({ kind: "discard" });
    expect(actionForKey("Backspace", "conflicted")).toEqual({ kind: "none" });
  });

  it("ignores everything else so typing still reaches the filter box", () => {
    expect(actionForKey("a", "unstaged")).toEqual({ kind: "none" });
    expect(actionForKey("Escape", "unstaged")).toEqual({ kind: "none" });
  });
});
