/// The write policy for the event log.
///
/// The transport is stubbed — what is under test is the three promises
/// `store/journal.ts` makes to its callers, because every one of them is a
/// promise other modules were allowed to stop thinking about:
///
///   1. A burst is one round trip.
///   2. `repo` is filled in when the caller did not know it, and never when the
///      caller did.
///   3. Recording cannot throw, reject, or otherwise reach the caller's error
///      path — that is what makes it safe to drop a `record()` into an existing
///      handler without re-reading it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const append = vi.fn();
const registerRepos = vi.fn();

vi.mock("@/api/journal", () => ({
  JOURNAL_APPENDED_EVENT: "voidlink://journal-appended",
  journalApi: {
    append: (events: unknown) => append(events),
    registerRepos: (repos: unknown) => registerRepos(repos),
  },
}));

import {
  JOURNAL_BATCH_MS,
  record,
  flushJournal,
  publishRepos,
  repoIdentities,
  resetJournal,
  setJournalRepo,
} from "./journal";
import { makeWorktree, type Workspace } from "@/types/workspace";

/// The events handed to the transport across every call so far, flattened.
function sent(): { kind: string; repo?: string; summary: string }[] {
  return append.mock.calls.flatMap((call) => call[0] as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  append.mockReset();
  append.mockResolvedValue([]);
  registerRepos.mockReset();
  registerRepos.mockResolvedValue(undefined);
  resetJournal();
});

afterEach(() => {
  resetJournal();
  vi.useRealTimers();
});

describe("batching", () => {
  it("collapses a burst into one round trip", () => {
    record({ kind: "a", summary: "one" });
    record({ kind: "b", summary: "two" });
    record({ kind: "c", summary: "three" });
    expect(append).not.toHaveBeenCalled();

    vi.advanceTimersByTime(JOURNAL_BATCH_MS);
    expect(append).toHaveBeenCalledTimes(1);
    expect(sent().map((e) => e.kind)).toEqual(["a", "b", "c"]);
  });

  it("starts a fresh window after one closes, rather than one timer forever", () => {
    record({ kind: "a", summary: "one" });
    vi.advanceTimersByTime(JOURNAL_BATCH_MS);
    record({ kind: "b", summary: "two" });
    vi.advanceTimersByTime(JOURNAL_BATCH_MS);
    expect(append).toHaveBeenCalledTimes(2);
    expect(sent().map((e) => e.kind)).toEqual(["a", "b"]);
  });

  /// `pagehide` calls this. The events most likely to be queued at that moment
  /// are the last things that happened before a quit — exactly what the next
  /// session's "what happened yesterday" wants.
  it("flushes on demand without waiting for the window", () => {
    record({ kind: "a", summary: "one" });
    flushJournal();
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("flushing an empty queue sends nothing", () => {
    flushJournal();
    expect(append).not.toHaveBeenCalled();
  });

  it("does not re-send a batch that already went out", () => {
    record({ kind: "a", summary: "one" });
    flushJournal();
    vi.advanceTimersByTime(JOURNAL_BATCH_MS * 4);
    expect(append).toHaveBeenCalledTimes(1);
    expect(sent()).toHaveLength(1);
  });
});

describe("the ambient repository", () => {
  it("fills in a repo the caller did not supply", () => {
    setJournalRepo("/repos/voidlink");
    record({ kind: "terminal.command.finished", summary: "npm finished" });
    flushJournal();
    expect(sent()[0].repo).toBe("/repos/voidlink");
  });

  /// The agent is bound to a worktree structurally and always knows better than
  /// the ambient value — which, in the window that has the git panel focused on
  /// a different repo, would be wrong.
  it("never overrides a repo the caller did supply", () => {
    setJournalRepo("/repos/ambient");
    record({ kind: "agent.turn.finished", summary: "answered", repo: "/repos/explicit" });
    flushJournal();
    expect(sent()[0].repo).toBe("/repos/explicit");
  });

  it("leaves the repo unset when there is no ambient value", () => {
    record({ kind: "a", summary: "one" });
    flushJournal();
    expect(sent()[0].repo).toBeUndefined();
  });

  it("stamps each event with the repo current when it was recorded", () => {
    setJournalRepo("/repos/one");
    record({ kind: "a", summary: "first" });
    setJournalRepo("/repos/two");
    record({ kind: "b", summary: "second" });
    flushJournal();
    // Both are in one batch, so a naive implementation that stamped at flush
    // time would file the first event under the second repo.
    expect(sent().map((e) => e.repo)).toEqual(["/repos/one", "/repos/two"]);
  });
});

describe("recording cannot disturb the caller", () => {
  it("swallows a rejected append", async () => {
    append.mockRejectedValue(new Error("no Tauri host"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => {
      record({ kind: "a", summary: "one" });
      flushJournal();
    }).not.toThrow();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  /// The failure must not also poison the queue: the next event still goes.
  it("keeps recording after a failed batch", async () => {
    append.mockRejectedValueOnce(new Error("transient"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    record({ kind: "a", summary: "one" });
    flushJournal();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    append.mockResolvedValue([]);
    record({ kind: "b", summary: "two" });
    flushJournal();
    expect(sent().map((e) => e.kind)).toEqual(["a", "b"]);
    warn.mockRestore();
  });

  it("returns void so no caller can await it into their error path", () => {
    expect(record({ kind: "a", summary: "one" })).toBeUndefined();
  });
});

describe("the repository registry", () => {
  function workspace(partial: Partial<Workspace> & { id: string }): Workspace {
    return {
      name: partial.id,
      repoRoot: null,
      worktrees: [],
      activeWorktreeId: "",
      isRepo: true,
      ...partial,
    } as Workspace;
  }

  function worktree(id: string, path: string, isMain = false) {
    return makeWorktree({ id, path, branch: null, isMain });
  }

  it("flattens every worktree of every workspace into a row", () => {
    const rows = repoIdentities([
      workspace({
        id: "w1",
        name: "api",
        worktrees: [worktree("a", "/api", true), worktree("b", "/api-hotfix")],
      }),
      workspace({ id: "w2", name: "site", worktrees: [worktree("c", "/site", true)] }),
    ]);

    expect(rows).toEqual([
      { path: "/api", workspaceId: "w1", workspaceName: "api", worktreeId: "a", isMain: true },
      {
        path: "/api-hotfix",
        workspaceId: "w1",
        workspaceName: "api",
        worktreeId: "b",
        isMain: false,
      },
      { path: "/site", workspaceId: "w2", workspaceName: "site", worktreeId: "c", isMain: true },
    ]);
  });

  /// A workspace pointed at nothing has a synthetic worktree whose path is the
  /// empty string. Registering it would map "" to a workspace, after which Rust
  /// would join every unlocated event to it.
  it("drops a worktree with no path rather than registering the empty string", () => {
    const rows = repoIdentities([
      workspace({ id: "w1", name: "unset", worktrees: [worktree("a", "", true)] }),
    ]);
    expect(rows).toEqual([]);
  });

  it("publishes once and stays quiet while the map is unchanged", () => {
    const ws = [workspace({ id: "w1", name: "api", worktrees: [worktree("a", "/api", true)] })];
    publishRepos(ws);
    publishRepos(ws);
    publishRepos([
      workspace({ id: "w1", name: "api", worktrees: [worktree("a", "/api", true)] }),
    ]);
    expect(registerRepos).toHaveBeenCalledTimes(1);
  });

  it("republishes when a worktree is added", () => {
    publishRepos([
      workspace({ id: "w1", name: "api", worktrees: [worktree("a", "/api", true)] }),
    ]);
    publishRepos([
      workspace({
        id: "w1",
        name: "api",
        worktrees: [worktree("a", "/api", true), worktree("b", "/api-hotfix")],
      }),
    ]);
    expect(registerRepos).toHaveBeenCalledTimes(2);
    expect(registerRepos.mock.calls[1][0]).toHaveLength(2);
  });

  /// A rename is the whole point of denormalising the name onto events — it has
  /// to reach Rust or new events keep carrying the old one.
  it("republishes when a workspace is renamed", () => {
    publishRepos([
      workspace({ id: "w1", name: "api", worktrees: [worktree("a", "/api", true)] }),
    ]);
    publishRepos([
      workspace({ id: "w1", name: "backend", worktrees: [worktree("a", "/api", true)] }),
    ]);
    expect(registerRepos).toHaveBeenCalledTimes(2);
  });

  /// Same contract as `record()`: a registry that failed to publish costs
  /// grouping, and must not reach the caller's error path.
  it("swallows a failed publish and retries on the next change", async () => {
    registerRepos.mockRejectedValueOnce(new Error("no host"));
    const ws = [workspace({ id: "w1", name: "api", worktrees: [worktree("a", "/api", true)] })];
    expect(() => publishRepos(ws)).not.toThrow();
    await vi.runAllTimersAsync();
    publishRepos(ws);
    expect(registerRepos).toHaveBeenCalledTimes(2);
  });
});
