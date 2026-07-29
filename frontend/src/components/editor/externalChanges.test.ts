import { describe, expect, it } from "vitest";
import type { FileStamp } from "@/api/fs";
import {
  changedPaths,
  planForChanges,
  stampChanged,
  toStampMap,
} from "./externalChanges";

function stamp(path: string, modified: number | null, size: number): FileStamp {
  return { path, exists: true, modified, size };
}

function gone(path: string): FileStamp {
  return { path, exists: false, modified: null, size: 0 };
}

describe("stampChanged", () => {
  it("treats the first observation as a baseline, not a change", () => {
    expect(stampChanged(undefined, stamp("/a", 1, 10))).toBe(false);
  });

  it("detects an mtime move", () => {
    expect(stampChanged(stamp("/a", 1, 10), stamp("/a", 2, 10))).toBe(true);
  });

  it("detects a same-second rewrite by size", () => {
    // mtime has one-second resolution on several filesystems, and a git
    // operation rewriting a file twice in the same second is the normal case.
    expect(stampChanged(stamp("/a", 1, 10), stamp("/a", 1, 11))).toBe(true);
  });

  it("reports nothing when neither moved", () => {
    expect(stampChanged(stamp("/a", 1, 10), stamp("/a", 1, 10))).toBe(false);
  });

  it("treats a deleted file as changed", () => {
    expect(stampChanged(stamp("/a", 1, 10), gone("/a"))).toBe(true);
  });

  it("treats a file reappearing as changed", () => {
    expect(stampChanged(gone("/a"), stamp("/a", 5, 3))).toBe(true);
  });

  it("does not keep reporting a file that is still missing", () => {
    expect(stampChanged(gone("/a"), gone("/a"))).toBe(false);
  });
});

describe("changedPaths", () => {
  it("returns only what moved, in the order observed", () => {
    const before = toStampMap([stamp("/a", 1, 1), stamp("/b", 1, 1), stamp("/c", 1, 1)]);
    const after = [stamp("/a", 1, 1), stamp("/b", 2, 1), stamp("/c", 1, 9)];
    expect(changedPaths(before, after)).toEqual(["/b", "/c"]);
  });

  it("says nothing on the very first poll", () => {
    expect(changedPaths({}, [stamp("/a", 1, 1)])).toEqual([]);
  });
});

describe("planForChanges", () => {
  it("reloads clean buffers and only asks about dirty ones", () => {
    const dirty = new Set(["/dirty.rs"]);
    const plan = planForChanges(["/clean.rs", "/dirty.rs"], (p) => dirty.has(p));
    expect(plan.reload).toEqual(["/clean.rs"]);
    expect(plan.conflicted).toEqual(["/dirty.rs"]);
  });

  it("scales to a branch switch without escalating anything", () => {
    // 200 changed files, none dirty: 200 silent reloads and zero prompts. The
    // interruption count does not grow with the size of the checkout.
    const many = Array.from({ length: 200 }, (_, i) => `/f${i}.rs`);
    const plan = planForChanges(many, () => false);
    expect(plan.reload).toHaveLength(200);
    expect(plan.conflicted).toEqual([]);
  });

  it("is empty for no changes", () => {
    expect(planForChanges([], () => true)).toEqual({ reload: [], conflicted: [] });
  });
});
