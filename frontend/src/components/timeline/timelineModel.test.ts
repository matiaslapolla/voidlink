/// Grouping, labelling, filtering and merging — everything the timeline can get
/// wrong without a DOM being involved.
import { describe, expect, it } from "vitest";
import type { JournalEvent } from "@/api/journal";
import {
  dayLabel,
  groupByDay,
  isInferred,
  matchesFilters,
  mergeEvents,
  type TimelineFilters,
} from "./timelineModel";

const DAY = 86_400_000;

function at(iso: string): number {
  return new Date(iso).getTime();
}

function event(partial: Partial<JournalEvent> & { at: number }): JournalEvent {
  return {
    id: `e${partial.at}`,
    kind: "git.commit",
    actor: "system",
    actorName: null,
    repo: "/repo",
    workspace: null,
    subject: null,
    summary: "something happened",
    data: {},
    ...partial,
  };
}

const NO_FILTERS: TimelineFilters = { actor: "all", query: "" };

describe("grouping", () => {
  /// Rust returns ascending because that is the order of an append-only file; a
  /// timeline reads the other way, in both dimensions.
  it("puts the newest day first and the newest event first inside it", () => {
    const now = at("2026-07-30T18:00:00");
    const sections = groupByDay(
      [
        event({ at: at("2026-07-28T09:00:00"), id: "old" }),
        event({ at: at("2026-07-30T09:00:00"), id: "morning" }),
        event({ at: at("2026-07-30T17:00:00"), id: "evening" }),
      ],
      now,
    );
    expect(sections.map((s) => s.label)).toEqual(["Today", "Tuesday"]);
    expect(sections[0].events.map((e) => e.id)).toEqual(["evening", "morning"]);
  });

  /// A commit at 9pm belongs to today. Grouping on UTC would file it under
  /// tomorrow for anyone east of Greenwich.
  it("splits days on the local boundary, not the UTC one", () => {
    const now = at("2026-07-30T23:59:00");
    const sections = groupByDay(
      [
        event({ at: at("2026-07-30T21:00:00"), id: "late" }),
        event({ at: at("2026-07-30T00:30:00"), id: "early" }),
      ],
      now,
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Today");
  });

  it("gives each day a key stable enough for keyed rendering", () => {
    const now = at("2026-07-30T12:00:00");
    const once = groupByDay([event({ at: at("2026-07-29T10:00:00") })], now);
    const again = groupByDay(
      [event({ at: at("2026-07-29T10:00:00") }), event({ at: at("2026-07-29T11:00:00") })],
      now,
    );
    expect(once[0].key).toBe(again[0].key);
  });

  it("returns nothing for an empty log rather than an empty day", () => {
    expect(groupByDay([], Date.now())).toEqual([]);
  });
});

describe("day labels", () => {
  const now = at("2026-07-30T12:00:00");

  it("names the two days a person thinks of by name", () => {
    expect(dayLabel(now, now)).toBe("Today");
    expect(dayLabel(now - DAY, now)).toBe("Yesterday");
  });

  it("uses the weekday inside the last week and a date beyond it", () => {
    expect(dayLabel(now - 3 * DAY, now)).toBe("Monday");
    expect(dayLabel(now - 30 * DAY, now)).not.toMatch(/day$/);
  });
});

describe("filters", () => {
  const commit = event({ at: 1, actor: "agent", summary: "Refactorer committed “Extract parser”" });
  const mine = event({ at: 2, actor: "user", summary: "npm finished", subject: "npm" });

  it("passes everything when nothing is selected", () => {
    expect(matchesFilters(commit, NO_FILTERS)).toBe(true);
    expect(matchesFilters(mine, NO_FILTERS)).toBe(true);
  });

  it("narrows to one actor", () => {
    const agentOnly: TimelineFilters = { actor: "agent", query: "" };
    expect(matchesFilters(commit, agentOnly)).toBe(true);
    expect(matchesFilters(mine, agentOnly)).toBe(false);
  });

  it("matches the query against the summary and the subject, case-insensitively", () => {
    expect(matchesFilters(commit, { actor: "all", query: "extract" })).toBe(true);
    expect(matchesFilters(mine, { actor: "all", query: "NPM" })).toBe(true);
    expect(matchesFilters(mine, { actor: "all", query: "parser" })).toBe(false);
  });

  it("intersects the two rather than unioning them", () => {
    expect(matchesFilters(mine, { actor: "agent", query: "npm" })).toBe(false);
  });

  it("ignores a query that is only whitespace", () => {
    expect(matchesFilters(mine, { actor: "all", query: "   " })).toBe(true);
  });

  it("drops filtered events out of their section, and empty sections entirely", () => {
    const now = at("2026-07-30T12:00:00");
    const sections = groupByDay(
      [
        event({ at: at("2026-07-29T10:00:00"), actor: "user" }),
        event({ at: at("2026-07-30T10:00:00"), actor: "agent" }),
      ],
      now,
      { actor: "agent", query: "" },
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Today");
  });
});

describe("inferred attribution", () => {
  /// The UI must be able to tell a guess from an observation, because Rust
  /// deliberately records the difference.
  it("reads the marker Rust writes", () => {
    expect(isInferred(event({ at: 1, data: { attribution: "inferred" } }))).toBe(true);
    expect(isInferred(event({ at: 1, data: { oid: "abc" } }))).toBe(false);
  });

  it("survives a payload that is not an object", () => {
    expect(isInferred(event({ at: 1, data: null }))).toBe(false);
    expect(isInferred(event({ at: 1, data: "text" }))).toBe(false);
  });
});

describe("merging live events", () => {
  /// The live broadcast and the initial query both carry the event that landed
  /// while the query was in flight. Showing it twice reads as two commits.
  it("drops an event already present", () => {
    const existing = [event({ at: 1, id: "a" }), event({ at: 2, id: "b" })];
    const merged = mergeEvents(existing, [event({ at: 2, id: "b" })]);
    expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("keeps the list ascending when a broadcast arrives out of order", () => {
    const existing = [event({ at: 10, id: "a" })];
    const merged = mergeEvents(existing, [event({ at: 5, id: "early" })]);
    expect(merged.map((e) => e.id)).toEqual(["early", "a"]);
  });

  it("returns the same list untouched when there is nothing new", () => {
    const existing = [event({ at: 1, id: "a" })];
    expect(mergeEvents(existing, [])).toBe(existing);
    expect(mergeEvents(existing, [event({ at: 1, id: "a" })])).toBe(existing);
  });
});
