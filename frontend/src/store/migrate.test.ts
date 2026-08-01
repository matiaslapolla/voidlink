import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createAppStore } from "./layout";
import {
  LAYOUT_VERSION,
  LAYOUT_VERSION_KEY,
  WORKSPACES_KEY,
  type StorageSnapshot,
  migrateLayoutStorage,
  runLayoutMigration,
} from "./migrate";

const COMPARE_TABS_KEY = "voidlink-compare-tabs";
const PINNED_TABS_KEY = "voidlink-pinned-tabs";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

interface MigratedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
  worktrees: { id: string; path: string; branch: string | null; isMain: boolean }[];
  activeWorktreeId: string;
  isRepo: boolean;
}

/// A realistic v0 snapshot: two workspaces, each with tabs open. Note that the
/// tab collections are keyed by *workspace* id — the whole point of the
/// migration is that they don't have to change.
function v0Snapshot(): StorageSnapshot {
  return {
    [WORKSPACES_KEY]: JSON.stringify([
      { id: WS_A, name: "voidlink", repoRoot: "/Users/dev/voidlink" },
      { id: WS_B, name: "notes", repoRoot: null },
    ]),
    [COMPARE_TABS_KEY]: JSON.stringify({
      [WS_A]: [{ id: "cmp-1", baseRef: "main", headRef: "feature" }],
      [WS_B]: [],
    }),
    [PINNED_TABS_KEY]: JSON.stringify({ [WS_A]: ["cmp-1"], [WS_B]: [] }),
    [LAYOUT_VERSION_KEY]: null,
  };
}

function workspacesOf(snap: StorageSnapshot): MigratedWorkspace[] {
  return JSON.parse(snap[WORKSPACES_KEY] ?? "[]") as MigratedWorkspace[];
}

describe("migrateLayoutStorage", () => {
  it("gives each v0 workspace exactly one main worktree", () => {
    const after = migrateLayoutStorage(v0Snapshot());
    const workspaces = workspacesOf(after);

    expect(workspaces).toHaveLength(2);
    for (const ws of workspaces) {
      expect(ws.worktrees).toHaveLength(1);
      expect(ws.worktrees[0].isMain).toBe(true);
      expect(ws.activeWorktreeId).toBe(ws.worktrees[0].id);
    }
    expect(workspaces[0].worktrees[0].path).toBe("/Users/dev/voidlink");
    // A workspace with no repo picked yet still gets a worktree, with an
    // empty path rather than a null one.
    expect(workspaces[1].worktrees[0].path).toBe("");
  });

  it("keeps every previously-open tab reachable under the new keying", () => {
    const before = v0Snapshot();
    const after = migrateLayoutStorage(before);
    const workspaces = workspacesOf(after);

    // The load-bearing invariant: worktree id === old workspace id, so the
    // untouched tab blobs still resolve.
    const compares = JSON.parse(after[COMPARE_TABS_KEY] ?? "{}") as Record<
      string,
      { id: string }[]
    >;
    const pinned = JSON.parse(after[PINNED_TABS_KEY] ?? "{}") as Record<string, string[]>;

    for (const ws of workspaces) {
      const wtId = ws.worktrees[0].id;
      expect(compares[wtId]).toBeDefined();
      expect(pinned[wtId]).toBeDefined();
    }
    expect(compares[workspaces[0].worktrees[0].id]).toEqual([
      { id: "cmp-1", baseRef: "main", headRef: "feature" },
    ]);
    expect(pinned[workspaces[0].worktrees[0].id]).toEqual(["cmp-1"]);

    // And the blobs themselves were not rewritten at all.
    expect(after[COMPARE_TABS_KEY]).toBe(before[COMPARE_TABS_KEY]);
    expect(after[PINNED_TABS_KEY]).toBe(before[PINNED_TABS_KEY]);
  });

  it("stamps the layout version", () => {
    const after = migrateLayoutStorage(v0Snapshot());
    expect(after[LAYOUT_VERSION_KEY]).toBe(String(LAYOUT_VERSION));
  });

  it("is a no-op when run twice", () => {
    const once = migrateLayoutStorage(v0Snapshot());
    const twice = migrateLayoutStorage(once);
    expect(twice).toEqual(once);
  });

  it("is a no-op on already-migrated workspaces even without the version key", () => {
    const migrated = migrateLayoutStorage(v0Snapshot());
    const versionStripped: StorageSnapshot = { ...migrated, [LAYOUT_VERSION_KEY]: null };
    const again = migrateLayoutStorage(versionStripped);
    expect(workspacesOf(again)).toEqual(workspacesOf(migrated));
  });

  it("does not mutate its input", () => {
    const before = v0Snapshot();
    const frozen = JSON.stringify(before);
    migrateLayoutStorage(before);
    expect(JSON.stringify(before)).toBe(frozen);
  });

  it("leaves corrupt workspace JSON alone so the store can fall back", () => {
    const after = migrateLayoutStorage({
      [WORKSPACES_KEY]: "{ not json",
      [LAYOUT_VERSION_KEY]: null,
    });
    expect(after[WORKSPACES_KEY]).toBe("{ not json");
    expect(after[LAYOUT_VERSION_KEY]).toBe(String(LAYOUT_VERSION));
  });

  it("drops workspace entries with no usable id", () => {
    const after = migrateLayoutStorage({
      [WORKSPACES_KEY]: JSON.stringify([{ name: "broken" }, { id: WS_A, name: "ok" }]),
      [LAYOUT_VERSION_KEY]: null,
    });
    const workspaces = workspacesOf(after);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe(WS_A);
  });

  it("does not persist an empty workspace list", () => {
    const after = migrateLayoutStorage({
      [WORKSPACES_KEY]: "[]",
      [LAYOUT_VERSION_KEY]: null,
    });
    expect(after[WORKSPACES_KEY]).toBe("[]");
  });
});

// ── v1 → v2 ────────────────────────────────────────────────────────────────
//
// v2 accompanies the `store/layout.ts` → `store/layout/` decomposition. The
// thing worth proving is a negative: a user on the v1 build reloads into
// *exactly* the tabs, pins and active items they had. So the assertions below
// are not about the snapshot's shape — they are about what a real store
// hydrates to after the migration has run over realistic saved state.

const WT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const STACK_TABS_KEY = "voidlink-stack-tabs";
const BROWSER_TABS_KEY = "voidlink-browser-tabs";
const EDITOR_TABS_KEY = "voidlink-editor-tabs";

/// Everything a heavy user has on disk at v1: two worktrees in one workspace,
/// all six tab blobs populated, pins set, and an editor pointer per worktree.
function v1Snapshot(): StorageSnapshot {
  return {
    [LAYOUT_VERSION_KEY]: "1",
    [WORKSPACES_KEY]: JSON.stringify([
      {
        id: WS_A,
        name: "voidlink",
        repoRoot: "/repo",
        worktrees: [
          { id: WT_A, path: "/repo", branch: "main", isMain: true, isSynthetic: false },
          { id: WT_B, path: "/repo-wt", branch: "feat", isMain: false, isSynthetic: false },
        ],
        activeWorktreeId: WT_A,
        isRepo: true,
      },
    ]),
    "voidlink-active-workspace": WS_A,
    [COMPARE_TABS_KEY]: JSON.stringify({
      [WT_A]: [
        {
          id: "cmp-1",
          baseRef: "main",
          headRef: "feat",
          useMergeBase: false,
          selectedFilePath: "/repo/x.ts",
          treeMode: "flat",
          treeFilter: "src",
        },
      ],
      [WT_B]: [],
    }),
    [STACK_TABS_KEY]: JSON.stringify({
      [WT_A]: [{ id: "stk-1", trunk: "main", topBranch: "feat-3" }],
      [WT_B]: [],
    }),
    [BROWSER_TABS_KEY]: JSON.stringify({
      [WT_A]: [{ id: "brw-1", url: "https://example.com", title: "Example" }],
      [WT_B]: [],
    }),
    [EDITOR_TABS_KEY]: JSON.stringify({
      files: {
        [WT_A]: [
          { id: "f1", path: "/repo/a.ts" },
          { id: "f2", path: "/repo/b.ts" },
        ],
        [WT_B]: [{ id: "f3", path: "/repo-wt/c.ts" }],
      },
      diffs: { [WT_A]: [{ id: "d1", filePath: "/repo/d.ts" }], [WT_B]: [] },
      conflicts: { [WT_A]: [], [WT_B]: [{ id: "x1", filePath: "/repo-wt/e.ts" }] },
      previews: { [WT_A]: [{ id: "p1", filePath: "/repo/README.md" }], [WT_B]: [] },
      active: {
        [WT_A]: { type: "file", id: "f2", path: "/repo/b.ts" },
        [WT_B]: { type: "conflict", id: "x1" },
      },
    }),
    [PINNED_TABS_KEY]: JSON.stringify({ [WT_A]: ["f1", "cmp-1"], [WT_B]: [] }),
    // Something the layout store has never heard of, which must survive.
    "voidlink-settings": JSON.stringify({ theme: "monokai" }),
  };
}

describe("migrateLayoutStorage v1 → v2", () => {
  it("stamps v2 and leaves every well-formed blob byte-identical", () => {
    const before = v1Snapshot();
    const after = migrateLayoutStorage(before);

    // Stamped at the *current* version, not at 2: every later step is a no-op
    // on this fixture, which is the property the byte-identity checks below
    // actually assert.
    expect(after[LAYOUT_VERSION_KEY]).toBe(String(LAYOUT_VERSION));
    for (const key of [
      WORKSPACES_KEY,
      COMPARE_TABS_KEY,
      STACK_TABS_KEY,
      BROWSER_TABS_KEY,
      EDITOR_TABS_KEY,
      PINNED_TABS_KEY,
    ]) {
      expect(after[key], `${key} was rewritten`).toBe(before[key]);
    }
  });

  it("carries keys it does not own through untouched", () => {
    const after = migrateLayoutStorage(v1Snapshot());
    expect(after["voidlink-settings"]).toBe(JSON.stringify({ theme: "monokai" }));
  });

  it("is a no-op when run twice", () => {
    const once = migrateLayoutStorage(v1Snapshot());
    expect(migrateLayoutStorage(once)).toEqual(once);
  });

  it("quarantines a blob that is not a JSON object, and only that blob", () => {
    const after = migrateLayoutStorage({
      ...v1Snapshot(),
      [STACK_TABS_KEY]: '{"wt": [{"id": "trunc',
    });
    expect(after[STACK_TABS_KEY]).toBe("{}");
    // Its neighbour is untouched.
    expect(after[COMPARE_TABS_KEY]).toBe(v1Snapshot()[COMPARE_TABS_KEY]);
  });

  it("does not mutate its input", () => {
    const before = v1Snapshot();
    const frozen = JSON.stringify(before);
    migrateLayoutStorage(before);
    expect(JSON.stringify(before)).toBe(frozen);
  });
});

describe("a v1 user's session after the upgrade", () => {
  /// Drive the real thing: seed a fake `localStorage` with the v1 snapshot,
  /// build a store (which runs the migration on the way in), and check what the
  /// user actually sees. Inspecting the snapshot would prove the transform
  /// self-consistent; only this proves the tabs came back.
  function hydrate(snapshot: StorageSnapshot) {
    const backing = new Map<string, string>();
    for (const [k, v] of Object.entries(snapshot)) if (v !== null) backing.set(k, v);
    (globalThis as { localStorage: Storage }).localStorage = {
      get length() {
        return backing.size;
      },
      clear: () => backing.clear(),
      getItem: (k: string) => backing.get(k) ?? null,
      key: (i: number) => [...backing.keys()][i] ?? null,
      removeItem: (k: string) => void backing.delete(k),
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
    };
    return backing;
  }

  it("reloads into exactly the same open tabs, pins and active items", () => {
    hydrate(v1Snapshot());
    createRoot((dispose) => {
      const store = createAppStore({ persist: false });
      const s = store.state;

      expect(s.activeWorkspaceId).toBe(WS_A);
      expect(s.activeWorktreeId).toBe(WT_A);

      expect(s.openFilesByWorktree[WT_A].map((f) => f.path)).toEqual([
        "/repo/a.ts",
        "/repo/b.ts",
      ]);
      expect(s.openFilesByWorktree[WT_B].map((f) => f.path)).toEqual(["/repo-wt/c.ts"]);
      expect(s.diffTabsByWorktree[WT_A].map((d) => d.filePath)).toEqual(["/repo/d.ts"]);
      expect(s.conflictTabsByWorktree[WT_B].map((c) => c.filePath)).toEqual([
        "/repo-wt/e.ts",
      ]);
      expect(s.previewTabsByWorktree[WT_A].map((p) => p.filePath)).toEqual([
        "/repo/README.md",
      ]);
      expect(s.compareTabsByWorktree[WT_A]).toEqual([
        {
          id: "cmp-1",
          baseRef: "main",
          headRef: "feat",
          useMergeBase: false,
          selectedFilePath: "/repo/x.ts",
          treeMode: "flat",
          treeFilter: "src",
          // State written before the tree width became per-tab carries none,
          // so the deserializer supplies the default rather than a `NaN` the
          // pane would render as no width at all.
          treeWidth: 320,
        },
      ]);
      expect(s.stackTabsByWorktree[WT_A]).toEqual([
        { id: "stk-1", trunk: "main", topBranch: "feat-3" },
      ]);
      expect(s.browserTabsByWorktree[WT_A]).toEqual([
        { id: "brw-1", url: "https://example.com", title: "Example" },
      ]);

      expect(s.pinnedTabsByWorktree[WT_A]).toEqual(["f1", "cmp-1"]);
      expect(s.editorActiveItemByWorktree[WT_A]).toMatchObject({ type: "file", id: "f2" });
      expect(s.editorActiveItemByWorktree[WT_B]).toMatchObject({
        type: "conflict",
        id: "x1",
      });
      // The workbench pointer has never been persisted, and still is not.
      expect(s.activeItemByWorktree[WT_A]).toBeNull();

      dispose();
    });
  });

  it("loses one key, not the session, when a blob is corrupt", () => {
    hydrate({ ...v1Snapshot(), [STACK_TABS_KEY]: "{ truncated" });
    createRoot((dispose) => {
      const store = createAppStore({ persist: false });
      expect(store.state.stackTabsByWorktree[WT_A]).toEqual([]);
      // Everything else still came back.
      expect(store.state.openFilesByWorktree[WT_A]).toHaveLength(2);
      expect(store.state.compareTabsByWorktree[WT_A]).toHaveLength(1);
      dispose();
    });
  });
});

describe("runLayoutMigration", () => {
  function fakeStorage(initial: Record<string, string>) {
    const map = new Map(Object.entries(initial));
    const writes: string[] = [];
    const removals: string[] = [];
    return {
      writes,
      removals,
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        map.set(k, v);
      },
      removeItem: (k: string) => {
        removals.push(k);
        map.delete(k);
      },
    };
  }

  it("writes on the first run and writes nothing on the second", () => {
    const store = fakeStorage({
      [WORKSPACES_KEY]: JSON.stringify([
        { id: WS_A, name: "voidlink", repoRoot: "/Users/dev/voidlink" },
      ]),
    });

    expect(runLayoutMigration(store)).toBe(true);
    expect(store.writes).toContain(WORKSPACES_KEY);
    expect(store.writes).toContain(LAYOUT_VERSION_KEY);

    store.writes.length = 0;
    expect(runLayoutMigration(store)).toBe(false);
    expect(store.writes).toEqual([]);
  });

  /// v2 → v3, as a test. The brain tab kind was cut (2026-07-29 audit, C2), so
  /// its key is deleted rather than left behind — and deleted *once*, which is
  /// what the second run asserts.
  it("removes the retired brain-tabs key, and only when it is there", () => {
    const store = fakeStorage({ "voidlink-brain-tabs": JSON.stringify({ wt: [{ id: "b1" }] }) });

    expect(runLayoutMigration(store)).toBe(true);
    expect(store.removals).toEqual(["voidlink-brain-tabs"]);
    expect(store.getItem("voidlink-brain-tabs")).toBeNull();

    store.removals.length = 0;
    store.writes.length = 0;
    expect(runLayoutMigration(store)).toBe(false);
    expect(store.removals).toEqual([]);
  });

  /// A key that was never there must not be "removed" — otherwise every boot
  /// reports a write it did not make, and `runLayoutMigration`'s return value
  /// stops meaning anything.
  it("does not report a removal for a key that was already absent", () => {
    const store = fakeStorage({});
    runLayoutMigration(store);
    expect(store.removals).toEqual([]);
  });

  it("stamps the version even when there is nothing to migrate", () => {
    const store = fakeStorage({});
    expect(runLayoutMigration(store)).toBe(true);
    expect(store.getItem(LAYOUT_VERSION_KEY)).toBe(String(LAYOUT_VERSION));
    expect(store.getItem(WORKSPACES_KEY)).toBeNull();
  });
});
