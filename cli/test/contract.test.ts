import { describe, it, expect } from "vitest";
import { RegisterInput, ENTRY_TYPES } from "../src/core/index.js";

describe("ENTRY_TYPES", () => {
  it("is the frozen ordered tuple of types", () => {
    expect(ENTRY_TYPES).toEqual([
      "decision",
      "shipped",
      "note",
      "discovery",
      "content",
      "training",
    ]);
  });
});

describe("RegisterInput happy paths (one per type)", () => {
  it("decision (requires project)", () => {
    const r = RegisterInput.safeParse({
      type: "decision",
      title: "Pick Neon",
      project: "brain",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // body has a default of ""
      expect(r.data.body).toBe("");
    }
  });

  it("shipped (requires project + ticket)", () => {
    const r = RegisterInput.safeParse({
      type: "shipped",
      title: "Ship register API",
      project: "brain",
      ticket: "BRN-12",
    });
    expect(r.success).toBe(true);
  });

  it("note (requires labels >= 1)", () => {
    const r = RegisterInput.safeParse({
      type: "note",
      title: "A note",
      labels: ["misc"],
    });
    expect(r.success).toBe(true);
  });

  it("discovery (requires labels >= 1)", () => {
    const r = RegisterInput.safeParse({
      type: "discovery",
      title: "Learned tsvector",
      labels: ["postgres"],
    });
    expect(r.success).toBe(true);
  });

  it("content (requires labels >= 1)", () => {
    const r = RegisterInput.safeParse({
      type: "content",
      title: "Thread idea",
      labels: ["bip"],
    });
    expect(r.success).toBe(true);
  });

  it("training (requires labels >= 1)", () => {
    const r = RegisterInput.safeParse({
      type: "training",
      title: "5k run",
      labels: ["running"],
    });
    expect(r.success).toBe(true);
  });
});

describe("RegisterInput required-field violations", () => {
  it("decision missing project -> fail", () => {
    const r = RegisterInput.safeParse({ type: "decision", title: "x" });
    expect(r.success).toBe(false);
  });

  it("shipped missing ticket -> fail", () => {
    const r = RegisterInput.safeParse({
      type: "shipped",
      title: "x",
      project: "brain",
    });
    expect(r.success).toBe(false);
  });

  it("shipped missing project -> fail", () => {
    const r = RegisterInput.safeParse({
      type: "shipped",
      title: "x",
      ticket: "BRN-1",
    });
    expect(r.success).toBe(false);
  });

  it("shipped malformed ticket -> fail", () => {
    const r = RegisterInput.safeParse({
      type: "shipped",
      title: "x",
      project: "brain",
      ticket: "not-a-ticket",
    });
    expect(r.success).toBe(false);
  });

  it("note missing labels -> fail", () => {
    const r = RegisterInput.safeParse({ type: "note", title: "x" });
    expect(r.success).toBe(false);
  });

  it("note empty labels array -> fail", () => {
    const r = RegisterInput.safeParse({
      type: "note",
      title: "x",
      labels: [],
    });
    expect(r.success).toBe(false);
  });

  it("discovery missing labels -> fail", () => {
    const r = RegisterInput.safeParse({ type: "discovery", title: "x" });
    expect(r.success).toBe(false);
  });

  it("content missing labels -> fail", () => {
    const r = RegisterInput.safeParse({ type: "content", title: "x" });
    expect(r.success).toBe(false);
  });

  it("training missing labels -> fail", () => {
    const r = RegisterInput.safeParse({ type: "training", title: "x" });
    expect(r.success).toBe(false);
  });

  it("empty title -> fail (Base min(1))", () => {
    const r = RegisterInput.safeParse({
      type: "note",
      title: "",
      labels: ["x"],
    });
    expect(r.success).toBe(false);
  });

  it("unknown type -> fail (discriminated union)", () => {
    const r = RegisterInput.safeParse({ type: "bogus", title: "x" });
    expect(r.success).toBe(false);
  });
});
