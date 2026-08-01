import { describe, expect, it } from "vitest";
import { isOverlayOpen } from "./overlay";
import { clearNewWorktreeRequest, requestNewWorktree } from "./worktree";

// The wizard's open state is "is a request queued" (`NewWorktreeRequest |
// null`), not a plain boolean, so it cannot be a `createOverlay` — it
// registers with `setOverlayOpen` directly at the two points its own state
// changes. This is the exception path `commands/overlay.ts` documents; these
// tests are here to prove that path still stacks and un-registers correctly,
// the same way `createOverlay` does for the boolean overlays.
describe("worktree wizard — overlay registration", () => {
  it("registers open on request and closed on clear", () => {
    expect(isOverlayOpen()).toBe(false);
    requestNewWorktree({ workspaceId: "w1", repoRoot: "/repo" });
    expect(isOverlayOpen()).toBe(true);
    clearNewWorktreeRequest();
    expect(isOverlayOpen()).toBe(false);
  });

  it("a second request while one is already queued does not double-register", () => {
    requestNewWorktree({ workspaceId: "w1", repoRoot: "/repo" });
    // No-op per `requestNewWorktree`'s own guard — a request is already queued.
    requestNewWorktree({ workspaceId: "w2", repoRoot: "/other" });
    expect(isOverlayOpen()).toBe(true);
    clearNewWorktreeRequest();
    expect(isOverlayOpen()).toBe(false);
  });
});

import { classifyWorktreeBranch, defaultWorktreePath, worktreeSlug } from "./worktree";

const local = (name: string) => ({ name, isRemote: false });
const remote = (name: string) => ({ name, isRemote: true });

/// WT-D4. The wizard asked for **local** branches only, so a branch that
/// existed solely on a remote read as brand new: it branched off HEAD under a
/// name already taken upstream, with no tracking and no warning.
describe("classifyWorktreeBranch", () => {
  it("checks out a branch that exists locally", () => {
    const out = classifyWorktreeBranch("feature/x", [
      local("feature/x"),
      remote("origin/feature/x"),
    ]);
    expect(out.kind).toBe("local");
  });

  it("tracks a branch that only exists on a remote", () => {
    const out = classifyWorktreeBranch("feature/x", [
      local("main"),
      remote("origin/feature/x"),
    ]);
    expect(out).toEqual({ kind: "remote", trackingRef: "origin/feature/x" });
  });

  it("creates a new branch when nothing anywhere carries the name", () => {
    expect(classifyWorktreeBranch("feature/new", [local("main")]).kind).toBe("new");
  });

  /// Git only DWIMs a tracking branch when exactly one remote has the name.
  /// Two is not a branch we can pick for the user.
  it("declines to guess when two remotes carry the same name", () => {
    const out = classifyWorktreeBranch("feature/x", [
      remote("origin/feature/x"),
      remote("upstream/feature/x"),
    ]);
    expect(out.kind).toBe("new");
  });

  /// The branch name may itself contain slashes, so the match is on the
  /// suffix — splitting on the first `/` would make `origin/feature/x` look
  /// like a remote called `origin` with a branch called `feature`.
  it("matches a slashed branch name against the remote's full ref", () => {
    const out = classifyWorktreeBranch("release/2026/07", [
      remote("origin/release/2026/07"),
    ]);
    expect(out.trackingRef).toBe("origin/release/2026/07");
  });

  /// `origin/x` as a *remote row* must not satisfy a query for the branch
  /// literally named `origin/x` by matching itself with an empty remote.
  it("does not treat a remote row as its own remote", () => {
    expect(classifyWorktreeBranch("origin/x", [remote("origin/x")]).kind).toBe("new");
  });

  it("treats whitespace and an empty name as new rather than throwing", () => {
    expect(classifyWorktreeBranch("  ", [local("main")]).kind).toBe("new");
    expect(classifyWorktreeBranch("  main  ", [local("main")]).kind).toBe("local");
  });
});

describe("worktree paths", () => {
  it("collapses slashes so a branch name stays one directory", () => {
    expect(worktreeSlug("feat/foo")).toBe("feat-foo");
    expect(defaultWorktreePath("/repos/api/", "feat/foo")).toBe(
      "/repos/api/.worktrees/feat-foo",
    );
  });
});
