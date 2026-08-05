import { describe, it, expect } from "vitest";
import { review, DEFAULT_THRESHOLDS } from "../src/core/index.js";
import type { ParsedEntry } from "../src/core/index.js";

const NOW = new Date("2026-08-05T12:00:00-03:00");

/** An ISO stamp `days` before NOW. */
function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function entry(over: Partial<ParsedEntry> & Pick<ParsedEntry, "id">): ParsedEntry {
  return {
    type: "note",
    title: over.id,
    labels: [],
    created: daysAgo(1),
    links: [],
    body: "",
    ...over,
  };
}

describe("review — stale entries", () => {
  it("flags entries past the threshold and leaves fresh ones alone", () => {
    const findings = review({
      entries: [entry({ id: "old", created: daysAgo(120) }), entry({ id: "fresh", created: daysAgo(3) })],
      now: NOW,
    });
    const stale = findings.filter((f) => f.kind === "stale-entry");
    expect(stale.map((f) => f.ref)).toEqual(["old"]);
    expect(stale[0]?.ageDays).toBe(120);
  });

  it("prefers lastTouched over created, so a revised entry isn't stale", () => {
    const findings = review({
      entries: [entry({ id: "revised", created: daysAgo(300) })],
      now: NOW,
      lastTouched: new Map([["revised", daysAgo(2)]]),
    });
    expect(findings.filter((f) => f.kind === "stale-entry")).toEqual([]);
  });

  it("escalates severity the further past the threshold it is", () => {
    const at = (days: number) =>
      review({ entries: [entry({ id: "e", created: daysAgo(days) })], now: NOW })[0]?.severity;
    expect(at(DEFAULT_THRESHOLDS.staleEntryDays)).toBe("low");
    expect(at(DEFAULT_THRESHOLDS.staleEntryDays * 2)).toBe("medium");
    expect(at(DEFAULT_THRESHOLDS.staleEntryDays * 3)).toBe("high");
  });

  it("honours a custom threshold", () => {
    const findings = review({
      entries: [entry({ id: "e", created: daysAgo(10) })],
      now: NOW,
      thresholds: { staleEntryDays: 5 },
    });
    expect(findings.some((f) => f.kind === "stale-entry")).toBe(true);
  });
});

describe("review — open tickets", () => {
  it("flags a ticket with no shipped entry", () => {
    const findings = review({
      entries: [entry({ id: "a", ticket: "PORT-7", created: daysAgo(60) })],
      now: NOW,
    });
    const t = findings.filter((f) => f.kind === "open-ticket");
    expect(t.map((f) => f.ref)).toEqual(["PORT-7"]);
    expect(t[0]?.detail).toContain("no status");
  });

  it("clears a ticket once something shipped against it", () => {
    const findings = review({
      entries: [
        entry({ id: "a", ticket: "PORT-7", created: daysAgo(60) }),
        entry({ id: "b", type: "shipped", ticket: "PORT-7", project: "p", created: daysAgo(50) }),
      ],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "open-ticket")).toEqual([]);
  });

  it("respects a closed status in the ticket note", () => {
    const findings = review({
      entries: [entry({ id: "a", ticket: "PORT-7", created: daysAgo(60) })],
      now: NOW,
      ticketStatus: new Map([["PORT-7", "Done"]]),
    });
    expect(findings.filter((f) => f.kind === "open-ticket")).toEqual([]);
  });

  it("treats a non-closed status as still open", () => {
    const findings = review({
      entries: [entry({ id: "a", ticket: "PORT-7", created: daysAgo(60) })],
      now: NOW,
      ticketStatus: new Map([["PORT-7", "in progress"]]),
    });
    expect(findings.filter((f) => f.kind === "open-ticket")).toHaveLength(1);
  });

  it("ages a ticket from its earliest mention", () => {
    const findings = review({
      entries: [
        entry({ id: "late", ticket: "T-1", created: daysAgo(31) }),
        entry({ id: "early", ticket: "T-1", created: daysAgo(200) }),
      ],
      now: NOW,
    });
    expect(findings.find((f) => f.kind === "open-ticket")?.ageDays).toBe(200);
  });
});

describe("review — unfinished decisions", () => {
  it("flags a decision with nothing shipped after it", () => {
    const findings = review({
      entries: [entry({ id: "d", type: "decision", project: "brain", created: daysAgo(90) })],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "unfinished-decision").map((f) => f.ref)).toEqual(["d"]);
  });

  it("clears once something shipped in that project afterwards", () => {
    const findings = review({
      entries: [
        entry({ id: "d", type: "decision", project: "brain", created: daysAgo(90) }),
        entry({ id: "s", type: "shipped", project: "brain", ticket: "B-1", created: daysAgo(80) }),
      ],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "unfinished-decision")).toEqual([]);
  });

  it("does not count work shipped BEFORE the decision", () => {
    const findings = review({
      entries: [
        entry({ id: "d", type: "decision", project: "brain", created: daysAgo(90) }),
        entry({ id: "s", type: "shipped", project: "brain", ticket: "B-1", created: daysAgo(120) }),
      ],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "unfinished-decision")).toHaveLength(1);
  });

  it("does not count work shipped in a different project", () => {
    const findings = review({
      entries: [
        entry({ id: "d", type: "decision", project: "brain", created: daysAgo(90) }),
        entry({ id: "s", type: "shipped", project: "other", ticket: "O-1", created: daysAgo(10) }),
      ],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "unfinished-decision")).toHaveLength(1);
  });

  it("leaves a recent decision alone", () => {
    const findings = review({
      entries: [entry({ id: "d", type: "decision", project: "brain", created: daysAgo(5) })],
      now: NOW,
    });
    expect(findings.filter((f) => f.kind === "unfinished-decision")).toEqual([]);
  });
});

describe("review — output", () => {
  it("sorts high severity first, then oldest", () => {
    const findings = review({
      entries: [
        entry({ id: "slightly-stale", created: daysAgo(91) }),
        entry({ id: "ancient", created: daysAgo(400) }),
      ],
      now: NOW,
    });
    expect(findings[0]?.ref).toBe("ancient");
    expect(findings[0]?.severity).toBe("high");
  });

  it("returns nothing for a healthy vault", () => {
    expect(review({ entries: [entry({ id: "a" })], now: NOW })).toEqual([]);
  });

  it("is a pure function of its inputs", () => {
    const entries = [entry({ id: "a", created: daysAgo(120) })];
    expect(review({ entries, now: NOW })).toEqual(review({ entries, now: NOW }));
  });
});
