/// Which two refs answer "what did this commit change?".
///
/// The audit's remaining `${sha}^` gap: two call sites hold nothing but a hash
/// scraped out of text — terminal output, a blame chip — and both built the
/// base ref by hand, so a root commit clicked from either opened a compare tab
/// onto `revspec not found`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockTauri, resetTauri, tauriCalls } from "@/test/tauri";
import { EMPTY_TREE_OID, commitDiffBase, resolveCommitDiffBase } from "./commitDiff";

/// Declared here rather than inherited: the unit project loads no setup file,
/// deliberately — see `vitest.config.ts`. This is the one seam this test needs,
/// and it is the process boundary, so `@/api/git` still runs for real and the
/// test would notice `git_log` being sent the wrong argument name.
vi.mock("@tauri-apps/api/core", async () => {
  const { fakeInvoke, MockChannel } = await import("@/test/tauri");
  return { invoke: fakeInvoke, Channel: MockChannel };
});

afterEach(() => resetTauri());

const REPO = "/repos/api";
const SHA = "0123456789abcdef0123456789abcdef01234567";

function commit(parentOids: string[]) {
  return {
    oid: SHA,
    summary: "s",
    body: null,
    authorName: "a",
    authorEmail: "a@b",
    time: 0,
    parentOids,
  };
}

describe("commitDiffBase", () => {
  it("uses the first parent", () => {
    expect(commitDiffBase(["p1", "p2"])).toBe("p1");
  });

  /// A root commit has no parent, and using the commit itself as the base
  /// reports that it changed nothing — the opposite of true for the commit that
  /// created the repository.
  it("falls back to the empty tree for a root commit", () => {
    expect(commitDiffBase([])).toBe(EMPTY_TREE_OID);
  });
});

describe("resolveCommitDiffBase", () => {
  it("asks git for the parent instead of assembling a revspec", async () => {
    mockTauri({ git_log: [commit(["parent-sha"])] });
    expect(await resolveCommitDiffBase(REPO, SHA)).toBe("parent-sha");
    // One commit, not a whole page: this is a lookup, not a history read.
    expect(tauriCalls("git_log")[0].args).toMatchObject({ branch: SHA, limit: 1 });
  });

  /// The finding. `${sha}^` does not resolve here and the tab errored.
  it("gives a root commit the empty tree", async () => {
    mockTauri({ git_log: [commit([])] });
    expect(await resolveCommitDiffBase(REPO, SHA)).toBe(EMPTY_TREE_OID);
  });

  /// Deliberately *not* the empty tree. If the SHA cannot be resolved at all
  /// then neither can the compare tab, and it should say so in its own words —
  /// diffing an unresolvable ref against the empty tree would render the whole
  /// repository as added, which looks like an answer and is not one.
  it("keeps the old revspec when the lookup fails", async () => {
    mockTauri({
      git_log: () => {
        throw new Error("revspec 'nope' not found");
      },
    });
    expect(await resolveCommitDiffBase(REPO, "nope")).toBe("nope^");
  });

  it("keeps the old revspec when git returns nothing", async () => {
    mockTauri({ git_log: [] });
    expect(await resolveCommitDiffBase(REPO, SHA)).toBe(`${SHA}^`);
  });
});
