import { describe, it, expect } from "vitest";
import { buildMarkdown, parseEntry, FOLDER_TYPE } from "../src/core/index.js";
import type { RegisterInput } from "../src/core/index.js";

const META = { id: "2026-06-07-a-title", createdISO: "2026-06-07T10:00:00.000-03:00" };

describe("parseEntry", () => {
  it("round-trips everything buildMarkdown writes", () => {
    const input: RegisterInput = {
      type: "shipped",
      title: "Use idempotency keys on retries",
      body: "Switched retries to idempotency keys.\n\nWhy: duplicate charges.",
      project: "persiscal",
      ticket: "PROJ-123",
      labels: ["payments", "reliability"],
    };

    const parsed = parseEntry(buildMarkdown(input, META).contents);

    expect(parsed).toBeDefined();
    expect(parsed?.id).toBe(META.id);
    expect(parsed?.type).toBe("shipped");
    expect(parsed?.title).toBe(input.title);
    expect(parsed?.project).toBe("persiscal");
    expect(parsed?.ticket).toBe("PROJ-123");
    expect(parsed?.labels).toEqual(["payments", "reliability"]);
    expect(parsed?.created).toBe(META.createdISO);
    expect(parsed?.body).toBe(input.body);
  });

  it("reads the links block as bare wikilink targets", () => {
    const input: RegisterInput = {
      type: "shipped",
      title: "t",
      body: "",
      project: "brain",
      ticket: "BRN-1",
      labels: ["x"],
    };
    expect(parseEntry(buildMarkdown(input, META).contents)?.links).toEqual([
      "projects/brain",
      "labels/x",
      "tickets/BRN-1",
    ]);
  });

  it("round-trips titles that force quoting", () => {
    // yamlScalar quotes these; the parser has to unquote them symmetrically.
    for (const title of ['He said "no"', "note: a colon", "true", "2026-06-07", "  padded  "]) {
      const contents = buildMarkdown(
        { type: "note", title, body: "", labels: ["l"] },
        META,
      ).contents;
      expect(parseEntry(contents)?.title).toBe(title);
    }
  });

  it("round-trips labels containing commas", () => {
    const contents = buildMarkdown(
      { type: "note", title: "t", body: "", labels: ["a, b", "c"] },
      META,
    ).contents;
    expect(parseEntry(contents)?.labels).toEqual(["a, b", "c"]);
  });

  it("keeps an empty body empty rather than undefined", () => {
    const contents = buildMarkdown({ type: "note", title: "t", body: "", labels: ["l"] }, META)
      .contents;
    expect(parseEntry(contents)?.body).toBe("");
  });

  it("skips documents that aren't typed entries", () => {
    expect(parseEntry("just a hand-written note, no frontmatter")).toBeUndefined();
    expect(parseEntry("")).toBeUndefined();
    // an index note
    expect(
      parseEntry('---\ntype: index\nid: brain\nkind: project\n---\n\n## Backlinks\n'),
    ).toBeUndefined();
    // unknown type
    expect(parseEntry("---\ntype: banana\nid: x\n---\nbody\n")).toBeUndefined();
    // missing id
    expect(parseEntry("---\ntype: note\ntitle: t\n---\nbody\n")).toBeUndefined();
    // unterminated frontmatter
    expect(parseEntry("---\ntype: note\nid: x\n")).toBeUndefined();
  });

  it("treats a body that contains --- as body, not a fence", () => {
    const contents = buildMarkdown(
      { type: "note", title: "t", body: "before\n\n---\n\nafter", labels: ["l"] },
      META,
    ).contents;
    expect(parseEntry(contents)?.body).toBe("before\n\n---\n\nafter");
  });

  it("omits project/ticket rather than setting them empty", () => {
    const parsed = parseEntry(
      buildMarkdown({ type: "note", title: "t", body: "", labels: ["l"] }, META).contents,
    );
    expect(parsed?.project).toBeUndefined();
    expect(parsed?.ticket).toBeUndefined();
    expect(parsed?.labels).toEqual(["l"]);
  });

  it("tolerates CRLF line endings", () => {
    const contents = buildMarkdown({ type: "note", title: "t", body: "b", labels: ["l"] }, META)
      .contents.replace(/\n/g, "\r\n");
    expect(parseEntry(contents)?.title).toBe("t");
  });
});

describe("FOLDER_TYPE", () => {
  it("inverts TYPE_FOLDER", () => {
    expect(FOLDER_TYPE["decisions"]).toBe("decision");
    expect(FOLDER_TYPE["discoveries"]).toBe("discovery");
    expect(FOLDER_TYPE["shipped"]).toBe("shipped");
  });
});
