/// `applyEditorRequest` is the one implementation of every editor tab mutation:
/// detached mode reaches it through a cross-window event, stacked mode calls it
/// directly. So these tests are what stop the two modes from diverging, and
/// they double as the guard on the pointer invariant — an editor request must
/// never move the workbench's own focus, or switching to the Editor view would
/// blank out the terminal behind it.

import { beforeEach, describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createAppStore } from "./layout";
import { applyEditorRequest } from "./editorRequests";

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
}

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

beforeEach(() => {
  installLocalStorage();
});

describe("applyEditorRequest", () => {
  it("opens each editor tab kind", () => {
    withStore((store, wtId) => {
      const apply = (req: Parameters<typeof applyEditorRequest>[3]) =>
        applyEditorRequest(store.state, store.actions, wtId, req);

      apply({ kind: "open-file", path: "/repo/a.ts" });
      apply({ kind: "open-diff", filePath: "/repo/b.ts" });
      apply({ kind: "open-conflict", filePath: "/repo/c.ts" });
      apply({ kind: "open-preview", filePath: "/repo/d.md" });

      expect(store.state.openFilesByWorktree[wtId]).toHaveLength(1);
      expect(store.state.diffTabsByWorktree[wtId]).toHaveLength(1);
      expect(store.state.conflictTabsByWorktree[wtId]).toHaveLength(1);
      expect(store.state.previewTabsByWorktree[wtId]).toHaveLength(1);
    });
  });

  it("activates a file by id, resolving its path for Monaco", () => {
    withStore((store, wtId) => {
      const first = store.actions.openFileTab(wtId, "/repo/a.ts");
      store.actions.openFileTab(wtId, "/repo/b.ts");

      applyEditorRequest(store.state, store.actions, wtId, {
        kind: "activate",
        tab: "file",
        id: first,
      });

      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({
        type: "file",
        id: first,
        path: "/repo/a.ts",
      });
    });
  });

  it("ignores an activate for a tab that no longer exists", () => {
    withStore((store, wtId) => {
      const only = store.actions.openFileTab(wtId, "/repo/a.ts");
      applyEditorRequest(store.state, store.actions, wtId, {
        kind: "activate",
        tab: "file",
        id: "gone",
      });
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({ id: only });
    });
  });

  it("closes a tab and leaves focus inside the editor's own kinds", () => {
    withStore((store, wtId) => {
      const diff = store.actions.openDiffTab(wtId, "/repo/b.ts");
      const file = store.actions.openFileTab(wtId, "/repo/a.ts");

      applyEditorRequest(store.state, store.actions, wtId, {
        kind: "close",
        tab: "file",
        id: file,
      });

      expect(store.state.openFilesByWorktree[wtId]).toHaveLength(0);
      expect(store.state.editorActiveItemByWorktree[wtId]).toMatchObject({
        type: "diff",
        id: diff,
      });
    });
  });

  it("reorders within a kind", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");
      const b = store.actions.openFileTab(wtId, "/repo/b.ts");

      applyEditorRequest(store.state, store.actions, wtId, {
        kind: "reorder",
        tab: "file",
        fromId: b,
        toId: a,
      });

      expect(store.state.openFilesByWorktree[wtId].map((f) => f.id)).toEqual([b, a]);
    });
  });

  it("toggles a pin", () => {
    withStore((store, wtId) => {
      const a = store.actions.openFileTab(wtId, "/repo/a.ts");

      applyEditorRequest(store.state, store.actions, wtId, { kind: "toggle-pin", id: a });
      expect(store.actions.isTabPinned(wtId, a)).toBe(true);

      applyEditorRequest(store.state, store.actions, wtId, { kind: "toggle-pin", id: a });
      expect(store.actions.isTabPinned(wtId, a)).toBe(false);
    });
  });

  it("opens a compare tab with its selected file, on the workbench pointer", () => {
    withStore((store, wtId) => {
      applyEditorRequest(store.state, store.actions, wtId, {
        kind: "open-compare",
        baseRef: "main",
        headRef: "feature",
        useMergeBase: true,
        selectedFilePath: "src/a.ts",
      });

      const tabs = store.state.compareTabsByWorktree[wtId];
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({
        baseRef: "main",
        headRef: "feature",
        useMergeBase: true,
        selectedFilePath: "src/a.ts",
      });
      // Compare is a workbench surface, so this one *does* move the workbench
      // pointer — the opposite of every other request here.
      expect(store.state.activeItemByWorktree[wtId]).toMatchObject({ type: "compare" });
    });
  });

  it("never moves the workbench pointer for an editor tab", () => {
    withStore((store, wtId) => {
      store.actions.selectTerminal(wtId, "term-1");

      for (const req of [
        { kind: "open-file", path: "/repo/a.ts" },
        { kind: "open-diff", filePath: "/repo/b.ts" },
        { kind: "open-conflict", filePath: "/repo/c.ts" },
        { kind: "open-preview", filePath: "/repo/d.md" },
      ] as Parameters<typeof applyEditorRequest>[3][]) {
        applyEditorRequest(store.state, store.actions, wtId, req);
      }

      expect(store.state.activeItemByWorktree[wtId]).toMatchObject({
        type: "terminal",
        id: "term-1",
      });
    });
  });
});
