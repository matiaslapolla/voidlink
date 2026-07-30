/// The registry's contract, kind by kind.
///
/// Every tab that survives a reload does so by going out through
/// `spec.serialize`, through `JSON.stringify`, and back in through
/// `spec.deserialize`. If that round trip is lossy for one kind, that kind
/// silently loses tabs on the next boot — which is the failure mode this file
/// exists to make impossible to introduce quietly. It runs over *all eleven*
/// kinds, including the three that are memory-only today, because Wave 4's
/// session restore turns those on and the serializers have to already be right.
import { describe, expect, it } from "vitest";
import {
  TAB_KINDS,
  TAB_SPECS,
  closedTabsEqual,
  deserializeClosedTab,
  deserializeTabRecord,
  parseEditorTabs,
  samePath,
  serializeEditorTabs,
  type ClosedTab,
  type TabKind,
  type TabTypes,
} from "./tabs";

/// One representative tab per kind, with every optional field populated —
/// a fixture that omits `title` would not prove the browser tab round-trips.
const FIXTURES: { [K in TabKind]: TabTypes[K] } = {
  file: { id: "f1", path: "/repo/src/main.ts" },
  terminal: { id: "t1", ptyId: "pty-9", label: "Terminal 2", cwd: "/repo" },
  // `staged: true` deliberately: the deserializer defaults the field to
  // `false`, so a `false` fixture would round-trip even if `serialize` dropped
  // it entirely.
  diff: { id: "d1", filePath: "/repo/src/a.ts", staged: true },
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
  agent: { id: "a1", agentId: "claude-sonnet", title: "Reviewer" },
};

/// What a round trip is *expected* to produce, where that differs from the
/// fixture. Only the terminal does: a persisted session deliberately does not
/// carry its PTY id, because that id names a process that died with the app.
const ROUND_TRIPPED: Partial<{ [K in TabKind]: TabTypes[K] }> = {
  terminal: { id: "t1", ptyId: "", label: "Terminal 2", cwd: "/repo" },
};

const expectedRoundTrip = (kind: TabKind): unknown => ROUND_TRIPPED[kind] ?? FIXTURES[kind];

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
      expect(back, `${kind} failed to deserialize`).toEqual(expectedRoundTrip(kind));
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

  it("can reopen every one of the eleven kinds", () => {
    const reopenable = TAB_KINDS.filter((kind) => {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      return (spec.closedSnapshot as (t: unknown) => unknown)(FIXTURES[kind]) !== null;
    });
    // Wave 4: reopen-last-closed is driven by the registry, so a kind that
    // declines to be reopened has to *say so* in its spec rather than fall
    // through a switch statement in the store.
    expect(reopenable.slice().sort()).toEqual(TAB_KINDS.slice().sort());
  });

  it("survives a closed-tab snapshot through JSON and back", () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      const snapshot = (spec.closedSnapshot as (t: unknown) => ClosedTab | null)(
        FIXTURES[kind],
      );
      expect(snapshot, `${kind} has no closed snapshot`).not.toBeNull();
      const back = deserializeClosedTab(JSON.parse(JSON.stringify(snapshot)));
      expect(back, `${kind} lost its closed snapshot`).toEqual(snapshot);
      expect(closedTabsEqual(snapshot!, back!)).toBe(true);
    }
  });

  it("round-trips an agent tab whose roster entry had no name", () => {
    // The fixture above populates `title`, which proves the field survives but
    // not that its absence does — and an unnamed roster entry is the case that
    // reaches `serialize` with `undefined`.
    const wire = JSON.parse(
      JSON.stringify(TAB_SPECS.agent.serialize({ id: "a2", agentId: "local-llama" })),
    );
    expect(wire).toEqual({ id: "a2", agentId: "local-llama" });
    expect(TAB_SPECS.agent.deserialize(wire)).toEqual({
      id: "a2",
      agentId: "local-llama",
      title: undefined,
    });
  });

  it("drops an agent tab that names no roster entry", () => {
    // A thread we cannot point at an agent would render a panel with no model
    // behind it, so it costs the tab rather than the boot.
    expect(TAB_SPECS.agent.deserialize({ id: "a3" })).toBeNull();
    expect(TAB_SPECS.agent.deserialize({ agentId: "claude-sonnet" })).toBeNull();
    expect(TAB_SPECS.agent.deserialize({ id: "a3", agentId: 7 })).toBeNull();
    // A non-string title is ignored, not fatal: the label has a fallback.
    expect(TAB_SPECS.agent.deserialize({ id: "a3", agentId: "x", title: 7 })).toEqual({
      id: "a3",
      agentId: "x",
      title: undefined,
    });
  });

  it("labels an agent tab Agent when its title is blank or missing", () => {
    expect(TAB_SPECS.agent.label({ id: "a", agentId: "x" })).toBe("Agent");
    expect(TAB_SPECS.agent.label({ id: "a", agentId: "x", title: "   " })).toBe("Agent");
    expect(TAB_SPECS.agent.label({ id: "a", agentId: "x", title: "Reviewer" })).toBe("Reviewer");
  });

  it("never dedupes two threads on the same agent", () => {
    // Modelled on the browser tab: the id is the identity, so opening a second
    // thread with the same roster entry finds no existing tab to focus.
    expect(
      TAB_SPECS.agent.equals(
        { id: "a1", agentId: "same" },
        { id: "a2", agentId: "same" },
      ),
    ).toBe(false);
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

describe("session restore", () => {
  /// The boot path, kind by kind: what was persisted goes back in through
  /// `restore()` and has to come out as the same tab — *with the same id*,
  /// because pins, pane claims, the MRU and the saved active-tab pointer all
  /// name tabs by id and a restore that reassigned them would bring the tabs
  /// back and lose everything that pointed at them.
  const ctx = { worktreePath: "/repo" };

  it("restores every non-terminal kind from its serialized payload", async () => {
    for (const kind of TAB_KINDS) {
      if (kind === "terminal") continue;
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      const wire = JSON.parse(
        JSON.stringify((spec.serialize as (t: unknown) => unknown)(FIXTURES[kind])),
      );
      const back = await (
        spec.restore as (raw: unknown, c: typeof ctx) => Promise<unknown>
      )(wire, ctx);
      expect(back, `${kind} did not restore`).toEqual(expectedRoundTrip(kind));
    }
  });

  it("restores a terminal against a fresh PTY, keeping the tab id and label", async () => {
    const wire = JSON.parse(
      JSON.stringify(TAB_SPECS.terminal.serialize(FIXTURES.terminal)),
    );
    const spawned: string[] = [];
    const session = await TAB_SPECS.terminal.restore(wire, {
      worktreePath: "/repo/worktrees/feature",
      spawnPty: async (cwd) => {
        spawned.push(cwd);
        return "pty-fresh";
      },
    });
    expect(session).toEqual({
      id: "t1",
      ptyId: "pty-fresh",
      label: "Terminal 2",
      // The shell is rooted in the worktree being restored into, not in the
      // path the session was saved with.
      cwd: "/repo/worktrees/feature",
      restored: true,
    });
    expect(spawned).toEqual(["/repo/worktrees/feature"]);
  });

  it("does not restore a terminal in a window that cannot spawn one", async () => {
    const wire = TAB_SPECS.terminal.serialize(FIXTURES.terminal);
    expect(await TAB_SPECS.terminal.restore(wire, { worktreePath: "/repo" })).toBeNull();
  });

  it("returns null for a malformed payload rather than a half-built tab", async () => {
    for (const kind of TAB_KINDS) {
      const spec = TAB_SPECS[kind] as (typeof TAB_SPECS)[TabKind];
      const restore = spec.restore as (raw: unknown, c: typeof ctx) => Promise<unknown>;
      expect(await restore({ nonsense: true }, ctx), `${kind} accepted junk`).toBeNull();
      expect(await restore(null, ctx), `${kind} accepted null`).toBeNull();
    }
  });
});
