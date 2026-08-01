/// The snapshot format's version boundary.
///
/// v1 snapshots are on users' disks right now: five parallel top-level arrays
/// (`files` / `terminals` / `diffs` / `compares` / `stacks`), no `version`
/// field, no pane geometry, no browser or conflict or preview tabs. v2 holds
/// all ten kinds under `tabs` plus the pane tree. The migration runs on read,
/// in memory, so nobody's saved sessions need a write to survive the upgrade —
/// which means it has to be pure, total, and idempotent, and that is what this
/// file pins down.
import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_VERSION,
  emptySnapshotTabs,
  migrateSnapshot,
  snapshotTabCount,
} from "./snapshots";

/// A realistic v1 blob, exactly as `saveWorkspaceSnapshot` wrote it before
/// Wave 4.
const V1 = {
  name: "before-refactor",
  savedAt: 1_700_000_000_000,
  files: ["/repo/src/main.ts", "/repo/src/app.tsx"],
  terminals: [{ label: "Terminal 1", cwd: "/repo" }],
  diffs: ["/repo/src/a.ts"],
  compares: [
    {
      baseRef: "main",
      headRef: "feature",
      useMergeBase: true,
      selectedFilePath: "/repo/src/b.ts",
      treeMode: "flat",
      treeFilter: "src/",
    },
  ],
  stacks: [{ trunk: "main", topBranch: "feature-3" }],
  active: "file:/repo/src/main.ts",
  pinned: ["file:/repo/src/main.ts", "stack:feature-3"],
  ui: {
    gitSidebarCollapsed: false,
    leftSidebarCollapsed: true,
    sidebarsSwapped: false,
    diffMode: "split",
    gitTab: "changes",
    ignoreWhitespace: true,
    sidebarTab: "files",
  },
};

describe("snapshot migration", () => {
  it("upgrades a v1 snapshot without losing a tab, a pin or the pointer", () => {
    const snap = migrateSnapshot(V1);
    expect(snap).not.toBeNull();
    expect(snap!.version).toBe(SNAPSHOT_VERSION);
    expect(snap!.name).toBe("before-refactor");
    expect(snap!.savedAt).toBe(1_700_000_000_000);
    expect(snap!.tabs.files).toEqual(["/repo/src/main.ts", "/repo/src/app.tsx"]);
    expect(snap!.tabs.terminals).toEqual([{ label: "Terminal 1", cwd: "/repo" }]);
    expect(snap!.tabs.diffs).toEqual(["/repo/src/a.ts"]);
    expect(snap!.tabs.compares[0]).toMatchObject({ baseRef: "main", treeMode: "flat" });
    expect(snap!.tabs.stacks).toEqual([{ trunk: "main", topBranch: "feature-3" }]);
    expect(snap!.active).toBe("file:/repo/src/main.ts");
    expect(snap!.pinned).toEqual(["file:/repo/src/main.ts", "stack:feature-3"]);
    expect(snap!.ui.diffMode).toBe("split");
    expect(snap!.ui.leftSidebarCollapsed).toBe(true);
  });

  it("defaults the five kinds v1 never captured, and its missing geometry", () => {
    const snap = migrateSnapshot(V1)!;
    expect(snap.tabs.conflicts).toEqual([]);
    expect(snap.tabs.previews).toEqual([]);
    expect(snap.tabs.browsers).toEqual([]);
    expect(snap.tabs.history).toBe(false);
    // v1 predates pane groups: a restore lands in the single-group default,
    // which is the layout the snapshot was taken in.
    expect(snap.panes).toBeNull();
  });

  it("is idempotent — migrating twice equals migrating once", () => {
    const once = migrateSnapshot(V1)!;
    const twice = migrateSnapshot(JSON.parse(JSON.stringify(once)))!;
    expect(twice).toEqual(once);
  });

  it("carries a v2 snapshot through untouched, geometry included", () => {
    const v2 = {
      version: 2,
      name: "split-work",
      savedAt: 42,
      tabs: {
        ...emptySnapshotTabs(),
        browsers: [{ url: "https://example.com", title: "Example" }],
        history: true,
        brain: true,
      },
      panes: {
        kind: "split",
        id: "sp",
        orientation: "row",
        ratios: [0.5, 0.5],
        children: [
          {
            kind: "group",
            id: "g1",
            group: { id: "g1", tabIds: ["browser:0"], activeTabId: "browser:0" },
          },
          { kind: "group", id: "g2", group: { id: "g2", tabIds: ["history:"], activeTabId: null } },
        ],
      },
      active: "history:",
      pinned: [],
      ui: V1.ui,
    };
    const snap = migrateSnapshot(v2)!;
    expect(snap.tabs.browsers).toEqual([{ url: "https://example.com", title: "Example" }]);
    expect(snap.tabs.history).toBe(true);
    expect(snap.panes).toEqual(v2.panes);
    expect(snap.active).toBe("history:");
  });

  it("drops a blob too broken to name, and repairs the ones that are merely dirty", () => {
    expect(migrateSnapshot(null)).toBeNull();
    expect(migrateSnapshot({ savedAt: 1 })).toBeNull();
    const patched = migrateSnapshot({ name: "half", files: ["ok", 7, null] })!;
    expect(patched.tabs.files).toEqual(["ok"]);
    expect(patched.savedAt).toBe(0);
    // A snapshot from a build without one of these settles on today's default
    // rather than on `undefined`, which would render as an unstyled sidebar.
    expect(patched.ui.diffMode).toBe("unified");
    expect(patched.ui.sidebarTab).toBe("files");
  });

  it("counts every kind in the summary line", () => {
    expect(snapshotTabCount(migrateSnapshot(V1)!)).toBe(2 + 1 + 1 + 1 + 1);
    expect(
      snapshotTabCount({
        version: 2,
        name: "n",
        savedAt: 0,
        tabs: { ...emptySnapshotTabs(), history: true, timeline: true },
        panes: null,
        active: null,
        pinned: [],
        ui: migrateSnapshot(V1)!.ui,
      }),
    ).toBe(2);
  });
});
