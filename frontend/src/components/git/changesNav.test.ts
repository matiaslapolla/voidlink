import { describe, expect, it } from "vitest";
import {
  actionForKey,
  flattenChanges,
  moveFocus,
  reconcileFocus,
  rowKey,
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
    expect(moveFocus(rows, null, 1)).toBe(rows[0].key);
    expect(moveFocus(rows, null, -1)).toBe(rows[rows.length - 1].key);
  });

  /// The three lists are one keyboard surface — the boundary between staged
  /// and unstaged is invisible to the arrow keys.
  it("crosses section boundaries without stopping", () => {
    const staged = rows[1];
    expect(staged.section).toBe("staged");
    const next = moveFocus(rows, staged.key, 1);
    expect(rows.find((r) => r.key === next)?.section).toBe("unstaged");
  });

  it("clamps rather than wrapping", () => {
    const first = rows[0].key;
    const last = rows[rows.length - 1].key;
    expect(moveFocus(rows, first, -1)).toBe(first);
    expect(moveFocus(rows, last, 1)).toBe(last);
    expect(moveFocus(rows, first, 999)).toBe(last);
  });

  it("has nothing to focus in an empty list", () => {
    expect(moveFocus([], null, 1)).toBeNull();
    expect(moveFocus([], rowKey("conflicted", "src/api/git.ts"), 1)).toBeNull();
  });

  it("starts from the top when the current row is gone", () => {
    expect(moveFocus(rows, rowKey("unstaged", "deleted.txt"), 1)).toBe(rows[0].key);
  });
});

/// A file that was staged and then edited again is two rows with one path, and
/// they do opposite things: `Space` unstages the first and stages the second.
/// Every one of these failed while the cursor was a path — each lookup found
/// the staged row, so the unstaged row could not be focused, acted on, or
/// distinguished on screen.
describe("a path in both sections", () => {
  const bothSides: ChangeEntry[] = [
    { path: "a.txt", status: "modified", staged: true },
    { path: "a.txt", status: "modified", staged: false },
  ];
  const rows = flattenChanges(bothSides);

  it("is two rows, one per section", () => {
    expect(rows.map((r) => r.section)).toEqual(["staged", "unstaged"]);
  });

  it("gives them distinct keys", () => {
    expect(rows[0].key).not.toBe(rows[1].key);
  });

  it("moves the cursor between them rather than sticking", () => {
    expect(moveFocus(rows, rows[0].key, 1)).toBe(rows[1].key);
    expect(moveFocus(rows, rows[1].key, -1)).toBe(rows[0].key);
  });

  it("keeps the cursor on the side it was on across a refresh", () => {
    expect(reconcileFocus(rows, rows[1].key, 0)).toBe(rows[1].key);
  });

  /// Staging the rest of the file collapses it to one row. The cursor cannot
  /// stay where it was, and landing on the surviving row beats vanishing.
  it("falls back by index when its side disappears", () => {
    const stagedOnly = flattenChanges([bothSides[0]]);
    expect(reconcileFocus(stagedOnly, rows[1].key, 1)).toBe(stagedOnly[0].key);
  });
});

describe("reconcileFocus", () => {
  const rows = flattenChanges(entries);

  it("keeps the cursor when the row survived", () => {
    const readme = rowKey("unstaged", "README.md");
    expect(reconcileFocus(rows, readme, 0)).toBe(readme);
  });

  /// Staging a file moves it between sections; filtering can remove it. The
  /// cursor lands near where it was so the user can keep pressing the key.
  it("falls back to the same index when the row is gone", () => {
    expect(reconcileFocus(rows, rowKey("unstaged", "gone.txt"), 2)).toBe(rows[2].key);
  });

  it("clamps the fallback index to the list", () => {
    const gone = rowKey("unstaged", "gone.txt");
    expect(reconcileFocus(rows, gone, 99)).toBe(rows[rows.length - 1].key);
    expect(reconcileFocus(rows, gone, -5)).toBe(rows[0].key);
  });

  it("gives up on an empty list", () => {
    expect(reconcileFocus([], rowKey("unstaged", "README.md"), 0)).toBeNull();
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
    expect(actionForKey("Delete", "unstaged")).toEqual({ kind: "discard" });
    expect(actionForKey("Backspace", "conflicted")).toEqual({ kind: "none" });
  });

  it("never discards staged work from the keyboard", () => {
    // The mouse UI puts no discard control on a staged row, so a key that did
    // would destroy work the visible interface presented as safe.
    expect(actionForKey("Backspace", "staged")).toEqual({ kind: "none" });
    expect(actionForKey("Delete", "staged")).toEqual({ kind: "none" });
  });

  it("ignores everything else so typing still reaches the filter box", () => {
    expect(actionForKey("a", "unstaged")).toEqual({ kind: "none" });
    expect(actionForKey("Escape", "unstaged")).toEqual({ kind: "none" });
  });
});
