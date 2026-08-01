import { describe, expect, it } from "vitest";
import type { ActiveAgent, JournalEvent, RepoIdentity } from "@/api/journal";
import { ago, buildLineup, compareRows, rowStatus, type LineupRow } from "./lineupModel";

function identity(path: string, workspace: string, isMain = false): RepoIdentity {
  return {
    path,
    workspaceId: `ws-${workspace}`,
    workspaceName: workspace,
    worktreeId: `wt-${path}`,
    isMain,
  };
}

function event(partial: Partial<JournalEvent> & { at: number }): JournalEvent {
  return {
    id: `e${partial.at}`,
    kind: "git.commit",
    actor: "system",
    actorName: null,
    repo: "/api",
    workspace: "api",
    subject: null,
    summary: "something",
    data: {},
    ...partial,
  };
}

function agent(repo: string, name: string, since = 0): ActiveAgent {
  return { repo, name, since };
}

function row(partial: Partial<LineupRow> = {}): LineupRow {
  return {
    repo: "/x",
    label: "x",
    worktreeId: null,
    isMain: false,
    active: [],
    last: null,
    commits: 0,
    turns: 0,
    events: 0,
    ...partial,
  };
}

describe("buildLineup", () => {
  /// The registry is what says a checkout exists. A repository with no history
  /// still gets a row — "nothing has happened here" is an answer, and a missing
  /// row reads as a missing worktree.
  it("gives every registered checkout a row even with an empty log", () => {
    const groups = buildLineup([identity("/api", "api", true)], [], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map((r) => r.label)).toEqual(["api"]);
    expect(groups[0].rows[0].last).toBeNull();
  });

  it("groups checkouts under their workspace", () => {
    const groups = buildLineup(
      [
        identity("/api", "api", true),
        identity("/api-hotfix", "api"),
        identity("/site", "site", true),
      ],
      [],
      [],
    );
    expect(groups.map((g) => g.workspaceName)).toEqual(["api", "site"]);
    expect(groups[0].rows).toHaveLength(2);
  });

  it("counts commits and turns per checkout and keeps the newest event", () => {
    const groups = buildLineup(
      [identity("/api", "api", true)],
      [
        event({ at: 1, kind: "git.commit" }),
        event({ at: 2, kind: "git.commit" }),
        event({ at: 3, kind: "agent.turn.finished", summary: "Refactorer answered" }),
      ],
      [],
    );
    const [r] = groups[0].rows;
    expect(r.commits).toBe(2);
    expect(r.turns).toBe(1);
    expect(r.events).toBe(3);
    expect(r.last?.summary).toBe("Refactorer answered");
  });

  /// A workspace the user removed leaves events behind. They belong in the
  /// timeline; synthesising a lineup row for a directory nobody has open would
  /// invite a click that goes nowhere.
  it("drops events whose repository is not registered", () => {
    const groups = buildLineup(
      [identity("/api", "api", true)],
      [event({ at: 1, repo: "/deleted" })],
      [],
    );
    expect(groups[0].rows[0].events).toBe(0);
  });

  it("attaches running agents to their checkout", () => {
    const groups = buildLineup(
      [identity("/api", "api", true), identity("/site", "site", true)],
      [],
      [agent("/api", "Refactorer", 500)],
    );
    const api = groups.find((g) => g.workspaceName === "api")!;
    expect(api.rows[0].active.map((a) => a.name)).toEqual(["Refactorer"]);
    expect(api.busy).toBe(true);
    expect(groups.find((g) => g.workspaceName === "site")!.busy).toBe(false);
  });

  /// A busy workspace scrolled below the fold is the one failure this surface
  /// exists to prevent.
  it("puts a workspace with something running first, whatever its name", () => {
    const groups = buildLineup(
      [identity("/aaa", "aaa", true), identity("/zzz", "zzz", true)],
      [],
      [agent("/zzz", "Refactorer")],
    );
    expect(groups.map((g) => g.workspaceName)).toEqual(["zzz", "aaa"]);
  });

  it("orders agents in a checkout longest-running first", () => {
    const groups = buildLineup(
      [identity("/api", "api", true)],
      [],
      [agent("/api", "Newer", 900), agent("/api", "Older", 100)],
    );
    expect(groups[0].rows[0].active.map((a) => a.name)).toEqual(["Older", "Newer"]);
  });
});

describe("compareRows", () => {
  it("puts a busy checkout above an idle one", () => {
    const busy = row({ label: "z", active: [agent("/z", "R")] });
    const idle = row({ label: "a", isMain: true, last: event({ at: 9_999 }) });
    expect([idle, busy].sort(compareRows).map((r) => r.label)).toEqual(["z", "a"]);
  });

  it("puts the main checkout above its worktrees when neither is busy", () => {
    const main = row({ label: "api", isMain: true });
    const wt = row({ label: "api-hotfix" });
    expect([wt, main].sort(compareRows).map((r) => r.label)).toEqual(["api", "api-hotfix"]);
  });

  it("falls back to most recently active", () => {
    const old = row({ label: "old", last: event({ at: 100 }) });
    const fresh = row({ label: "fresh", last: event({ at: 900 }) });
    expect([old, fresh].sort(compareRows).map((r) => r.label)).toEqual(["fresh", "old"]);
  });

  /// Two checkouts that have never been touched must not reshuffle between
  /// renders — with no timestamps, the tiebreak has to be the name.
  it("is stable for two rows with no history", () => {
    const a = row({ label: "a" });
    const b = row({ label: "b" });
    expect([b, a].sort(compareRows).map((r) => r.label)).toEqual(["a", "b"]);
  });
});

describe("ago", () => {
  it("is coarse on purpose", () => {
    const now = 1_000_000_000;
    expect(ago(now - 5_000, now)).toBe("5s");
    expect(ago(now - 4 * 60_000, now)).toBe("4m");
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h");
    expect(ago(now - 5 * 86_400_000, now)).toBe("5d");
  });

  /// Clock skew between Rust's stamp and the browser's `Date.now()` must not
  /// produce "-3s ago".
  it("never reports a negative age", () => {
    expect(ago(1_000, 0)).toBe("0s");
  });
});

describe("rowStatus", () => {
  const now = 1_000_000;

  /// Live work outranks history: a checkout with an agent in it says so even if
  /// the log's newest entry is ten seconds old.
  it("reports the running agent ahead of the last event", () => {
    const r = row({
      active: [agent("/api", "Refactorer", now - 120_000)],
      last: event({ at: now - 10_000, summary: "Committed something" }),
    });
    expect(rowStatus(r, now)).toBe("Refactorer working — 2m");
  });

  it("counts rather than lists when several agents share a checkout", () => {
    const r = row({ active: [agent("/api", "A"), agent("/api", "B")] });
    expect(rowStatus(r, now)).toBe("2 agents working");
  });

  it("falls back to the last event's own summary", () => {
    const r = row({ last: event({ at: now - 3_600_000, summary: "Committed “x”" }) });
    expect(rowStatus(r, now)).toBe("Committed “x” — 1h ago");
  });

  it("says nothing is recorded rather than rendering an empty status", () => {
    expect(rowStatus(row(), now)).toBe("Nothing recorded");
  });
});
