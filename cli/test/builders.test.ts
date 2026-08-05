import { describe, it, expect } from "vitest";
import {
  slug,
  makeId,
  buildLinks,
  buildFrontmatter,
  buildMarkdown,
  TYPE_FOLDER,
  RegisterInput,
} from "../src/core/index.js";

/** Helper: parse + assert so tests operate on validated RegisterInput. */
function parse(input: unknown) {
  const r = RegisterInput.parse(input);
  return r;
}

describe("TYPE_FOLDER", () => {
  it("maps every type to its content-repo folder", () => {
    expect(TYPE_FOLDER).toEqual({
      decision: "decisions",
      shipped: "shipped",
      note: "notes",
      discovery: "discoveries",
      content: "content",
      training: "training",
    });
  });
});

describe("slug", () => {
  it("basic phrase", () => {
    expect(slug("Use idempotency keys on retries")).toBe(
      "use-idempotency-keys-on-retries",
    );
  });
  it("strips diacritics", () => {
    expect(slug("Café déjà vu")).toBe("cafe-deja-vu");
  });
  it("collapses runs of non-alnum and trims", () => {
    expect(slug("  --Hello,   World!!  ")).toBe("hello-world");
  });
  it("keeps digits", () => {
    expect(slug("PROJ-123 shipped v2")).toBe("proj-123-shipped-v2");
  });
  it("non-latin -> empty", () => {
    expect(slug("日本語")).toBe("");
  });
});

describe("makeId", () => {
  it("date prefix from createdISO.slice(0,10) + slug(title)", () => {
    expect(
      makeId({
        type: "decision",
        title: "Use idempotency keys on retries",
        createdISO: "2026-06-07T15:00:00-03:00",
      }),
    ).toBe("2026-06-07-use-idempotency-keys-on-retries");
  });
  it("is deterministic", () => {
    const args = {
      type: "note" as const,
      title: "Same Title",
      createdISO: "2026-01-02T09:00:00-03:00",
    };
    expect(makeId(args)).toBe(makeId(args));
    expect(makeId(args)).toBe("2026-01-02-same-title");
  });
});

describe("buildLinks", () => {
  it("decision -> project only", () => {
    const input = parse({ type: "decision", title: "t", project: "brain" });
    expect(buildLinks(input)).toEqual([{ kind: "project", ref: "brain" }]);
  });

  it("note -> labels in input order", () => {
    const input = parse({
      type: "note",
      title: "t",
      labels: ["payments", "reliability"],
    });
    expect(buildLinks(input)).toEqual([
      { kind: "label", ref: "payments" },
      { kind: "label", ref: "reliability" },
    ]);
  });

  it("shipped -> project, labels, ticket in that order", () => {
    const input = parse({
      type: "shipped",
      title: "t",
      project: "brain",
      ticket: "BRN-9",
      labels: ["api", "db"],
    });
    expect(buildLinks(input)).toEqual([
      { kind: "project", ref: "brain" },
      { kind: "label", ref: "api" },
      { kind: "label", ref: "db" },
      { kind: "ticket", ref: "BRN-9" },
    ]);
  });
});

describe("buildFrontmatter + buildMarkdown snapshots", () => {
  it("decision markdown snapshot", () => {
    const input = parse({
      type: "decision",
      title: "Use idempotency keys on payment retries",
      project: "persiscal",
      labels: ["payments", "reliability"],
      body: "Idempotency keys prevent double charges.",
    });
    const meta = {
      id: "2026-06-07-use-idempotency-keys-on-payment-retries",
      createdISO: "2026-06-07T15:00:00-03:00",
    };
    const md = buildMarkdown(input, meta);
    expect(md.path).toBe(
      "decisions/2026-06-07-use-idempotency-keys-on-payment-retries.md",
    );
    expect(md.contents).toMatchInlineSnapshot(`
      "---
      id: 2026-06-07-use-idempotency-keys-on-payment-retries
      type: decision
      title: Use idempotency keys on payment retries
      project: persiscal
      labels: [payments, reliability]
      created: "2026-06-07T15:00:00-03:00"
      links:
        - "[[projects/persiscal]]"
        - "[[labels/payments]]"
        - "[[labels/reliability]]"
      ---
      Idempotency keys prevent double charges.
      "
    `);
    expect(md.links).toEqual([
      { kind: "project", ref: "persiscal" },
      { kind: "label", ref: "payments" },
      { kind: "label", ref: "reliability" },
    ]);
  });

  it("shipped markdown snapshot WITH server extra (ticket enrichment + ticket link)", () => {
    const input = parse({
      type: "shipped",
      title: "Ship the register endpoint",
      project: "brain",
      ticket: "BRN-12",
      body: "POST /api/register is live.",
    });
    const meta = {
      id: "2026-06-07-ship-the-register-endpoint",
      createdISO: "2026-06-07T16:30:00-03:00",
    };
    const extra = {
      frontmatter: {
        ticket_title: "Register endpoint",
        ticket_team: "Brain",
        ticket_state: "Done",
      },
      links: [{ kind: "ticket" as const, ref: "BRN-12" }],
    };
    const md = buildMarkdown(input, meta, extra);
    expect(md.path).toBe(
      "shipped/2026-06-07-ship-the-register-endpoint.md",
    );
    // ticket appears once even though it is in both buildLinks and extra.links
    expect(md.links).toEqual([
      { kind: "project", ref: "brain" },
      { kind: "ticket", ref: "BRN-12" },
    ]);
    expect(md.contents).toMatchInlineSnapshot(`
      "---
      id: 2026-06-07-ship-the-register-endpoint
      type: shipped
      title: Ship the register endpoint
      project: brain
      ticket: BRN-12
      ticket_title: Register endpoint
      ticket_team: Brain
      ticket_state: Done
      created: "2026-06-07T16:30:00-03:00"
      links:
        - "[[projects/brain]]"
        - "[[tickets/BRN-12]]"
      ---
      POST /api/register is live.
      "
    `);
  });

  it("2-arg buildFrontmatter (no extra) is unaffected", () => {
    const input = parse({
      type: "note",
      title: "Plain note",
      labels: ["misc"],
    });
    const fm = buildFrontmatter(input, {
      id: "2026-06-07-plain-note",
      createdISO: "2026-06-07T10:00:00-03:00",
    });
    expect(fm).toContain("type: note");
    expect(fm).toContain('  - "[[labels/misc]]"');
    expect(fm).not.toContain("ticket_");
  });
});
