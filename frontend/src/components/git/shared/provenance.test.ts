/// The inference behind "which agent wrote this".
///
/// What is under test is not "does it find an agent" — that is the easy half.
/// It is the four ways a time-window heuristic lies if nobody stops it:
///
///   1. Attributing a checkout's file to a turn that ran in a *different*
///      checkout, because fan-out legs put their worktree in `data.worktree`
///      and leave `repo` null.
///   2. Attributing across a gap, because a window with no known start was
///      given an invented one.
///   3. Disagreeing with Rust about which of two overlapping turns wins, which
///      would make this surface and the timeline name different agents for one
///      file.
///   4. Promoting an unattributed commit — one Rust deliberately left as
///      `system` — into an agent's work.
///
/// The loaders are covered too, for the one thing they can get wrong silently:
/// `fs_stat_files` reports **seconds** and every window is in milliseconds, so
/// a missing `* 1000` puts every file in 1970 and produces a permanent,
/// plausible-looking "nothing known".

import { afterEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const activeAgents = vi.fn();
const statFiles = vi.fn();

vi.mock("@/api/journal", () => ({
  JOURNAL_APPENDED_EVENT: "voidlink://journal-appended",
  journalApi: {
    query: (q: unknown) => query(q),
    activeAgents: () => activeAgents(),
  },
}));

vi.mock("@/api/fs", () => ({
  fsApi: { statFiles: (paths: string[]) => statFiles(paths) },
}));

import type { ActiveAgent, JournalEvent } from "@/api/journal";
import {
  agentWindows,
  commitProvenance,
  explainProvenance,
  fileProvenance,
  isCommitOid,
  loadCommitProvenance,
  loadFileProvenance,
  PROVENANCE_GRACE_MS,
  windowCovering,
} from "./provenance";

const LEG_WORKTREE = "/repos/app-leg-1";

function event(over: Partial<JournalEvent> & { kind: string; at: number }): JournalEvent {
  return {
    id: `${over.kind}-${over.at}`,
    actor: "agent",
    actorName: null,
    repo: null,
    workspace: null,
    subject: null,
    summary: over.kind,
    data: {},
    ...over,
  };
}

/// A run that started at `from` and whose one leg ended at `to`.
function run(from: number, to: number, agent: string, worktree = LEG_WORKTREE): JournalEvent[] {
  return [
    event({ kind: "run.started", at: from, actor: "user", data: { runId: "r1" } }),
    event({
      kind: "run.leg.finished",
      at: to,
      actorName: agent,
      data: { runId: "r1", legId: "l1", branch: "b", worktree },
    }),
  ];
}

afterEach(() => {
  query.mockReset();
  activeAgents.mockReset();
  statFiles.mockReset();
});

describe("agentWindows", () => {
  it("bounds a leg by its run's start and its own end, plus Rust's grace", () => {
    const [window] = agentWindows(run(1_000, 5_000, "Refactorer"), []);
    expect(window).toMatchObject({
      agent: "Refactorer",
      repo: LEG_WORKTREE,
      from: 1_000,
      to: 5_000 + PROVENANCE_GRACE_MS,
      source: "run-leg",
    });
  });

  it("keys a leg on its worktree, not on the repository the run started from", () => {
    // The leg event's `repo` is null and its checkout is only in
    // `data.worktree`. A reader that grouped by `repo` would attribute the
    // leg's writes to nothing at all — or, worse, to the parent checkout.
    const events = run(1_000, 5_000, "Refactorer");
    expect(agentWindows(events, [])[0].repo).toBe(LEG_WORKTREE);
    expect(fileProvenance(agentWindows(events, []), "/repos/app", 3_000)).toBeNull();
  });

  it("drops a leg whose run start is not in the queried window", () => {
    // An interval with an unknown start is not an interval. Substituting one
    // would attribute everything written before the agent ever began.
    const [, legOnly] = run(1_000, 5_000, "Refactorer");
    expect(agentWindows([legOnly], [])).toEqual([]);
  });

  it("leaves a live turn's window open rather than closing it at load time", () => {
    const active: ActiveAgent[] = [{ repo: "/repos/app", name: "Reviewer", since: 100 }];
    const [window] = agentWindows([], active);
    expect(window).toMatchObject({ agent: "Reviewer", to: null, source: "live" });
    // Still open a long time later — a closed window would stop attributing a
    // turn that is visibly still running.
    expect(windowCovering([window], "/repos/app", 9_000_000)).toBe(window);
  });

  it("ignores a leg event whose payload has drifted", () => {
    // `data` is the machine half and nothing may depend on it being
    // well-formed (see `api/journal.ts`). A missing worktree costs one window,
    // never a thrown render.
    const events = [
      event({ kind: "run.started", at: 1, actor: "user", data: { runId: "r1" } }),
      event({ kind: "run.leg.finished", at: 2, actorName: "X", data: { runId: "r1" } }),
      event({ kind: "run.leg.failed", at: 3, actorName: "Y", data: null }),
    ];
    expect(agentWindows(events, [])).toEqual([]);
  });
});

describe("windowCovering", () => {
  const early: ReturnType<typeof agentWindows>[number] = {
    agent: "Early",
    repo: "/r",
    from: 0,
    to: 10_000,
    source: "run-leg",
  };
  const late = { ...early, agent: "Late", from: 5_000 };

  it("gives the most recently started turn to an overlap, like Rust does", () => {
    // `journal::Inner::agent_in` takes the last-started turn. Two surfaces
    // disagreeing about one file would be worse than either answer.
    expect(windowCovering([early, late], "/r", 7_000)?.agent).toBe("Late");
    expect(windowCovering([late, early], "/r", 7_000)?.agent).toBe("Late");
  });

  it("says nothing outside every window", () => {
    expect(windowCovering([early], "/r", 20_000)).toBeNull();
    expect(windowCovering([early], "/r", -1)).toBeNull();
  });
});

describe("commitProvenance", () => {
  const committed = (over: Partial<JournalEvent>) =>
    event({
      kind: "git.commit",
      at: 10,
      actorName: "Refactorer",
      data: { oid: "abc", attribution: "inferred" },
      ...over,
    });

  it("reads the credit the log already recorded", () => {
    expect(commitProvenance([committed({})], "abc")).toMatchObject({
      agent: "Refactorer",
      scope: "commit",
      commitOid: "abc",
    });
  });

  it("refuses to promote a commit the watcher left unattributed", () => {
    // Rust marks these `system` precisely because it does not know who moved
    // the ref. Inventing an agent here would put a false line in every review.
    const orphan = committed({ actor: "system", actorName: null, data: { oid: "abc" } });
    expect(commitProvenance([orphan], "abc")).toBeNull();
  });

  it("ignores an agent-credited commit that is not marked inferred", () => {
    const unmarked = committed({ data: { oid: "abc" } });
    expect(commitProvenance([unmarked], "abc")).toBeNull();
  });

  it("answers about the commit asked for and no other", () => {
    expect(commitProvenance([committed({})], "def")).toBeNull();
  });
});

describe("explainProvenance", () => {
  it("names the inference and its limits in both claims", () => {
    const file = fileProvenance(agentWindows(run(0, 10, "Refactorer"), []), LEG_WORKTREE, 5)!;
    const commit = commitProvenance(
      [
        event({
          kind: "git.commit",
          at: 1,
          actorName: "Refactorer",
          data: { oid: "abc", attribution: "inferred" },
        }),
      ],
      "abc",
    )!;
    for (const text of [explainProvenance(file), explainProvenance(commit)]) {
      expect(text).toContain("Inferred");
      expect(text).toContain("not from authorship");
    }
    // The file claim has to disown the lines underneath it explicitly — that is
    // the misreading the whole surface exists to prevent.
    expect(explainProvenance(file)).toContain("which lines");
  });
});

describe("loadFileProvenance", () => {
  it("converts the stat's seconds into the log's milliseconds", async () => {
    query.mockResolvedValue(run(1_000_000, 3_000_000, "Refactorer"));
    activeAgents.mockResolvedValue([]);
    // 2000s is inside [1000s, 3000s] once scaled, and 1970 once not.
    statFiles.mockResolvedValue([{ path: "/f", exists: true, modified: 2_000, size: 1 }]);
    expect(await loadFileProvenance(LEG_WORKTREE, "/f")).toMatchObject({
      agent: "Refactorer",
      scope: "file",
      basis: "worktree-mtime",
    });
  });

  it("says nothing about a file the filesystem gave no mtime for", async () => {
    query.mockResolvedValue(run(0, 9_999_999_999_999, "Refactorer"));
    activeAgents.mockResolvedValue([]);
    statFiles.mockResolvedValue([{ path: "/f", exists: true, modified: null, size: 1 }]);
    // Falling back to "now" here would credit whoever happens to be running at
    // the moment the diff was opened — a fresh guess on every open.
    expect(await loadFileProvenance(LEG_WORKTREE, "/f")).toBeNull();
  });

  it("asks the log for run and commit history without a repo filter", async () => {
    query.mockResolvedValue([]);
    activeAgents.mockResolvedValue([]);
    statFiles.mockResolvedValue([{ path: "/f", exists: false, modified: null, size: 0 }]);
    await loadFileProvenance(LEG_WORKTREE, "/f");
    // A `repo`-scoped query returns every git event and *no* leg, because
    // `fanout::leg_event` leaves `repo` null. Filtering happens on
    // `data.worktree` instead.
    expect(query.mock.calls[0][0]).toMatchObject({ kinds: ["run.", "git.commit"] });
    expect(query.mock.calls[0][0]).not.toHaveProperty("repo");
  });
});

describe("loadCommitProvenance", () => {
  it("reads the credit for one oid out of the same query", async () => {
    query.mockResolvedValue([
      event({
        kind: "git.commit",
        at: 5,
        actorName: "Reviewer",
        data: { oid: "abc", attribution: "inferred" },
      }),
    ]);
    expect(await loadCommitProvenance("abc")).toMatchObject({ agent: "Reviewer", scope: "commit" });
  });
});

describe("isCommitOid", () => {
  it("accepts a full sha and rejects everything a branch could be named", () => {
    expect(isCommitOid("a".repeat(40))).toBe(true);
    expect(isCommitOid("main")).toBe(false);
    expect(isCommitOid("a".repeat(7))).toBe(false);
    // A range's head is not one commit, and asking the log about it would
    // answer about nothing.
    expect(isCommitOid("origin/main")).toBe(false);
  });
});
