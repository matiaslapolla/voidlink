import { describe, expect, it } from "vitest";
import { isDirtyRefusal, isLockRefusal } from "./worktreeRemove";

/// The classification is the whole safety property: `--force` on a
/// `git worktree remove` discards uncommitted work, so offering it for a
/// failure it cannot fix routes the user to a destructive button for no
/// reason — and one of the three implementations of this flow did exactly that
/// on *every* error.
describe("isDirtyRefusal", () => {
  it("recognises the wordings git actually uses for uncommitted work", () => {
    expect(isDirtyRefusal("fatal: 'wt' contains modified or untracked files, use --force to delete it")).toBe(true);
    expect(isDirtyRefusal("worktree is dirty")).toBe(true);
  });

  /// git writes `use 'remove -f -f'` for a locked worktree and `use 'remove -f'`
  /// for a dirty one. Matching the closing quote meant the locked wording
  /// never matched, which is how a locked worktree became a dead end.
  it("matches both the one-f and two-f wordings", () => {
    expect(isDirtyRefusal("use 'remove -f' to override")).toBe(true);
    expect(isDirtyRefusal("is locked; use 'remove -f -f' to override")).toBe(true);
  });

  it("does not offer force for failures force cannot fix", () => {
    expect(isDirtyRefusal("Permission denied (os error 13)")).toBe(false);
    expect(isDirtyRefusal("fatal: Unable to create '/repo/.git/index.lock': File exists")).toBe(false);
    expect(isDirtyRefusal("No such file or directory")).toBe(false);
  });
});

describe("isLockRefusal", () => {
  /// A lock is not discarded by `--force`; it is cleared by
  /// `git worktree unlock`. Sending force at a lock fails a second time and
  /// tells the user nothing new, so the two cases have to be told apart.
  it("separates a lock from ordinary dirtiness", () => {
    expect(isLockRefusal("fatal: 'wt' is locked; use 'remove -f -f' to override")).toBe(true);
    expect(isLockRefusal("contains modified or untracked files")).toBe(false);
  });
});
