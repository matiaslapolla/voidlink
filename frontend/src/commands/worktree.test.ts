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
