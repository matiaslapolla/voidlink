/// The registry's contract, kind by kind.
///
/// Every tab that survives a reload does so by going out through
/// `spec.serialize`, through `JSON.stringify`, and back in through
/// `spec.deserialize`. If that round trip is lossy for one kind, that kind
/// silently loses tabs on the next boot — which is the failure mode this file
/// exists to make impossible to introduce quietly. It runs over *all ten*
/// kinds, including the three that are memory-only today, because Wave 4's
/// session restore turns those on and the serializers have to already be right.
import { describe, expect, it } from "vitest";
import {
  TAB_KINDS,
  TAB_SPECS,
  closedTabsEqual,
  deserializeTabRecord,
  parseEditorTabs,
  samePath,
  serializeEditorTabs,
  type TabKind,
  type TabTypes,
} from "./tabs";

/// One representative tab per kind, with every optional field populated —
/// a fixture that omits `title` would not prove the browser tab round-trips.
const FIXTURES: { [K in TabKind]: TabTypes[K] } = {
  file: { id: "f1", path: "/repo/src/main.ts" },
  terminal: { id: "t1", ptyId: "pty-9", label: "Terminal 2", cwd: "/repo" },
  diff: { id: "d1", filePath: "/repo/src/a.ts" },
  compare: {
    id: "c1",
    baseRef: "main",
    headRef: "feature",
    useMergeBase: false,
    selectedFilePath: "/repo/src/b.ts",
    treeMode: "flat",
    treeFilter: "src/",
  },
  stack: { id: "s1", trunk: "main", topBranch: "feature-3" },
  conflict: { id: "x1", filePath: "/repo/src/c.ts" },
  history: { id: "h1" },
  preview: { id: "p1", filePath: "/repo/README.md" },
  brain: { id: "b1" },
  browser: { id: "w1", url: "https://example.com/docs", title: "Docs" },
};

describe("tab registry", () => {
  it("declares a spec for every kind, and no orphans", () => {
    expect(TAB_KINDS.slice().sort()).toEqual(Object.keys(TAB_SPECS).sort());
    for (const kind of TAB_KINDS) expect(TAB_SPECS[kind].kind).toBe(kind);
  });

  it("round-trips every kind through serialize → JSON → deserialize", () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      const original = FIXTURES[kind];
      const wire = JSON.parse(
        JSON.stringify((spec.serialize as (t: unknown) => unknown)(original)),
      );
      const back = (spec.deserialize as (raw: unknown) => unknown)(wire);
      expect(back, `${kind} failed to deserialize`).toEqual(original);
    }
  });

  it("considers a round-tripped tab equal to the original", () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      const original = FIXTURES[kind];
      const back = (spec.deserialize as (raw: unknown) => unknown)(
        JSON.parse(JSON.stringify((spec.serialize as (t: unknown) => unknown)(original))),
      );
      expect(
        (spec.equals as (a: unknown, b: unknown) => boolean)(original, back),
        `${kind} is not equal to its own round trip`,
      ).toBe(true);
    }
  });

  it("rejects an entry that is missing a required field", () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      expect((spec.deserialize as (raw: unknown) => unknown)(null)).toBeNull();
      expect((spec.deserialize as (raw: unknown) => unknown)({})).toBeNull();
      expect((spec.deserialize as (raw: unknown) => unknown)("nope")).toBeNull();
    }
  });

  it("gives every kind a non-empty label", () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      expect((spec.label as (t: unknown) => string)(FIXTURES[kind]).length).toBeGreaterThan(0);
    }
  });

  it("names a real state field for every kind, and never the same one twice", () => {
    const keys = TAB_KINDS.map((k) => TAB_SPECS[k].stateKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only reopens the kinds that can be reconstructed", () => {
    const reopenable = TAB_KINDS.filter((kind) => {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      return (spec.closedSnapshot as (t: unknown) => unknown)(FIXTURES[kind]) !== null;
    });
    // Terminals lose their PTY, conflicts lose their conflict, and previews,
    // history, brain and browser tabs have nothing worth restoring yet.
    expect(reopenable.slice().sort()).toEqual(["compare", "diff", "file", "stack"]);
  });

  it("labels a browser tab by host when the page never reported a title", () => {
    expect(TAB_SPECS.browser.label({ id: "w", url: "https://example.com/a/b" })).toBe(
      "example.com",
    );
    expect(TAB_SPECS.browser.label({ id: "w", url: "not a url" })).toBe("not a url");
  });
});

describe("deserializeTabRecord", () => {
  it("seeds every known worktree even when the blob mentions none", () => {
    const out = deserializeTabRecord("compare", {}, ["wt-a", "wt-b"]);
    expect(out).toEqual({ "wt-a": [], "wt-b": [] });
  });

  it("drops only the malformed entries, keeping the rest of the list", () => {
    const out = deserializeTabRecord(
      "file",
      { wt: [{ id: "ok", path: "/a" }, { id: "no-path" }, null, 7] },
      ["wt"],
    );
    expect(out.wt.map((f) => f.id)).toEqual(["ok"]);
  });

  it("ignores worktrees the caller did not ask about", () => {
    const out = deserializeTabRecord("file", { other: [{ id: "x", path: "/a" }] }, ["wt"]);
    expect(out).toEqual({ wt: [] });
  });

  it("survives a blob that is not an object at all", () => {
    expect(deserializeTabRecord("stack", "garbage", ["wt"])).toEqual({ wt: [] });
    expect(deserializeTabRecord("stack", null, ["wt"])).toEqual({ wt: [] });
  });
});

describe("editor tab blob", () => {
  it("round-trips the four collections and the pointer", () => {
    const source = {
      openFilesByWorktree: { wt: [FIXTURES.file] },
      diffTabsByWorktree: { wt: [FIXTURES.diff] },
      conflictTabsByWorktree: { wt: [FIXTURES.conflict] },
      previewTabsByWorktree: { wt: [FIXTURES.preview] },
      editorActiveItemByWorktree: {
        wt: { type: "file" as const, id: "f1", path: "/repo/src/main.ts" },
      },
    };
    const back = parseEditorTabs(JSON.stringify(serializeEditorTabs(source)), ["wt"]);
    expect(back.files.wt).toEqual([FIXTURES.file]);
    expect(back.diffs.wt).toEqual([FIXTURES.diff]);
    expect(back.conflicts.wt).toEqual([FIXTURES.conflict]);
    expect(back.previews.wt).toEqual([FIXTURES.preview]);
    expect(back.active.wt).toMatchObject({ type: "file", id: "f1" });
  });

  it("drops a pointer naming a kind the editor window cannot render", () => {
    const back = parseEditorTabs(
      JSON.stringify({ active: { wt: { type: "terminal", id: "t1" } } }),
      ["wt"],
    );
    expect(back.active.wt).toBeNull();
  });
});

describe("samePath", () => {
  it("normalises separators, trailing slashes and the macOS /private prefix", () => {
    expect(samePath("/repo//src/", "/repo/src")).toBe(true);
    expect(samePath("/private/tmp/x", "/tmp/x")).toBe(true);
    expect(samePath("/repo/a", "/repo/b")).toBe(false);
  });
});

describe("closedTabsEqual", () => {
  it("collapses a repeat close of the same tab", () => {
    expect(closedTabsEqual({ type: "file", path: "/a" }, { type: "file", path: "/a" })).toBe(
      true,
    );
    expect(closedTabsEqual({ type: "file", path: "/a" }, { type: "diff", filePath: "/a" })).toBe(
      false,
    );
  });
});
