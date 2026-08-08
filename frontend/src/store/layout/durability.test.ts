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
import { groupList } from "./panes";

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
  it("brings back every persisted kind, including the two that were memory-only", async () => {
    backing.set(
      STORAGE_KEYS.terminalTabs,
      JSON.stringify({ [WT_ID]: [{ id: "term-1", label: "build", cwd: "/repo" }] }),
    );
    backing.set(STORAGE_KEYS.historyTabs, JSON.stringify({ [WT_ID]: [{ id: "hist-1" }] }));
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
  it("reopens all ten kinds, one pop each, most recent first", async () => {
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
      actions.closeBrowserTab(WT_ID, ids.browser);
      actions.closeAgentTab(WT_ID, ids.agent);

      expect(state.closedTabsByWorktree[WT_ID]).toHaveLength(10);

      const popped: ClosedTab["type"][] = [];
      for (let i = 0; i < 10; i++) {
        const tab = actions.reopenLastClosedTab(WT_ID);
        expect(tab, `pop ${i} came back empty`).not.toBeNull();
        popped.push(tab!.type);
      }
      expect(popped).toEqual([
        "agent",
        "browser",
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

  it("reopens a closed pane group as a fresh, empty split in the same shape", async () => {
    await withStoreAsync(async (store) => {
      const { actions, state } = store;
      await actions.spawnTerminal(WT_ID);
      const termId = state.terminalsByWorktree[WT_ID][0].id;

      const pgId = actions.addTabToSplitPane(WT_ID, termId);
      expect(pgId).not.toBeNull();
      expect(state.panegroupTabsByWorktree[WT_ID]).toHaveLength(1);

      actions.closePaneGroupTab(WT_ID, pgId!);
      expect(state.panegroupTabsByWorktree[WT_ID]).toHaveLength(0);
      // The terminal itself is untouched — closing the split never closes
      // what was inside it.
      expect(state.terminalsByWorktree[WT_ID]).toHaveLength(1);

      const popped = actions.reopenLastClosedTab(WT_ID);
      expect(popped?.type).toBe("panegroup");
      expect(state.panegroupTabsByWorktree[WT_ID]).toHaveLength(1);
      // A fresh id, a fresh empty split — not the terminal's old claim, which
      // is still wherever it fell back to.
      const reopened = state.panegroupTabsByWorktree[WT_ID][0];
      expect(reopened.id).not.toBe(pgId);
      expect(reopened.layout.kind).toBe("split");
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

describe("panegroup tabs", () => {
  it("opens a split, splits further inside its own tree, and tracks ratios/claims/focus live", async () => {
    await withStoreAsync(async (store) => {
      const { actions, state } = store;
      await actions.spawnTerminal(WT_ID, "left");
      await actions.spawnTerminal(WT_ID, "right");
      const terms = state.terminalsByWorktree[WT_ID];
      const termAId = terms[0].id;
      const termBId = terms[1].id;

      // "Add to split pane": a fresh two-pane split, `termA` in the first.
      const firstPaneGroupId = actions.addTabToSplitPane(WT_ID, termAId);
      expect(firstPaneGroupId).not.toBeNull();
      const pg = state.panegroupTabsByWorktree[WT_ID][0];
      expect(pg.layout.kind).toBe("split");
      if (pg.layout.kind !== "split") throw new Error("unreachable");
      // `termA` left the root strip entirely — it is not "unclaimed" there,
      // and it does not render there either.
      expect(actions.paneGroupOwning(WT_ID, termAId)).toBeNull();
      const secondGroupId = pg.layout.children[1];
      expect(secondGroupId.kind).toBe("group");
      if (secondGroupId.kind !== "group") throw new Error("unreachable");

      // Split further — inside the panegroup's own tree, not the root's —
      // and land `termB` in the new pane, both as one write.
      const secondInnerGroupId = actions.splitPaneGroupWithTab(
        WT_ID,
        "column",
        "after",
        secondGroupId.group.id,
        termBId,
        firstPaneGroupId!,
      );
      expect(secondInnerGroupId).not.toBeNull();

      // Drag a ratio on the nested split.
      const nested = state.panegroupTabsByWorktree[WT_ID][0].layout;
      if (nested.kind === "split") {
        actions.setPaneSplitRatios(WT_ID, nested.id, [0.3, 0.7], firstPaneGroupId!);
      }
      const after = state.panegroupTabsByWorktree[WT_ID][0].layout;
      expect(after.kind === "split" ? after.ratios : null).toEqual([
        expect.closeTo(0.3, 5),
        expect.closeTo(0.7, 5),
      ]);

      // Claims and focus: the drop already claimed `termB` in its own inner
      // pane and focused it there.
      expect(actions.paneGroupOwning(WT_ID, termBId, firstPaneGroupId!)).toBe(
        secondInnerGroupId,
      );
      const innerGroup = groupList(after).find((g) => g.id === secondInnerGroupId);
      expect(innerGroup?.tabIds).toContain(termBId);
      expect(innerGroup?.activeTabId).toBe(termBId);
    });
  });

  it("survives a reload with its ratios, claims and focused pane intact", () => {
    // Seeded directly, like every other kind's reload test in this file
    // (`createEffect` does not run in this non-DOM environment) — this is
    // exactly the shape `TAB_SPECS.panegroup.serialize` produces, proven in
    // `tabs.test.ts`'s round-trip test; what is new here is that the *store*
    // wires it up under `panegroupTabsByWorktree`, not a bespoke field.
    backing.set(
      STORAGE_KEYS.panegroupTabs,
      JSON.stringify({
        [WT_ID]: [
          {
            id: "pg-1",
            seq: 1,
            layout: {
              kind: "split",
              id: "s1",
              orientation: "row",
              ratios: [0.3, 0.7],
              children: [
                { kind: "group", id: "g-left", group: { id: "g-left", tabIds: ["t1"], activeTabId: "t1" } },
                { kind: "group", id: "g-right", group: { id: "g-right", tabIds: ["t2"], activeTabId: "t2" } },
              ],
            },
          },
        ],
      }),
    );

    withStore((store) => {
      const pg = store.state.panegroupTabsByWorktree[WT_ID][0];
      expect(pg).toBeTruthy();
      expect(pg.layout.kind).toBe("split");
      if (pg.layout.kind !== "split") throw new Error("unreachable");
      expect(pg.layout.ratios[0]).toBeCloseTo(0.3, 5);
      expect(pg.layout.ratios[1]).toBeCloseTo(0.7, 5);
      const right = pg.layout.children[1];
      expect(right.kind).toBe("group");
      if (right.kind !== "group") throw new Error("unreachable");
      expect(right.group.tabIds).toEqual(["t2"]);
      expect(right.group.activeTabId).toBe("t2");
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

  it("drops one panegroup tab over a malformed nested payload, keeping its siblings and the boot", () => {
    // `panegroupTabs` itself is valid JSON — this is not the quarantine path
    // above. One entry's `layout` is impossible (a split with a single
    // child, which `splitGroup` never produces): `parsePaneLayout` rejects
    // it, `deserializePaneGroupTab` returns `null` for that one entry, and
    // `deserializeTabRecord` drops just it, the same contract every other
    // kind's malformed row already gets.
    backing.set(
      STORAGE_KEYS.panegroupTabs,
      JSON.stringify({
        [WT_ID]: [
          {
            id: "pg-bad",
            seq: 1,
            layout: { kind: "split", id: "s", orientation: "row", ratios: [1], children: [] },
          },
          {
            id: "pg-good",
            seq: 2,
            layout: { kind: "group", id: "g1", group: { id: "g1", tabIds: [], activeTabId: null } },
          },
        ],
      }),
    );
    const reported: string[] = [];
    setCorruptKeyHandler((key) => reported.push(key));

    withStore((store) => {
      expect(store.state.panegroupTabsByWorktree[WT_ID].map((t) => t.id)).toEqual(["pg-good"]);
      expect(store.state.workspaces).toHaveLength(1);
    });
    // Not a quarantine — the blob parsed fine and the key is not reported.
    expect(reported).toEqual([]);
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

/// CMP-F31. The tree width used to be one `localStorage` key shared by every
/// compare tab in every window, so widening the tree to read a deep vendored
/// path also widened it in the tab next door showing three root-level files —
/// and only after a reload, since nothing told the live tabs.
describe("compare tree width", () => {
  it("belongs to one tab and not its neighbour", () => {
    withStore((store) => {
      const { actions, state } = store;
      const wide = actions.openCompareTab(WT_ID, { baseRef: "main", headRef: "feat" });
      const narrow = actions.openCompareTab(WT_ID, { baseRef: "main", headRef: "other" });

      actions.setCompareTreeWidth(WT_ID, wide, 500);

      const tabs = state.compareTabsByWorktree[WT_ID];
      expect(tabs.find((t) => t.id === wide)!.treeWidth).toBe(500);
      expect(tabs.find((t) => t.id === narrow)!.treeWidth).toBe(320);
    });
  });

  /// A stored width is user-writable and outlives the version of the app that
  /// wrote it, so an out-of-range one has to come back as something the pane
  /// can still be dragged out of.
  it("clamps a width the pane could not be recovered from", () => {
    withStore((store) => {
      const { actions, state } = store;
      const id = actions.openCompareTab(WT_ID, { baseRef: "main", headRef: "feat" });

      actions.setCompareTreeWidth(WT_ID, id, 0);
      expect(state.compareTabsByWorktree[WT_ID][0].treeWidth).toBe(220);

      actions.setCompareTreeWidth(WT_ID, id, 10_000);
      expect(state.compareTabsByWorktree[WT_ID][0].treeWidth).toBe(600);

      actions.setCompareTreeWidth(WT_ID, id, Number.NaN);
      expect(state.compareTabsByWorktree[WT_ID][0].treeWidth).toBe(320);
    });
  });
});

/// The docking arrangement is geometry, not view state, so it belongs to the
/// same durability contract as the panel widths: a reload — and, in stacked
/// mode, a switch away from the workbench and back — must come back to the
/// layout the user built rather than to the defaults.
///
/// Asserted from the *storage* side, like `session restore` above: this project
/// has no DOM, so the store's persist effects never run here (see
/// `vitest.config.ts` — the unit project deliberately skips Solid's browser
/// build). Seeding the blob and hydrating it is the half of the round trip this
/// harness can prove; `prefs.test.ts` proves the parse, and the write is the
/// same effect every other preference in this file rides on.
describe("sidebar docking", () => {
  it("comes back to the edges and the order the user left", () => {
    backing.set(
      STORAGE_KEYS.gitPrefs,
      JSON.stringify({
        dockSide: { workspaces: "left", explorer: "right", git: "left" },
        dockOrder: ["git", "workspaces", "explorer"],
        workspaceRailCollapsed: true,
        panels: { rail: 212, sidebar: 256, gitSidebar: 420 },
      }),
    );

    withStore((store) => {
      expect(store.state.dockSide).toEqual({
        workspaces: "left",
        explorer: "right",
        terminals: "left",
        agents: "left",
        git: "left",
      });
      // Ids missing from the persisted order append in their shipped position.
      expect(store.state.dockOrder).toEqual([
        "git",
        "workspaces",
        "explorer",
        "terminals",
        "agents",
      ]);
      expect(store.state.workspaceRailCollapsed).toBe(true);
      // The width belongs to the panel, not to the edge it was on.
      expect(store.state.panels.gitSidebar).toBe(420);
    });
  });

  it("remembers which panels are in a window of their own", () => {
    backing.set(STORAGE_KEYS.gitPrefs, JSON.stringify({ detachedSidebars: ["git"] }));
    // Persisted so a relaunch can *reopen* the window rather than silently
    // pulling the panel back into a shell the user had already emptied.
    withStore((store) => expect(store.state.detachedSidebars).toEqual(["git"]));
  });

  it("hydrates a pre-dock blob into the arrangement its flag produced", () => {
    backing.set(STORAGE_KEYS.gitPrefs, JSON.stringify({ sidebarsSwapped: true }));
    withStore((store) =>
      expect(store.state.dockSide).toEqual({
        workspaces: "left",
        explorer: "right",
        terminals: "right",
        agents: "right",
        git: "left",
      }),
    );
  });

  it("moves a panel's edge and its position in one write", () => {
    withStore((store) => {
      store.actions.dockSidebar("git", "left", "workspaces");
      expect(store.state.dockSide.git).toBe("left");
      expect(store.state.dockOrder).toEqual([
        "git",
        "workspaces",
        "explorer",
        "terminals",
        "agents",
      ]);
    }, false);
  });

  it("mirrors the whole arrangement, and mirroring twice is the identity", () => {
    withStore((store) => {
      const before = { ...store.state.dockSide };
      const order = [...store.state.dockOrder];

      store.actions.mirrorSidebars();
      expect(store.state.dockSide.git).toBe("left");
      expect(store.state.dockSide.explorer).toBe("right");

      store.actions.mirrorSidebars();
      expect(store.state.dockSide).toEqual(before);
      expect(store.state.dockOrder).toEqual(order);
    }, false);
  });

  it("keeps a moved panel's width — the width belongs to the panel, not the edge", () => {
    withStore((store) => {
      store.actions.setPanelWidth("gitSidebar", 420);
      store.actions.dockSidebar("git", "left");
      expect(store.state.panels.gitSidebar).toBe(420);
    }, false);
  });

  it("detaching and docking back is one flag, and is idempotent either way", () => {
    withStore((store) => {
      store.actions.setSidebarDetached("git", true);
      store.actions.setSidebarDetached("git", true);
      expect(store.state.detachedSidebars).toEqual(["git"]);
      store.actions.setSidebarDetached("git", false);
      expect(store.state.detachedSidebars).toEqual([]);
    }, false);
  });
});
