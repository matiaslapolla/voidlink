import { describe, expect, it } from "vitest";
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

describe("runLayoutMigration", () => {
  function fakeStorage(initial: Record<string, string>) {
    const map = new Map(Object.entries(initial));
    const writes: string[] = [];
    return {
      writes,
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        writes.push(k);
        map.set(k, v);
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

  it("stamps the version even when there is nothing to migrate", () => {
    const store = fakeStorage({});
    expect(runLayoutMigration(store)).toBe(true);
    expect(store.getItem(LAYOUT_VERSION_KEY)).toBe(String(LAYOUT_VERSION));
    expect(store.getItem(WORKSPACES_KEY)).toBeNull();
  });
});
