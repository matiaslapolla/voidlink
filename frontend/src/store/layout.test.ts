/// Coverage for the split between the two windows' active-tab pointers.
///
/// The editor window renders `openFiles` / `diffs` / `conflicts` / `previews`
/// and the workbench renders the rest, but both sets live in one store and one
/// window writes it. The invariant that makes that safe — a mutation to one
/// window's tabs never moves the other window's focus — is what these tests
/// pin down, because breaking it looks like "the terminal blanked out when I
/// clicked a file" rather than like a crash.

import { beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createAppStore, parseEditorTabs, serializeEditorTabs } from "./layout";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "./migrate";

/// The store hydrates from (and, when persisting, writes to) localStorage,
/// which the node test environment does not provide.
function installLocalStorage() {
  const backing = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k) => backing.get(k) ?? null,
    key: (i) => [...backing.keys()][i] ?? null,
    removeItem: (k) => void backing.delete(k),
    setItem: (k, v) => void backing.set(k, String(v)),
  };
  (globalThis as { localStorage: Storage }).localStorage = stub;
  return backing;
}

/// A store with one workspace and one worktree, disposed after `fn` runs.
function withStore(fn: (store: ReturnType<typeof createAppStore>, wtId: string) => void) {
  createRoot((dispose) => {
    const store = createAppStore({ persist: false });
    try {
      fn(store, store.state.activeWorktreeId);
    } finally {
      dispose();
    }
  });
}

/// Pin the workspace and worktree ids in storage. Without this each store
/// invents a fresh uuid, and a test that hydrates a second store would be
/// looking up tabs under an id the first one never used.
const WT_ID = "77777777-7777-4777-8777-777777777777";

function seedWorkspace(backing: Map<string, string>) {
  backing.set(LAYOUT_VERSION_KEY, String(LAYOUT_VERSION));
  backing.set(
    WORKSPACES_KEY,
    JSON.stringify([
      {
        id: "88888888-8888-4888-8888-888888888888",
        name: "Main",
        repoRoot: "/repo",
        worktrees: [
          { id: WT_ID, path: "/repo", branch: "main", isMain: true, isSynthetic: false },
        ],
        activeWorktreeId: WT_ID,
        isRepo: true,
      },
    ]),
  );
}

beforeEach(() => {
  installLocalStorage();
});

describe("editor tab pointer", () => {
  it("focuses an opened file without touching the workbench pointer", () => {
    withStore((store, wtId) => {
      store.actions.openFileTab(wtId, "/repo/a.ts");
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({
        type: "file",
        path: "/repo/a.ts",
      });
      expect(store.state.activeItemByWorktree[wtId]).toBeNull();
    });
  });

  it("keeps the two pointers independent", () => {
    withStore((store, wtId) => {
      // Stand in for a spawned terminal without going near a real PTY.
      store.actions.selectTerminal(wtId, "term-1");
      store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.openDiffTab(wtId, "/repo/b.ts");

      expect(store.state.activeItemByWorktree[wtId]).toMatchObject({
        type: "terminal",
        id: "term-1",
      });
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ type: "diff" });
    });
  });

  it("reuses the existing tab when the same file is opened twice", () => {
    withStore((store, wtId) => {
      const first = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.openFileTab(wtId, "/repo/b.ts");
      const again = store.actions.openFileTab(wtId, "/repo/a.ts");

      expect(again).toBe(first);
      expect(store.state.openFilesByWorktree[wtId]).toHaveLength(2);
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ id: first });
    });
  });

  it("falls back within the editor's own kinds when the active file closes", () => {
    withStore((store, wtId) => {
      const first = store.actions.openFileTab(wtId, "/repo/a.ts");
      const second = store.actions.openFileTab(wtId, "/repo/b.ts");
      store.actions.closeFileTab(wtId, second);

      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ id: first });
    });
  });

  it("falls back to a diff when the last file closes", () => {
    withStore((store, wtId) => {
      const diff = store.actions.openDiffTab(wtId, "/repo/b.ts");
      const file = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.closeFileTab(wtId, file);

      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({
        type: "diff",
        id: diff,
      });
    });
  });

  it("never falls back to a terminal, which this window cannot show", () => {
    withStore((store, wtId) => {
      store.actions.selectTerminal(wtId, "term-1");
      const file = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.closeFileTab(wtId, file);

      expect(store.state.editorActiveItemByWorktree[wtId]).toBeNull();
      // …and the workbench is still looking at its terminal.
      expect(store.state.activeItemByWorktree[wtId]).toMatchObject({ type: "terminal" });
    });
  });

  it("routes conflict and preview tabs to the editor pointer too", () => {
    withStore((store, wtId) => {
      store.actions.openConflictTab(wtId, "/repo/c.ts");
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ type: "conflict" });

      store.actions.openPreviewTab(wtId, "/repo/README.md");
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ type: "preview" });
      expect(store.state.activeItemByWorktree[wtId]).toBeNull();
    });
  });

  it("closing a workbench tab leaves the editor's focus alone", () => {
    withStore((store, wtId) => {
      const file = store.actions.openFileTab(wtId, "/repo/a.ts");
      const compare = store.actions.openCompareTab(wtId, { baseRef: "main", headRef: "HEAD" });
      store.actions.closeCompareTab(wtId, compare);

      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ id: file });
    });
  });
});

describe("tab mutations the editor window requests", () => {
  it("selects a tab by id", () => {
    withStore((store, wtId) => {
      const first = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.openFileTab(wtId, "/repo/b.ts");
      store.actions.selectFileTab(wtId, first, "/repo/a.ts");

      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({
        id: first,
        path: "/repo/a.ts",
      });
    });
  });

  it("reorders files by dropping one onto another", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");
      const b = store.actions.openFileTab(wtId, "/repo/b.ts");
      const c = store.actions.openFileTab(wtId, "/repo/c.ts");

      store.actions.reorderItemTab(wtId, "file", c, a);
      expect(store.state.openFilesByWorktree[wtId].map((f) => f.id)).toEqual([c, a, b]);
    });
  });

  it("moves a tab to the end when dropped on nothing", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");
      const b = store.actions.openFileTab(wtId, "/repo/b.ts");

      store.actions.reorderItemTab(wtId, "file", a, null);
      expect(store.state.openFilesByWorktree[wtId].map((f) => f.id)).toEqual([b, a]);
    });
  });

  it("toggles a pin on and off", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");

      store.actions.togglePinTab(wtId, a);
      expect(store.actions.isTabPinned(wtId, a)).toBe(true);
      store.actions.togglePinTab(wtId, a);
      expect(store.actions.isTabPinned(wtId, a)).toBe(false);
    });
  });

  it("drops the pin when the tab it belongs to closes", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.togglePinTab(wtId, a);
      store.actions.closeFileTab(wtId, a);

      expect(store.state.pinnedTabsByWorktree[wtId]).not.toContain(a);
    });
  });

  it("reopens a closed file as a fresh tab", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.closeFileTab(wtId, a);
      const popped = store.actions.reopenLastClosedTab(wtId);

      expect(popped).toEqual({ type: "file", path: "/repo/a.ts" });
      expect(store.state.openFilesByWorktree[wtId]).toHaveLength(1);
      expect(store.state.openFilesByWorktree[wtId][0].id).not.toBe(a);
    });
  });
});

describe("editor tab persistence", () => {
  /// The workbench is the only window that writes tab state, so a workbench
  /// reload is the one event that can lose the editor window's tabs. This is
  /// that round trip: serialize what the store holds, parse it back the way
  /// boot does, and check nothing fell out.
  it("round-trips the four collections and the pointer", () => {
    withStore((store, wtId) => {
      const fileId = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.openDiffTab(wtId, "/repo/b.ts");
      store.actions.openConflictTab(wtId, "/repo/c.ts");
      store.actions.openPreviewTab(wtId, "/repo/README.md");
      store.actions.selectFileTab(wtId, fileId, "/repo/a.ts");

      const wire = JSON.stringify(serializeEditorTabs(store.state));
      const back = parseEditorTabs(wire, [wtId]);

      expect(back.files[wtId].map((f) => f.path)).toEqual(["/repo/a.ts"]);
      expect(back.diffs[wtId].map((d) => d.filePath)).toEqual(["/repo/b.ts"]);
      expect(back.conflicts[wtId].map((c) => c.filePath)).toEqual(["/repo/c.ts"]);
      expect(back.previews[wtId].map((p) => p.filePath)).toEqual(["/repo/README.md"]);
      expect(back.active[wtId]).toMatchObject({ type: "file", id: fileId });
    });
  });

  it("hydrates a store from persisted tabs", () => {
    const backing = installLocalStorage();
    seedWorkspace(backing);
    backing.set(
      "voidlink-editor-tabs",
      JSON.stringify({
        files: { [WT_ID]: [{ id: "f1", path: "/repo/a.ts" }] },
        diffs: { [WT_ID]: [{ id: "d1", filePath: "/repo/b.ts" }] },
        conflicts: { [WT_ID]: [] },
        previews: { [WT_ID]: [] },
        active: { [WT_ID]: { type: "file", id: "f1", path: "/repo/a.ts" } },
      }),
    );

    withStore((store, wtId) => {
      expect(wtId).toBe(WT_ID);
      expect(store.state.openFilesByWorktree[wtId].map((f) => f.path)).toEqual(["/repo/a.ts"]);
      expect(store.state.diffTabsByWorktree[wtId]).toHaveLength(1);
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ id: "f1" });
    });
  });

  it("drops entries that are missing the fields a tab needs", () => {
    const back = parseEditorTabs(
      JSON.stringify({
        files: { wt: [{ id: "ok", path: "/repo/a.ts" }, { id: "no-path" }, null] },
      }),
      ["wt"],
    );
    expect(back.files.wt.map((f) => f.id)).toEqual(["ok"]);
    expect(back.diffs.wt).toEqual([]);
  });

  it("ignores a stored pointer that names a workbench-only kind", () => {
    // Stale state from a build where one pointer held every kind.
    const back = parseEditorTabs(
      JSON.stringify({ active: { wt: { type: "terminal", id: "term-1" } } }),
      ["wt"],
    );
    expect(back.active.wt).toBeNull();
  });

  it("survives a corrupt blob rather than failing to boot", () => {
    const back = parseEditorTabs("{not json", ["wt"]);
    expect(back.files.wt).toEqual([]);
    expect(back.active.wt).toBeNull();
  });
});
