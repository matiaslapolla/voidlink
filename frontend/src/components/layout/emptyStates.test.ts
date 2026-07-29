/// The empty-state rule that is worth a test rather than a screenshot review.
///
/// §9.7 fixes the shape, but the property that decides whether ten empty
/// states are usable is that no two share an icon or a sentence — otherwise
/// "no worktrees", "no tabs" and "no stashes" all read as the same grey shrug.
/// Enumerating them in one registry is what makes that checkable at all.
import { describe, expect, it } from "vitest";
import { EMPTY_STATES, emptyStateCollisions } from "./emptyStates";

describe("empty states", () => {
  it("has no two sharing an icon or a sentence", () => {
    expect(emptyStateCollisions()).toEqual([]);
  });

  it("covers every surface the design brief enumerates", () => {
    expect(Object.keys(EMPTY_STATES).sort()).toEqual(
      [
        "changesClean",
        "changesNoMatch",
        "editorNoFile",
        "groupNoTabs",
        "snapshotsEmpty",
        "stashesEmpty",
        "tagsEmpty",
        "workspaceNoWorktrees",
        "worktreeNoTabs",
        "worktreesSingle",
      ].sort(),
    );
  });

  /// One line, naming *why* it is empty. Not a paragraph, and not "No items".
  it("says why rather than what", () => {
    for (const [id, copy] of Object.entries(EMPTY_STATES)) {
      expect(copy.line.length, id).toBeLessThan(80);
      expect(copy.line.split("\n"), id).toHaveLength(1);
    }
  });
});
