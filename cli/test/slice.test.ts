import { describe, it, expect } from "vitest";
import { buildSlice, renderSlice } from "../src/core/index.js";
import type { ParsedEntry } from "../src/core/index.js";

const NOW = new Date("2026-08-05T12:00:00-03:00");

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

describe("buildSlice", () => {
  it("collects entries by project field and by label", () => {
    const slice = buildSlice(
      [
        entry({ id: "a", type: "decision", project: "voidlink" }),
        entry({ id: "b", labels: ["voidlink", "x"] }),
        entry({ id: "c", labels: ["unrelated"] }),
      ],
      "voidlink",
      NOW,
    );
    expect(slice.total).toBe(2);
  });

  it("matches the project case-insensitively", () => {
    const slice = buildSlice([entry({ id: "a", project: "VoidLink" })], "voidlink", NOW);
    expect(slice.total).toBe(1);
  });

  it("returns the most recent decisions, newest first", () => {
    const slice = buildSlice(
      [
        entry({ id: "d1", type: "decision", project: "p", created: daysAgo(10) }),
        entry({ id: "d2", type: "decision", project: "p", created: daysAgo(1) }),
        entry({ id: "d3", type: "decision", project: "p", created: daysAgo(5) }),
        entry({ id: "d4", type: "decision", project: "p", created: daysAgo(20) }),
      ],
      "p",
      NOW,
    );
    expect(slice.recentDecisions.map((d) => d.id)).toEqual(["d2", "d3", "d1"]);
  });

  it("honours the decisions and notes limits", () => {
    const entries = [
      entry({ id: "d1", type: "decision", project: "p" }),
      entry({ id: "d2", type: "decision", project: "p" }),
      entry({ id: "n1", labels: ["p"] }),
      entry({ id: "n2", type: "discovery", labels: ["p"] }),
    ];
    const slice = buildSlice(entries, "p", NOW, { decisions: 1, notes: 1 });
    expect(slice.recentDecisions).toHaveLength(1);
    expect(slice.recentNotes).toHaveLength(1);
  });

  it("counts discoveries as notes", () => {
    const slice = buildSlice([entry({ id: "n", type: "discovery", labels: ["p"] })], "p", NOW);
    expect(slice.recentNotes.map((n) => n.id)).toEqual(["n"]);
  });

  it("surfaces this project's unfinished decisions only", () => {
    const slice = buildSlice(
      [
        entry({ id: "mine", type: "decision", project: "p", created: daysAgo(90) }),
        entry({ id: "theirs", type: "decision", project: "other", created: daysAgo(90) }),
      ],
      "p",
      NOW,
    );
    expect(slice.unfinishedDecisions.map((d) => d.ref)).toEqual(["mine"]);
  });

  it("drops a decision from the unfinished list once something shipped", () => {
    const slice = buildSlice(
      [
        entry({ id: "d", type: "decision", project: "p", created: daysAgo(90) }),
        entry({ id: "s", type: "shipped", project: "p", ticket: "P-1", created: daysAgo(10) }),
      ],
      "p",
      NOW,
    );
    expect(slice.unfinishedDecisions).toEqual([]);
  });

  it("lists open tickets belonging to this project", () => {
    const slice = buildSlice(
      [entry({ id: "a", project: "p", ticket: "P-9", created: daysAgo(60) })],
      "p",
      NOW,
    );
    expect(slice.openTickets.map((t) => t.ref)).toEqual(["P-9"]);
  });

  it("is empty for an unknown project", () => {
    const slice = buildSlice([entry({ id: "a", project: "p" })], "nothing-here", NOW);
    expect(slice.total).toBe(0);
    expect(slice.recentDecisions).toEqual([]);
  });
});

describe("renderSlice", () => {
  it("renders nothing at all for an empty slice", () => {
    expect(renderSlice(buildSlice([], "p", NOW))).toBe("");
  });

  it("includes only the sections that have content", () => {
    const out = renderSlice(
      buildSlice([entry({ id: "n", title: "A note", labels: ["p"] })], "p", NOW),
    );
    expect(out).toContain("## Brain — p (1 entries)");
    expect(out).toContain("A note");
    expect(out).not.toContain("Open tickets");
    expect(out).not.toContain("Recent decisions");
  });

  it("renders decisions, unfinished threads and tickets when present", () => {
    const out = renderSlice(
      buildSlice(
        [
          entry({ id: "d", type: "decision", title: "Chose X", project: "p", created: daysAgo(90) }),
          entry({ id: "t", project: "p", ticket: "P-9", created: daysAgo(60) }),
        ],
        "p",
        NOW,
      ),
    );
    expect(out).toContain("**Open tickets:** P-9 (60d)");
    expect(out).toContain("**Recent decisions**");
    expect(out).toContain("Chose X");
    expect(out).toContain("**Decided but nothing shipped since**");
  });
});
