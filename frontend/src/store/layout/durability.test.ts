/// State durability: what survives a reload, what survives a *crash*, and what
/// a corrupt blob is allowed to cost.
///
/// Three properties, each of which failed silently before Wave 4:
///
///   1. **Session restore is complete.** Every kind in the registry comes back
///      on boot — including the three that were memory-only (terminal, history,
///      brain) and the workbench's active-tab pointer, which had never been
///      persisted at all.
///   2. **Reopen-closed covers all eleven kinds**, driven by the registry's
///      `closedSnapshot`, and the history outlives the reload.
///   3. **A corrupt or half-written blob costs exactly one key.** Not the boot,
///      not a white screen, and not the other nine keys.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { LAYOUT_VERSION, LAYOUT_VERSION_KEY, WORKSPACES_KEY } from "@/store/migrate";

const createPty = vi.fn<(cwd: string) => Promise<string>>(async () => `pty-${ptyCounter++}`);
let ptyCounter = 1;

vi.mock("@/api/terminal", () => ({
  terminalApi: {
    createPty: (cwd: string) => createPty(cwd),
    closePty: async () => {},
    writePty: async () => {},
    processInfo: async () => null,
  },
}));

import { createAppStore } from "./index";
import {
  STORAGE_KEYS,
  flushWrites,
  resetCorruptionReports,
  setCorruptKeyHandler,
  writeJson,
} from "./persistence";
import type { ClosedTab } from "./tabs";

const WT_ID = "77777777-7777-4777-8777-777777777777";

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

type Store = ReturnType<typeof createAppStore>;

/// A store in a reactive root, disposed after `fn`. `persist` defaults to true
/// because durability is the whole subject here.
function withStore<T>(fn: (store: Store) => T, persist = true): T {
  return createRoot((dispose) => {
    const store = createAppStore({ persist });
    try {
      return fn(store);
    } finally {
      dispose();
    }
  });
}

async function withStoreAsync<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const { store, dispose } = createRoot((d) => ({
    store: createAppStore({ persist: true }),
    dispose: d,
  }));
  try {
    return await fn(store);
  } finally {
    dispose();
  }
}

let backing: Map<string, string>;

beforeEach(() => {
  backing = installLocalStorage();
  seedWorkspace(backing);
  resetCorruptionReports();
  setCorruptKeyHandler(() => {});
  createPty.mockClear();
  ptyCounter = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session restore", () => {
  it("brings back every persisted kind, including the three that were memory-only", async () => {
    backing.set(
      STORAGE_KEYS.terminalTabs,
      JSON.stringify({ [WT_ID]: [{ id: "term-1", label: "build", cwd: "/repo" }] }),
    );
    backing.set(STORAGE_KEYS.historyTabs, JSON.stringify({ [WT_ID]: [{ id: "hist-1" }] }));
    backing.set(STORAGE_KEYS.brainTabs, JSON.stringify({ [WT_ID]: [{ id: "brain-1" }] }));
    backing.set(
      STORAGE_KEYS.browserTabs,
      JSON.stringify({ [WT_ID]: [{ id: "web-1", url: "https://example.com" }] }),
    );
    backing.set(
      STORAGE_KEYS.stackTabs,
      JSON.stringify({ [WT_ID]: [{ id: "st-1", trunk: "main", topBranch: "feat" }] }),
    );
    backing.set(
      STORAGE_KEYS.agentTabs,
      JSON.stringify({
        [WT_ID]: [{ id: "agent-1", agentId: "claude-sonnet", title: "Reviewer" }],
      }),
    );

    await withStoreAsync(async (store) => {
      expect(store.state.historyTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(store.state.brainTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(store.state.browserTabsByWorktree[WT_ID][0].url).toBe("https://example.com");
      expect(store.state.stackTabsByWorktree[WT_ID][0].topBranch).toBe("feat");
      // Same tab id, so the thread's transcript — which is keyed by it — is
      // still reachable after the reload.
      const agent = store.state.agentTabsByWorktree[WT_ID][0];
      expect(agent.id).toBe("agent-1");
      expect(agent.agentId).toBe("claude-sonnet");
      expect(agent.title).toBe("Reviewer");

      // The terminal's PTY is spawned, so it arrives a tick later.
      await Promise.resolve();
      await Promise.resolve();
      const term = store.state.terminalsByWorktree[WT_ID][0];
      expect(term).toBeDefined();
      // Same tab id — pins, pane claims and the MRU all name it.
      expect(term.id).toBe("term-1");
      expect(term.label).toBe("build");
      expect(term.ptyId).toBe("pty-1");
      // And flagged, so nothing in the UI can imply the scrollback came back.
      expect(term.restored).toBe(true);
      expect(createPty).toHaveBeenCalledWith("/repo");
    });
  });

  it("restores the workbench's active tab, which was never persisted before", () => {
    backing.set(STORAGE_KEYS.historyTabs, JSON.stringify({ [WT_ID]: [{ id: "hist-1" }] }));
    backing.set(
      STORAGE_KEYS.activeItem,
      JSON.stringify({ [WT_ID]: { type: "history", id: "hist-1" } }),
    );
    withStore((store) => {
      expect(store.activeItem()).toEqual({ type: "history", id: "hist-1" });
    });
  });

  it("refuses an active pointer naming a kind the workbench cannot render", () => {
    backing.set(
      STORAGE_KEYS.activeItem,
      JSON.stringify({ [WT_ID]: { type: "file", id: "f1", path: "/repo/a.ts" } }),
    );
    withStore((store) => {
      expect(store.activeItem()).toBeNull();
    });
  });

  it("does not spawn a single PTY in a window that does not own them", async () => {
    backing.set(
      STORAGE_KEYS.terminalTabs,
      JSON.stringify({ [WT_ID]: [{ id: "term-1", label: "build", cwd: "/repo" }] }),
    );
    withStore((store) => {
      expect(store.state.terminalsByWorktree[WT_ID]).toEqual([]);
    }, false);
    await Promise.resolve();
    expect(createPty).not.toHaveBeenCalled();
  });
});

describe("reopen closed tabs", () => {
  it("reopens all eleven kinds, one pop each, most recent first", async () => {
    await withStoreAsync(async (store) => {
      const { actions, state } = store;
      // Open one of every kind. Files/diffs/conflicts/previews live in the
      // editor window's pointer; the other seven in the workbench's.
      actions.openFileTab(WT_ID, "/repo/a.ts");
      await actions.spawnTerminal(WT_ID);
      actions.openDiffTab(WT_ID, "/repo/b.ts");
      actions.openCompareTab(WT_ID, { baseRef: "main", headRef: "feat" });
      actions.openStackTab(WT_ID, { trunk: "main", topBranch: "feat" });
      actions.openConflictTab(WT_ID, "/repo/c.ts");
      actions.openHistoryTab(WT_ID);
      actions.openPreviewTab(WT_ID, "/repo/README.md");
      actions.openBrainTab(WT_ID);
      actions.openBrowserTab(WT_ID, "https://example.com");
      actions.openAgentTab(WT_ID, "claude-sonnet", "Reviewer");

      const ids = {
        file: state.openFilesByWorktree[WT_ID][0].id,
        terminal: state.terminalsByWorktree[WT_ID][0].id,
        diff: state.diffTabsByWorktree[WT_ID][0].id,
        compare: state.compareTabsByWorktree[WT_ID][0].id,
        stack: state.stackTabsByWorktree[WT_ID][0].id,
        conflict: state.conflictTabsByWorktree[WT_ID][0].id,
        history: state.historyTabsByWorktree[WT_ID][0].id,
        preview: state.previewTabsByWorktree[WT_ID][0].id,
        brain: state.brainTabsByWorktree[WT_ID][0].id,
        browser: state.browserTabsByWorktree[WT_ID][0].id,
        agent: state.agentTabsByWorktree[WT_ID][0].id,
      };

      actions.closeFileTab(WT_ID, ids.file);
      actions.removeTerminal(WT_ID, ids.terminal);
      actions.closeDiffTab(WT_ID, ids.diff);
      actions.closeCompareTab(WT_ID, ids.compare);
      actions.closeStackTab(WT_ID, ids.stack);
      actions.closeConflictTab(WT_ID, ids.conflict);
      actions.closeHistoryTab(WT_ID, ids.history);
      actions.closePreviewTab(WT_ID, ids.preview);
      actions.closeBrainTab(WT_ID, ids.brain);
      actions.closeBrowserTab(WT_ID, ids.browser);
      actions.closeAgentTab(WT_ID, ids.agent);

      expect(state.closedTabsByWorktree[WT_ID]).toHaveLength(11);

      const popped: ClosedTab["type"][] = [];
      for (let i = 0; i < 11; i++) {
        const tab = actions.reopenLastClosedTab(WT_ID);
        expect(tab, `pop ${i} came back empty`).not.toBeNull();
        popped.push(tab!.type);
      }
      expect(popped).toEqual([
        "agent",
        "browser",
        "brain",
        "preview",
        "history",
        "conflict",
        "stack",
        "compare",
        "diff",
        "terminal",
        "file",
      ]);
      expect(actions.reopenLastClosedTab(WT_ID)).toBeNull();

      // And every kind is actually back on screen.
      await Promise.resolve();
      expect(state.openFilesByWorktree[WT_ID]).toHaveLength(1);
      expect(state.diffTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.compareTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.stackTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.conflictTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.historyTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.previewTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.brainTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.browserTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.terminalsByWorktree[WT_ID]).toHaveLength(1);
      // A fresh thread on the same agent, under the title it was closed with.
      expect(state.agentTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(state.agentTabsByWorktree[WT_ID][0].agentId).toBe("claude-sonnet");
      expect(state.agentTabsByWorktree[WT_ID][0].title).toBe("Reviewer");
    });
  });

  it("reopens a terminal under the label it was closed with, not Terminal N", async () => {
    await withStoreAsync(async (store) => {
      const { actions, state } = store;
      await actions.spawnTerminal(WT_ID);
      const id = await actions.reopenTerminal(WT_ID, "watcher", "/repo/sub");
      expect(id).not.toBeNull();
      const term = state.terminalsByWorktree[WT_ID].find((t) => t.id === id)!;
      expect(term.label).toBe("watcher");
      expect(term.restored).toBe(true);
    });
  });

  it("keeps the closed-tab history across a reload", () => {
    // Persisted by the store's write effect on close; seeded here directly
    // because `createEffect` does not run in this (non-DOM) test environment.
    backing.set(
      STORAGE_KEYS.closedTabs,
      JSON.stringify({
        [WT_ID]: [{ type: "browser", url: "https://example.com/gone" }],
      }),
    );
    withStore((store) => {
      const reopened = store.actions.reopenLastClosedTab(WT_ID);
      expect(reopened).toEqual({
        type: "browser",
        url: "https://example.com/gone",
        title: undefined,
      });
    });
  });
});

describe("corrupt and half-written blobs", () => {
  it("degrades exactly the corrupt key and leaves the rest intact", () => {
    backing.set(STORAGE_KEYS.stackTabs, "{not json at all");
    backing.set(
      STORAGE_KEYS.browserTabs,
      JSON.stringify({ [WT_ID]: [{ id: "web-1", url: "https://example.com" }] }),
    );
    backing.set(STORAGE_KEYS.historyTabs, JSON.stringify({ [WT_ID]: [{ id: "hist-1" }] }));

    const reported: string[] = [];
    setCorruptKeyHandler((key) => reported.push(key));

    withStore((store) => {
      expect(store.state.stackTabsByWorktree[WT_ID]).toEqual([]);
      expect(store.state.browserTabsByWorktree[WT_ID]).toHaveLength(1);
      expect(store.state.historyTabsByWorktree[WT_ID]).toHaveLength(1);
      // Still a working shell, with a workspace and a worktree.
      expect(store.state.workspaces).toHaveLength(1);
      expect(store.activeWorktree()?.path).toBe("/repo");
    });

    expect(reported).toEqual([STORAGE_KEYS.stackTabs]);
  });

  it("recovers the shadow copy a crash left behind mid-write", () => {
    // A process killed between the shadow write and the commit: the committed
    // value is truncated, the shadow is whole.
    backing.set(STORAGE_KEYS.browserTabs, '{"' + WT_ID + '": [{"id": "web');
    backing.set(
      STORAGE_KEYS.browserTabs + "~pending",
      JSON.stringify({ [WT_ID]: [{ id: "web-1", url: "https://example.com/saved" }] }),
    );
    const reported: string[] = [];
    setCorruptKeyHandler((key) => reported.push(key));

    withStore((store) => {
      expect(store.state.browserTabsByWorktree[WT_ID][0].url).toBe(
        "https://example.com/saved",
      );
    });
    // Nothing was lost, so nothing is reported.
    expect(reported).toEqual([]);
  });

  it("commits through a shadow key and clears it", () => {
    writeJson(STORAGE_KEYS.browserTabs, { [WT_ID]: [{ id: "w", url: "committed" }] });
    flushWrites();
    expect(backing.get(STORAGE_KEYS.browserTabs)).toContain("committed");
    // The shadow only exists between the two `setItem`s; a settled write
    // leaves nothing behind for the next boot to prefer.
    expect(backing.has(STORAGE_KEYS.browserTabs + "~pending")).toBe(false);
  });

  it("drops a corrupt key's report once the key is legible again", () => {
    backing.set(STORAGE_KEYS.stackTabs, "{{{");
    const reported: string[] = [];
    setCorruptKeyHandler((key) => reported.push(key));
    withStore((store) => {
      expect(store.state.stackTabsByWorktree[WT_ID]).toEqual([]);
    });
    // Reported once, not on every read of the same boot.
    withStore(() => {});
    expect(reported).toEqual([STORAGE_KEYS.stackTabs]);

    // A legitimate write heals it, and the next corruption reports again.
    writeJson(STORAGE_KEYS.stackTabs, { [WT_ID]: [] });
    flushWrites();
    backing.set(STORAGE_KEYS.stackTabs, "}}}");
    withStore(() => {});
    expect(reported).toEqual([STORAGE_KEYS.stackTabs, STORAGE_KEYS.stackTabs]);
  });
});
