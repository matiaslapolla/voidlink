import { describe, it, expect } from "vitest";
import { buildIndexNotes, orphanedIndexNotes } from "../src/core/index.js";
import type { ParsedEntry } from "../src/core/index.js";

function entry(over: Partial<ParsedEntry> & Pick<ParsedEntry, "id">): ParsedEntry {
  return {
    type: "note",
    title: over.id,
    labels: [],
    created: "2026-06-01T10:00:00-03:00",
    links: [],
    body: "",
    ...over,
  };
}

describe("buildIndexNotes", () => {
  it("builds one note per project, label and ticket", () => {
    const notes = buildIndexNotes([
      entry({ id: "a", type: "decision", project: "brain", labels: ["x", "y"] }),
      entry({ id: "b", type: "shipped", project: "brain", ticket: "BRN-1", labels: ["x"] }),
    ]);

    expect(notes.map((n) => n.path)).toEqual([
      "labels/x.md",
      "labels/y.md",
      "projects/brain.md",
      "tickets/BRN-1.md",
    ]);
    expect(notes.find((n) => n.path === "projects/brain.md")?.backlinks).toEqual(["b", "a"]);
    expect(notes.find((n) => n.path === "labels/y.md")?.backlinks).toEqual(["a"]);
  });

  it("materialises backlinks into the markdown", () => {
    const notes = buildIndexNotes([
      entry({ id: "2026-06-07-a", type: "decision", title: "Chose X", project: "brain" }),
    ]);
    const contents = notes[0]?.contents ?? "";

    expect(contents).toContain("kind: project");
    expect(contents).toContain("count: 1");
    expect(contents).toContain("[[decisions/2026-06-07-a|Chose X]]");
    expect(contents).toContain("2026-06-01");
  });

  it("sorts backlinks newest first", () => {
    const notes = buildIndexNotes([
      entry({ id: "old", project: "p", created: "2026-01-01T00:00:00-03:00" }),
      entry({ id: "new", project: "p", created: "2026-08-01T00:00:00-03:00" }),
      entry({ id: "mid", project: "p", created: "2026-04-01T00:00:00-03:00" }),
    ]);
    expect(notes[0]?.backlinks).toEqual(["new", "mid", "old"]);
  });

  it("breaks created ties by id so output is deterministic", () => {
    const same = "2026-06-01T10:00:00-03:00";
    const a = buildIndexNotes([
      entry({ id: "b", project: "p", created: same }),
      entry({ id: "a", project: "p", created: same }),
    ]);
    const b = buildIndexNotes([
      entry({ id: "a", project: "p", created: same }),
      entry({ id: "b", project: "p", created: same }),
    ]);
    expect(a[0]?.contents).toBe(b[0]?.contents);
  });

  it("keeps an existing created stamp instead of resetting it", () => {
    const existing = new Map([["projects/p.md", "2020-01-01T00:00:00-03:00"]]);
    const notes = buildIndexNotes([entry({ id: "a", project: "p" })], existing);
    expect(notes[0]?.contents).toContain('created: "2020-01-01T00:00:00-03:00"');
  });

  it("dates a new note from its oldest entry", () => {
    const notes = buildIndexNotes([
      entry({ id: "new", project: "p", created: "2026-08-01T00:00:00-03:00" }),
      entry({ id: "old", project: "p", created: "2026-01-01T00:00:00-03:00" }),
    ]);
    expect(notes[0]?.contents).toContain('created: "2026-01-01T00:00:00-03:00"');
  });

  it("is idempotent — same entries produce identical contents", () => {
    const entries = [entry({ id: "a", project: "p", labels: ["l"], ticket: "T-1" })];
    expect(buildIndexNotes(entries)).toEqual(buildIndexNotes(entries));
  });

  it("returns nothing for entries with no refs", () => {
    expect(buildIndexNotes([entry({ id: "a" })])).toEqual([]);
  });
});

describe("orphanedIndexNotes", () => {
  it("reports index notes no entry references", () => {
    const notes = buildIndexNotes([entry({ id: "a", project: "live" })]);
    const orphans = orphanedIndexNotes(
      ["projects/live.md", "projects/dead.md", "labels/gone.md"],
      notes,
    );
    expect(orphans).toEqual(["labels/gone.md", "projects/dead.md"]);
  });

  it("ignores paths outside the index folders", () => {
    expect(orphanedIndexNotes(["notes/whatever.md", "vault/x.md"], [])).toEqual([]);
  });
});
