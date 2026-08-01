import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@/api/journal";
import {
  checkinProse,
  describeLine,
  repoLabel,
  summarizeCheckin,
  windowStart,
  type WindowKind,
} from "./checkinModel";

const DAY = 86_400_000;

function event(partial: Partial<JournalEvent> & { kind: string }): JournalEvent {
  return {
    id: partial.id ?? `${partial.kind}-${Math.random()}`,
    at: 0,
    actor: "system",
    actorName: null,
    repo: "/repos/api",
    workspace: "api",
    subject: null,
    summary: partial.kind,
    data: {},
    ...partial,
  };
}

describe("windowStart", () => {
  /// "Today" at 9am must not mean "since 9am yesterday" — that would file
  /// yesterday evening's work under today.
  it("snaps the day windows to local midnight rather than subtracting hours", () => {
    const now = new Date(2026, 6, 31, 9, 30).getTime();
    const midnight = new Date(2026, 6, 31, 0, 0, 0, 0).getTime();
    expect(windowStart("today", now)).toBe(midnight);
    expect(windowStart("since-yesterday", now)).toBe(midnight - DAY);
  });

  it("covers seven calendar days for the week window", () => {
    const now = new Date(2026, 6, 31, 23, 0).getTime();
    const start = windowStart("week", now);
    expect(Math.round((new Date(2026, 6, 31).getTime() - start) / DAY)).toBe(6);
  });

  /// Offering a window longer than the log retains would return a partial
  /// answer that looks complete.
  it("does not offer a window longer than the log's six-week retention", () => {
    const now = Date.now();
    const kinds: WindowKind[] = ["today", "since-yesterday", "week", "cycle"];
    for (const kind of kinds) {
      expect(now - windowStart(kind, now)).toBeLessThanOrEqual(42 * DAY);
    }
  });
});

describe("summarizeCheckin", () => {
  it("counts nothing when nothing happened", () => {
    const report = summarizeCheckin([], 0, 100);
    expect(report.total).toBe(0);
    expect(report.repos).toEqual([]);
  });

  it("groups by repository and counts each kind into its own bucket", () => {
    const report = summarizeCheckin(
      [
        event({ kind: "git.commit", subject: "Extract the parser" }),
        event({ kind: "agent.turn.finished", actor: "agent", actorName: "Refactorer" }),
        event({ kind: "terminal.command.finished", actor: "user" }),
        event({ kind: "git.branch.switched" }),
      ],
      0,
      100,
    );

    expect(report.total).toBe(4);
    expect(report.repos).toHaveLength(1);
    const [digest] = report.repos;
    expect(digest.label).toBe("api");
    expect(digest.workspace).toBe("api");

    const observed = digest.lines.find((l) => l.actor === "system")!;
    expect(observed.commits).toEqual(["Extract the parser"]);
    expect(observed.refMoves).toBe(1);
    const agent = digest.lines.find((l) => l.actor === "agent")!;
    expect(agent.turns).toBe(1);
    const user = digest.lines.find((l) => l.actor === "user")!;
    expect(user.commands).toBe(1);
  });

  /// The per-agent audit trail is the point. Collapsing two agents into "the
  /// agent" answers the wrong question.
  it("keeps two agents in the same repository apart", () => {
    const report = summarizeCheckin(
      [
        event({ kind: "agent.turn.finished", actor: "agent", actorName: "Refactorer" }),
        event({ kind: "agent.turn.finished", actor: "agent", actorName: "Reviewer" }),
        event({ kind: "agent.turn.finished", actor: "agent", actorName: "Reviewer" }),
      ],
      0,
      100,
    );
    const names = report.repos[0].lines.map((l) => `${l.name}:${l.turns}`);
    expect(names).toEqual(["Reviewer:2", "Refactorer:1"]);
  });

  it("separates failed turns from completed ones", () => {
    const report = summarizeCheckin(
      [
        event({ kind: "agent.turn.finished", actor: "agent", actorName: "R" }),
        event({ kind: "agent.turn.failed", actor: "agent", actorName: "R" }),
        event({ kind: "agent.turn.cancelled", actor: "agent", actorName: "R" }),
      ],
      0,
      100,
    );
    const line = report.repos[0].lines[0];
    expect(line.turns).toBe(2);
    expect(line.turnsFailed).toBe(1);
  });

  /// The forward-compatibility contract, restated for counting: an unknown kind
  /// must land somewhere, or the totals stop adding up as kinds are added.
  it("puts an unknown kind in `other` rather than dropping it", () => {
    const report = summarizeCheckin([event({ kind: "hill.position.moved" })], 0, 100);
    expect(report.total).toBe(1);
    expect(report.repos[0].lines[0].other).toBe(1);
  });

  it("orders repositories by how much happened in them", () => {
    const report = summarizeCheckin(
      [
        event({ kind: "a", repo: "/repos/quiet" }),
        event({ kind: "b", repo: "/repos/busy" }),
        event({ kind: "c", repo: "/repos/busy" }),
      ],
      0,
      100,
    );
    expect(report.repos.map((r) => r.label)).toEqual(["busy", "quiet"]);
  });

  /// A total that disagrees with the timeline's for the same window reads as a
  /// bug in one of the two surfaces.
  it("keeps events with no repository instead of losing them from the total", () => {
    const report = summarizeCheckin([event({ kind: "a", repo: null })], 0, 100);
    expect(report.total).toBe(1);
    expect(report.repos[0].label).toBe("Elsewhere");
  });

  /// A repository registered partway through the window has events both with
  /// and without a workspace.
  it("adopts the first workspace it sees for a repository", () => {
    const report = summarizeCheckin(
      [event({ kind: "a", workspace: null }), event({ kind: "b", workspace: "api" })],
      0,
      100,
    );
    expect(report.repos[0].workspace).toBe("api");
  });
});

describe("repoLabel", () => {
  it("is the directory name", () => {
    expect(repoLabel("/Users/m/Developer/voidlink")).toBe("voidlink");
    expect(repoLabel("C:\\src\\api")).toBe("api");
  });

  it("survives a trailing separator", () => {
    expect(repoLabel("/Users/m/voidlink/")).toBe("voidlink");
  });
});

describe("describeLine", () => {
  function line(partial: Record<string, unknown>) {
    return {
      key: "k",
      actor: "agent" as const,
      name: "R",
      turns: 0,
      turnsFailed: 0,
      commits: [] as string[],
      commands: 0,
      refMoves: 0,
      other: 0,
      events: [],
      ...partial,
    };
  }

  it("singularises a count of one", () => {
    expect(describeLine(line({ commits: ["x"] }))).toBe("1 commit");
  });

  it("joins several counts with a final `and`", () => {
    expect(describeLine(line({ commits: ["x", "y"], turns: 1, commands: 3 }))).toBe(
      "2 commits, 1 turn and 3 commands",
    );
  });

  /// An actor present in the log but with nothing countable still has to render
  /// a sentence, or the row is a name followed by an em dash and blank space.
  it("says so when there is nothing countable", () => {
    expect(describeLine(line({}))).toBe("nothing recorded");
  });
});

describe("checkinProse", () => {
  it("says nothing happened rather than emitting an empty document", () => {
    expect(checkinProse(summarizeCheckin([], 0, 1), "Today")).toBe(
      "**Today** — nothing recorded.",
    );
  });

  /// A check-in that paraphrased what was committed would be inventing history.
  it("quotes commit subjects verbatim under their author", () => {
    const report = summarizeCheckin(
      [
        event({
          kind: "git.commit",
          actor: "agent",
          actorName: "Refactorer",
          subject: "Extract the parser",
        }),
      ],
      0,
      100,
    );
    const prose = checkinProse(report, "Since yesterday");
    expect(prose).toContain("**Refactorer** — 1 commit");
    expect(prose).toContain("“Extract the parser”");
    expect(prose).toContain("### api");
  });
});
