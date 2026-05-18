import { createStore, produce } from "solid-js/store";
import { createEffect, createMemo } from "solid-js";
import { terminalApi } from "@/api/terminal";
import {
  type PersistedWorkspace,
  type TerminalSession,
  type Workspace,
  makeWorkspace,
} from "@/types/workspace";
import {
  type WorkspaceSnapshot,
  snapshotsFor,
  upsertSnapshot,
} from "@/commands/snapshots";

const WORKSPACES_KEY = "voidlink-workspaces";
const ACTIVE_WS_KEY = "voidlink-active-workspace";

export type DiffMode = "inline" | "split";
export type GitTab = "changes" | "branches" | "history";
export type SidebarTab = "files" | "terminals";

export interface DiffTab {
  id: string;
  filePath: string;
}

export type ActiveItem =
  | { type: "terminal"; id: string }
  | { type: "diff"; id: string }
  | { type: "file"; id: string; path: string }
  | { type: "compare"; id: string }
  | { type: "stack"; id: string }
  | { type: "conflict"; id: string };

export interface ConflictTab {
  id: string;
  filePath: string;
}

export interface OpenFileTab {
  id: string;
  path: string;
}

export type CompareTreeMode = "tree" | "flat";

export interface CompareTab {
  id: string;
  baseRef: string;
  headRef: string;
  useMergeBase: boolean;
  selectedFilePath: string | null;
  treeMode: CompareTreeMode;
  treeFilter: string;
}

/// Persistent identifier for a stack tab. We don't cache the chain itself —
/// each render re-runs discovery so the tab stays correct as branches move.
/// `trunk` + `topBranch` together pick the stack out across reloads.
export interface StackTab {
  id: string;
  trunk: string;
  topBranch: string;
}

/// Snapshot of a closed tab kept so `reopenLastClosedTab` can recreate
/// it. We capture *enough state* to reconstruct, not the original id —
/// reopening always produces a fresh id so we don't collide with any
/// future tab. Terminals aren't snapshot-able (the PTY is gone).
export type ClosedTab =
  | { type: "file"; path: string }
  | { type: "diff"; filePath: string }
  | {
      type: "compare";
      baseRef: string;
      headRef: string;
      useMergeBase: boolean;
      selectedFilePath: string | null;
      treeMode: CompareTreeMode;
      treeFilter: string;
    }
  | { type: "stack"; trunk: string; topBranch: string };

const CLOSED_TAB_HISTORY_LIMIT = 20;

interface AppStoreState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  terminalsByWorkspace: Record<string, TerminalSession[]>;
  diffTabsByWorkspace: Record<string, DiffTab[]>;
  openFilesByWorkspace: Record<string, OpenFileTab[]>;
  compareTabsByWorkspace: Record<string, CompareTab[]>;
  stackTabsByWorkspace: Record<string, StackTab[]>;
  conflictTabsByWorkspace: Record<string, ConflictTab[]>;
  /// LIFO stack of recently closed tabs, capped at CLOSED_TAB_HISTORY_LIMIT.
  /// Lives in memory only — closing the app drops the history (matches
  /// what most editors do with reopen-last-closed).
  closedTabsByWorkspace: Record<string, ClosedTab[]>;
  /// Pinned tab IDs per workspace; pins survive close-all-others actions
  /// and render leftmost in the tab strip.
  pinnedTabsByWorkspace: Record<string, string[]>;
  activeItemByWorkspace: Record<string, ActiveItem | null>;
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  sidebarsSwapped: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: { changes: boolean; branches: boolean; stack: boolean; history: boolean; openedDiffs: boolean };
  sidebarSections: { files: boolean; terminals: boolean };
}

const GIT_PREFS_KEY = "voidlink-git-prefs";

interface GitPrefs {
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  sidebarsSwapped: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: { changes: boolean; branches: boolean; stack: boolean; history: boolean; openedDiffs: boolean };
  sidebarSections: { files: boolean; terminals: boolean };
}

function loadGitPrefs(): GitPrefs {
  try {
    const raw = localStorage.getItem(GIT_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GitPrefs>;
      return {
        gitSidebarCollapsed: parsed.gitSidebarCollapsed ?? false,
        leftSidebarCollapsed: parsed.leftSidebarCollapsed ?? false,
        sidebarsSwapped: parsed.sidebarsSwapped ?? false,
        diffMode: parsed.diffMode === "split" ? "split" : "inline",
        gitTab:
          parsed.gitTab === "branches" || parsed.gitTab === "history"
            ? parsed.gitTab
            : "changes",
        ignoreWhitespace: parsed.ignoreWhitespace ?? false,
        sidebarTab: parsed.sidebarTab === "files" ? "files" : "terminals",
        gitSections: {
          changes: parsed.gitSections?.changes ?? true,
          branches: parsed.gitSections?.branches ?? true,
          stack: parsed.gitSections?.stack ?? true,
          history: parsed.gitSections?.history ?? true,
          openedDiffs: parsed.gitSections?.openedDiffs ?? true,
        },
        sidebarSections: {
          files: parsed.sidebarSections?.files ?? true,
          terminals: parsed.sidebarSections?.terminals ?? true,
        },
      };
    }
  } catch {
    // ignore
  }
  return {
    gitSidebarCollapsed: false,
    leftSidebarCollapsed: false,
    sidebarsSwapped: false,
    diffMode: "inline",
    gitTab: "changes",
    ignoreWhitespace: false,
    sidebarTab: "terminals",
    gitSections: { changes: true, branches: true, stack: true, history: true, openedDiffs: true },
    sidebarSections: { files: true, terminals: true },
  };
}

const COMPARE_TABS_KEY = "voidlink-compare-tabs";
const STACK_TABS_KEY = "voidlink-stack-tabs";
const PINNED_TABS_KEY = "voidlink-pinned-tabs";

function closedTabsEqual(a: ClosedTab, b: ClosedTab): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "file":
      return b.type === "file" && a.path === b.path;
    case "diff":
      return b.type === "diff" && a.filePath === b.filePath;
    case "compare":
      return (
        b.type === "compare" && a.baseRef === b.baseRef && a.headRef === b.headRef
      );
    case "stack":
      return b.type === "stack" && a.trunk === b.trunk && a.topBranch === b.topBranch;
  }
}

function loadPinnedTabs(workspaceIds: string[]): Record<string, string[]> {
  const empty = Object.fromEntries(workspaceIds.map((id) => [id, [] as string[]]));
  try {
    const raw = localStorage.getItem(PINNED_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, string[]> = { ...empty };
    for (const wsId of workspaceIds) {
      const list = Array.isArray(parsed[wsId]) ? parsed[wsId] : [];
      out[wsId] = list.filter((id): id is string => typeof id === "string");
    }
    return out;
  } catch {
    return empty;
  }
}

function loadStackTabs(workspaceIds: string[]): Record<string, StackTab[]> {
  const empty = Object.fromEntries(workspaceIds.map((id) => [id, [] as StackTab[]]));
  try {
    const raw = localStorage.getItem(STACK_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, StackTab[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, StackTab[]> = { ...empty };
    for (const wsId of workspaceIds) {
      const list = Array.isArray(parsed[wsId]) ? parsed[wsId] : [];
      out[wsId] = list
        .filter(
          (t) =>
            t &&
            typeof t.id === "string" &&
            typeof t.trunk === "string" &&
            typeof t.topBranch === "string",
        )
        .map<StackTab>((t) => ({ id: t.id, trunk: t.trunk, topBranch: t.topBranch }));
    }
    return out;
  } catch {
    return empty;
  }
}

function loadCompareTabs(workspaceIds: string[]): Record<string, CompareTab[]> {
  const empty = Object.fromEntries(workspaceIds.map((id) => [id, [] as CompareTab[]]));
  try {
    const raw = localStorage.getItem(COMPARE_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, CompareTab[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, CompareTab[]> = { ...empty };
    for (const wsId of workspaceIds) {
      const list = Array.isArray(parsed[wsId]) ? parsed[wsId] : [];
      out[wsId] = list
        .filter(
          (t) =>
            t &&
            typeof t.id === "string" &&
            typeof t.baseRef === "string" &&
            typeof t.headRef === "string",
        )
        .map<CompareTab>((t) => ({
          id: t.id,
          baseRef: t.baseRef,
          headRef: t.headRef,
          useMergeBase: typeof t.useMergeBase === "boolean" ? t.useMergeBase : true,
          selectedFilePath:
            typeof t.selectedFilePath === "string" ? t.selectedFilePath : null,
          treeMode: t.treeMode === "flat" ? "flat" : "tree",
          treeFilter: typeof t.treeFilter === "string" ? t.treeFilter : "",
        }));
    }
    return out;
  } catch {
    return empty;
  }
}

function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedWorkspace[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const workspaces = parsed.map((p) => ({
          id: p.id,
          name: p.name,
          repoRoot: p.repoRoot ?? null,
        }));
        const stored = localStorage.getItem(ACTIVE_WS_KEY);
        const activeId =
          stored && workspaces.some((w) => w.id === stored) ? stored : workspaces[0].id;
        return { workspaces, activeId };
      }
    }
  } catch {
    // ignore
  }
  const first = makeWorkspace("Main");
  return { workspaces: [first], activeId: first.id };
}

export function createAppStore() {
  const { workspaces, activeId } = loadWorkspaces();
  const gitPrefs = loadGitPrefs();
  const [state, setState] = createStore<AppStoreState>({
    workspaces,
    activeWorkspaceId: activeId,
    terminalsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    diffTabsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    openFilesByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    compareTabsByWorkspace: loadCompareTabs(workspaces.map((w) => w.id)),
    stackTabsByWorkspace: loadStackTabs(workspaces.map((w) => w.id)),
    conflictTabsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    closedTabsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    pinnedTabsByWorkspace: loadPinnedTabs(workspaces.map((w) => w.id)),
    activeItemByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, null])),
    gitSidebarCollapsed: gitPrefs.gitSidebarCollapsed,
    leftSidebarCollapsed: gitPrefs.leftSidebarCollapsed,
    sidebarsSwapped: gitPrefs.sidebarsSwapped,
    diffMode: gitPrefs.diffMode,
    gitTab: gitPrefs.gitTab,
    ignoreWhitespace: gitPrefs.ignoreWhitespace,
    sidebarTab: gitPrefs.sidebarTab,
    gitSections: gitPrefs.gitSections,
    sidebarSections: gitPrefs.sidebarSections,
  });

  createEffect(() => {
    const serialized: PersistedWorkspace[] = state.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      repoRoot: w.repoRoot,
    }));
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(serialized));
    localStorage.setItem(ACTIVE_WS_KEY, state.activeWorkspaceId);
  });

  createEffect(() => {
    localStorage.setItem(
      COMPARE_TABS_KEY,
      JSON.stringify(state.compareTabsByWorkspace),
    );
  });

  createEffect(() => {
    localStorage.setItem(
      STACK_TABS_KEY,
      JSON.stringify(state.stackTabsByWorkspace),
    );
  });

  createEffect(() => {
    localStorage.setItem(
      PINNED_TABS_KEY,
      JSON.stringify(state.pinnedTabsByWorkspace),
    );
  });

  createEffect(() => {
    localStorage.setItem(
      GIT_PREFS_KEY,
      JSON.stringify({
        gitSidebarCollapsed: state.gitSidebarCollapsed,
        leftSidebarCollapsed: state.leftSidebarCollapsed,
        sidebarsSwapped: state.sidebarsSwapped,
        diffMode: state.diffMode,
        gitTab: state.gitTab,
        ignoreWhitespace: state.ignoreWhitespace,
        sidebarTab: state.sidebarTab,
        gitSections: state.gitSections,
        sidebarSections: state.sidebarSections,
      } satisfies GitPrefs),
    );
  });

  const activeWorkspace = createMemo(
    () => state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null,
  );
  const activeTerminals = createMemo(
    () => state.terminalsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeDiffTabs = createMemo(
    () => state.diffTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeOpenFiles = createMemo(
    () => state.openFilesByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeCompareTabs = createMemo(
    () => state.compareTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeStackTabs = createMemo(
    () => state.stackTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeConflictTabs = createMemo(
    () => state.conflictTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeItem = createMemo(
    () => state.activeItemByWorkspace[state.activeWorkspaceId] ?? null,
  );
  const activeClosedTabs = createMemo(
    () => state.closedTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activePinnedTabs = createMemo(
    () => state.pinnedTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );

  // Keep the previous default: a fresh workspace with one terminal focuses it.
  // Items are focused directly by their spawn/select actions below.

  /// Push `tab` to the workspace's closed-tab LIFO. Same snapshot present
  /// multiple times back-to-back collapses to a single entry so closing
  /// the same diff twice doesn't bury other recent closes.
  function pushClosed(s: AppStoreState, wsId: string, tab: ClosedTab) {
    const list = s.closedTabsByWorkspace[wsId] ?? [];
    const last = list[list.length - 1];
    if (last && closedTabsEqual(last, tab)) return;
    list.push(tab);
    if (list.length > CLOSED_TAB_HISTORY_LIMIT) {
      list.splice(0, list.length - CLOSED_TAB_HISTORY_LIMIT);
    }
    s.closedTabsByWorkspace[wsId] = list;
  }

  /// Reconstruct an ActiveItem from a kind string + id (post-snapshot
  /// restore). For files we need the path too; we look it up by id in
  /// the freshly-restored file list.
  function buildActiveItem(
    kind: string,
    id: string,
    files: OpenFileTab[],
  ): ActiveItem | null {
    switch (kind) {
      case "file": {
        const f = files.find((f) => f.id === id);
        return f ? { type: "file", id, path: f.path } : null;
      }
      case "terminal": return { type: "terminal", id };
      case "diff": return { type: "diff", id };
      case "compare": return { type: "compare", id };
      case "stack": return { type: "stack", id };
      default: return null;
    }
  }

  function unpin(s: AppStoreState, wsId: string, tabId: string) {
    const arr = s.pinnedTabsByWorkspace[wsId];
    if (!arr) return;
    const idx = arr.indexOf(tabId);
    if (idx !== -1) arr.splice(idx, 1);
  }

  const actions = {
    // ── Workspaces ──────────────────────────────────────────────────────
    addWorkspace(name?: string) {
      const count = state.workspaces.length + 1;
      const ws = makeWorkspace(name ?? `Workspace ${count}`);
      setState(produce((s) => {
        s.workspaces.push(ws);
        s.terminalsByWorkspace[ws.id] = [];
        s.diffTabsByWorkspace[ws.id] = [];
        s.openFilesByWorkspace[ws.id] = [];
        s.compareTabsByWorkspace[ws.id] = [];
        s.stackTabsByWorkspace[ws.id] = [];
        s.conflictTabsByWorkspace[ws.id] = [];
        s.closedTabsByWorkspace[ws.id] = [];
        s.pinnedTabsByWorkspace[ws.id] = [];
        s.activeItemByWorkspace[ws.id] = null;
        s.activeWorkspaceId = ws.id;
      }));
      return ws.id;
    },

    removeWorkspace(id: string) {
      const terms = state.terminalsByWorkspace[id] ?? [];
      for (const t of terms) void terminalApi.closePty(t.ptyId).catch(() => {});
      setState(produce((s) => {
        s.workspaces = s.workspaces.filter((w) => w.id !== id);
        delete s.terminalsByWorkspace[id];
        delete s.diffTabsByWorkspace[id];
        delete s.openFilesByWorkspace[id];
        delete s.compareTabsByWorkspace[id];
        delete s.stackTabsByWorkspace[id];
        delete s.conflictTabsByWorkspace[id];
        delete s.closedTabsByWorkspace[id];
        delete s.pinnedTabsByWorkspace[id];
        delete s.activeItemByWorkspace[id];
        if (s.workspaces.length === 0) {
          const fresh = makeWorkspace("Main");
          s.workspaces.push(fresh);
          s.terminalsByWorkspace[fresh.id] = [];
          s.diffTabsByWorkspace[fresh.id] = [];
          s.openFilesByWorkspace[fresh.id] = [];
          s.compareTabsByWorkspace[fresh.id] = [];
          s.stackTabsByWorkspace[fresh.id] = [];
          s.conflictTabsByWorkspace[fresh.id] = [];
          s.closedTabsByWorkspace[fresh.id] = [];
          s.pinnedTabsByWorkspace[fresh.id] = [];
          s.activeItemByWorkspace[fresh.id] = null;
          s.activeWorkspaceId = fresh.id;
        } else if (s.activeWorkspaceId === id) {
          s.activeWorkspaceId = s.workspaces[s.workspaces.length - 1].id;
        }
      }));
    },

    renameWorkspace(id: string, name: string) {
      setState("workspaces", (w) => w.id === id, "name", name.trim() || "Workspace");
    },

    selectWorkspace(id: string) {
      setState("activeWorkspaceId", id);
    },

    /// Drop the workspace `fromId` immediately before `toId`. If `toId` is
    /// `null`, drop at the end. No-op when the move would leave order
    /// unchanged. Used by drag-and-drop on the workspace tab bar.
    reorderWorkspace(fromId: string, toId: string | null) {
      setState(produce((s) => {
        const from = s.workspaces.findIndex((w) => w.id === fromId);
        if (from === -1) return;
        const [item] = s.workspaces.splice(from, 1);
        if (toId === null) {
          s.workspaces.push(item);
          return;
        }
        const to = s.workspaces.findIndex((w) => w.id === toId);
        if (to === -1) {
          s.workspaces.push(item);
          return;
        }
        s.workspaces.splice(to, 0, item);
      }));
    },

    setRepoRoot(id: string, repoRoot: string | null) {
      setState("workspaces", (w) => w.id === id, "repoRoot", repoRoot);
    },

    // ── Terminals ───────────────────────────────────────────────────────
    async spawnTerminal(wsId: string) {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws?.repoRoot) return null;
      const ptyId = await terminalApi.createPty(ws.repoRoot);
      const count = (state.terminalsByWorkspace[wsId]?.length ?? 0) + 1;
      const term: TerminalSession = {
        id: crypto.randomUUID(),
        ptyId,
        label: `Terminal ${count}`,
        cwd: ws.repoRoot,
      };
      setState(produce((s) => {
        s.terminalsByWorkspace[wsId] = [...(s.terminalsByWorkspace[wsId] ?? []), term];
        s.activeItemByWorkspace[wsId] = { type: "terminal", id: term.id };
      }));
      return term.id;
    },

    removeTerminal(wsId: string, termId: string) {
      const list = state.terminalsByWorkspace[wsId] ?? [];
      const term = list.find((t) => t.id === termId);
      if (term) void terminalApi.closePty(term.ptyId).catch(() => {});
      setState(produce((s) => {
        const arr = s.terminalsByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === termId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "terminal" && active.id === termId) {
          // fall back to another terminal, else a diff tab, else nothing
          const nextTerm = arr[arr.length - 1];
          const diffs = s.diffTabsByWorkspace[wsId] ?? [];
          s.activeItemByWorkspace[wsId] = nextTerm
            ? { type: "terminal", id: nextTerm.id }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : null;
        }
      }));
    },

    selectTerminal(wsId: string, termId: string) {
      setState("activeItemByWorkspace", wsId, { type: "terminal", id: termId });
    },

    // ── Diff tabs ───────────────────────────────────────────────────────
    openDiffTab(wsId: string, filePath: string) {
      const existing = (state.diffTabsByWorkspace[wsId] ?? []).find((d) => d.filePath === filePath);
      if (existing) {
        setState("activeItemByWorkspace", wsId, { type: "diff", id: existing.id });
        return existing.id;
      }
      const tab: DiffTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.diffTabsByWorkspace[wsId] = [...(s.diffTabsByWorkspace[wsId] ?? []), tab];
        s.activeItemByWorkspace[wsId] = { type: "diff", id: tab.id };
      }));
      return tab.id;
    },

    closeDiffTab(wsId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.diffTabsByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const closed = arr[idx];
        pushClosed(s, wsId, { type: "diff", filePath: closed.filePath });
        unpin(s, wsId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "diff" && active.id === tabId) {
          const nextDiff = arr[arr.length - 1];
          const terms = s.terminalsByWorkspace[wsId] ?? [];
          s.activeItemByWorkspace[wsId] = nextDiff
            ? { type: "diff", id: nextDiff.id }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectDiffTab(wsId: string, tabId: string) {
      setState("activeItemByWorkspace", wsId, { type: "diff", id: tabId });
    },

    // ── Compare tabs ────────────────────────────────────────────────────
    openCompareTab(
      wsId: string,
      opts?: { baseRef?: string; headRef?: string; useMergeBase?: boolean },
    ) {
      const tab: CompareTab = {
        id: crypto.randomUUID(),
        baseRef: opts?.baseRef ?? "",
        headRef: opts?.headRef ?? "",
        useMergeBase: opts?.useMergeBase ?? true,
        selectedFilePath: null,
        treeMode: "tree",
        treeFilter: "",
      };
      setState(
        produce((s) => {
          s.compareTabsByWorkspace[wsId] = [
            ...(s.compareTabsByWorkspace[wsId] ?? []),
            tab,
          ];
          s.activeItemByWorkspace[wsId] = { type: "compare", id: tab.id };
        }),
      );
      return tab.id;
    },

    closeCompareTab(wsId: string, tabId: string) {
      setState(
        produce((s) => {
          const arr = s.compareTabsByWorkspace[wsId] ?? [];
          const idx = arr.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const closed = arr[idx];
          pushClosed(s, wsId, {
            type: "compare",
            baseRef: closed.baseRef,
            headRef: closed.headRef,
            useMergeBase: closed.useMergeBase,
            selectedFilePath: closed.selectedFilePath,
            treeMode: closed.treeMode,
            treeFilter: closed.treeFilter,
          });
          unpin(s, wsId, tabId);
          arr.splice(idx, 1);
          const active = s.activeItemByWorkspace[wsId];
          if (active?.type === "compare" && active.id === tabId) {
            const nextCompare = arr[arr.length - 1];
            const diffs = s.diffTabsByWorkspace[wsId] ?? [];
            const terms = s.terminalsByWorkspace[wsId] ?? [];
            s.activeItemByWorkspace[wsId] = nextCompare
              ? { type: "compare", id: nextCompare.id }
              : diffs[0]
                ? { type: "diff", id: diffs[0].id }
                : terms[0]
                  ? { type: "terminal", id: terms[0].id }
                  : null;
          }
        }),
      );
    },

    selectCompareTab(wsId: string, tabId: string) {
      setState("activeItemByWorkspace", wsId, { type: "compare", id: tabId });
    },

    // ── Stack tabs ──────────────────────────────────────────────────────
    /// Open the stack tab for `{trunk, topBranch}` (focus if already open).
    /// Returns the tab id so callers can keep a handle if they want.
    openStackTab(wsId: string, opts: { trunk: string; topBranch: string }) {
      const existing = (state.stackTabsByWorkspace[wsId] ?? []).find(
        (t) => t.trunk === opts.trunk && t.topBranch === opts.topBranch,
      );
      if (existing) {
        setState("activeItemByWorkspace", wsId, { type: "stack", id: existing.id });
        return existing.id;
      }
      const tab: StackTab = {
        id: crypto.randomUUID(),
        trunk: opts.trunk,
        topBranch: opts.topBranch,
      };
      setState(
        produce((s) => {
          s.stackTabsByWorkspace[wsId] = [
            ...(s.stackTabsByWorkspace[wsId] ?? []),
            tab,
          ];
          s.activeItemByWorkspace[wsId] = { type: "stack", id: tab.id };
        }),
      );
      return tab.id;
    },

    closeStackTab(wsId: string, tabId: string) {
      setState(
        produce((s) => {
          const arr = s.stackTabsByWorkspace[wsId] ?? [];
          const idx = arr.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const closed = arr[idx];
          pushClosed(s, wsId, {
            type: "stack",
            trunk: closed.trunk,
            topBranch: closed.topBranch,
          });
          unpin(s, wsId, tabId);
          arr.splice(idx, 1);
          const active = s.activeItemByWorkspace[wsId];
          if (active?.type === "stack" && active.id === tabId) {
            const nextStack = arr[arr.length - 1];
            const compares = s.compareTabsByWorkspace[wsId] ?? [];
            const diffs = s.diffTabsByWorkspace[wsId] ?? [];
            const terms = s.terminalsByWorkspace[wsId] ?? [];
            s.activeItemByWorkspace[wsId] = nextStack
              ? { type: "stack", id: nextStack.id }
              : compares[0]
                ? { type: "compare", id: compares[0].id }
                : diffs[0]
                  ? { type: "diff", id: diffs[0].id }
                  : terms[0]
                    ? { type: "terminal", id: terms[0].id }
                    : null;
          }
        }),
      );
    },

    selectStackTab(wsId: string, tabId: string) {
      setState("activeItemByWorkspace", wsId, { type: "stack", id: tabId });
    },

    setCompareRefs(
      wsId: string,
      tabId: string,
      patch: { baseRef?: string; headRef?: string; useMergeBase?: boolean },
    ) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId);
          if (!tab) return;
          if (patch.baseRef !== undefined) tab.baseRef = patch.baseRef;
          if (patch.headRef !== undefined) tab.headRef = patch.headRef;
          if (patch.useMergeBase !== undefined) tab.useMergeBase = patch.useMergeBase;
          // Refs changed → drop selection so the new diff loads cleanly.
          if (patch.baseRef !== undefined || patch.headRef !== undefined) {
            tab.selectedFilePath = null;
          }
        }),
      );
    },

    setCompareSelectedFile(wsId: string, tabId: string, path: string | null) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.selectedFilePath = path;
        }),
      );
    },

    setCompareTreeMode(wsId: string, tabId: string, mode: CompareTreeMode) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.treeMode = mode;
        }),
      );
    },

    setCompareTreeFilter(wsId: string, tabId: string, filter: string) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.treeFilter = filter;
        }),
      );
    },

    // ── Git sidebar ─────────────────────────────────────────────────────
    toggleGitSidebar() {
      setState("gitSidebarCollapsed", (v) => !v);
    },
    toggleLeftSidebar() {
      setState("leftSidebarCollapsed", (v) => !v);
    },
    toggleSidebarsSwapped() {
      setState("sidebarsSwapped", (v) => !v);
    },
    setGitTab(tab: GitTab) {
      setState("gitTab", tab);
    },
    setDiffMode(mode: DiffMode) {
      setState("diffMode", mode);
    },
    toggleIgnoreWhitespace() {
      setState("ignoreWhitespace", (v) => !v);
    },

    // ── File tabs ────────────────────────────────────────────────────────
    openFileTab(wsId: string, path: string) {
      const existing = (state.openFilesByWorkspace[wsId] ?? []).find((f) => f.path === path);
      if (existing) {
        setState("activeItemByWorkspace", wsId, { type: "file", id: existing.id, path });
        return existing.id;
      }
      const tab: OpenFileTab = { id: crypto.randomUUID(), path };
      setState(produce((s) => {
        s.openFilesByWorkspace[wsId] = [...(s.openFilesByWorkspace[wsId] ?? []), tab];
        s.activeItemByWorkspace[wsId] = { type: "file", id: tab.id, path };
      }));
      return tab.id;
    },

    closeFileTab(wsId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.openFilesByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const closed = arr[idx];
        pushClosed(s, wsId, { type: "file", path: closed.path });
        unpin(s, wsId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "file" && active.id === tabId) {
          const nextFile = arr[arr.length - 1];
          const diffs = s.diffTabsByWorkspace[wsId] ?? [];
          const terms = s.terminalsByWorkspace[wsId] ?? [];
          s.activeItemByWorkspace[wsId] = nextFile
            ? { type: "file", id: nextFile.id, path: nextFile.path }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : terms[0]
                ? { type: "terminal", id: terms[0].id }
                : null;
        }
      }));
    },

    selectFileTab(wsId: string, tabId: string, path: string) {
      setState("activeItemByWorkspace", wsId, { type: "file", id: tabId, path });
    },

    // ── Sidebar tab ──────────────────────────────────────────────────────
    setSidebarTab(tab: SidebarTab) {
      setState("sidebarTab", tab);
    },

    // ── Git collapsible sections ─────────────────────────────────────────
    toggleGitSection(section: keyof AppStoreState["gitSections"]) {
      setState("gitSections", section, (v) => !v);
    },

    // ── Left sidebar collapsible sections ────────────────────────────────
    toggleSidebarSection(section: keyof AppStoreState["sidebarSections"]) {
      setState("sidebarSections", section, (v) => !v);
    },

    // ── Reopen recently closed ───────────────────────────────────────────
    /// Pop the workspace's most-recent closed tab and recreate it. Returns
    /// `true` if anything was reopened. Terminals can't be reopened (the
    /// PTY is gone), so the LIFO never contains them. We reconstruct the
    /// tab inline rather than reusing `openXxxTab` actions because those
    /// trigger focus + dedupe behaviors we want here too (so just call
    /// them) — but we capture the popped value first to avoid losing it
    /// inside the produce.
    reopenLastClosedTab(wsId: string): ClosedTab | null {
      const list = state.closedTabsByWorkspace[wsId] ?? [];
      if (list.length === 0) return null;
      const popped = list[list.length - 1];
      setState(produce((s) => {
        s.closedTabsByWorkspace[wsId]?.pop();
      }));
      switch (popped.type) {
        case "file":
          actions.openFileTab(wsId, popped.path);
          break;
        case "diff":
          actions.openDiffTab(wsId, popped.filePath);
          break;
        case "compare": {
          const id = actions.openCompareTab(wsId, {
            baseRef: popped.baseRef,
            headRef: popped.headRef,
            useMergeBase: popped.useMergeBase,
          });
          setState(produce((s) => {
            const tab = s.compareTabsByWorkspace[wsId]?.find((t) => t.id === id);
            if (!tab || popped.type !== "compare") return;
            tab.selectedFilePath = popped.selectedFilePath;
            tab.treeMode = popped.treeMode;
            tab.treeFilter = popped.treeFilter;
          }));
          break;
        }
        case "stack":
          actions.openStackTab(wsId, { trunk: popped.trunk, topBranch: popped.topBranch });
          break;
      }
      return popped;
    },

    // ── Conflict tabs ────────────────────────────────────────────────────
    openConflictTab(wsId: string, filePath: string) {
      const existing = (state.conflictTabsByWorkspace[wsId] ?? []).find(
        (t) => t.filePath === filePath,
      );
      if (existing) {
        setState("activeItemByWorkspace", wsId, { type: "conflict", id: existing.id });
        return existing.id;
      }
      const tab: ConflictTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.conflictTabsByWorkspace[wsId] = [...(s.conflictTabsByWorkspace[wsId] ?? []), tab];
        s.activeItemByWorkspace[wsId] = { type: "conflict", id: tab.id };
      }));
      return tab.id;
    },

    closeConflictTab(wsId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.conflictTabsByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "conflict" && active.id === tabId) {
          const nextConflict = arr[arr.length - 1];
          s.activeItemByWorkspace[wsId] = nextConflict
            ? { type: "conflict", id: nextConflict.id }
            : null;
        }
      }));
    },

    selectConflictTab(wsId: string, tabId: string) {
      setState("activeItemByWorkspace", wsId, { type: "conflict", id: tabId });
    },

    // ── Workspace snapshots ──────────────────────────────────────────────
    /// Capture the current open-state of `wsId` into a named snapshot.
    /// Re-saving with the same name overwrites. Pinned/active are stored
    /// by content key so a future restore lands on the right tab even
    /// after IDs regenerate.
    saveWorkspaceSnapshot(wsId: string, name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const pinnedIds = new Set(state.pinnedTabsByWorkspace[wsId] ?? []);
      const active = state.activeItemByWorkspace[wsId];
      const files = state.openFilesByWorkspace[wsId] ?? [];
      const terminals = state.terminalsByWorkspace[wsId] ?? [];
      const diffs = state.diffTabsByWorkspace[wsId] ?? [];
      const compares = state.compareTabsByWorkspace[wsId] ?? [];
      const stacks = state.stackTabsByWorkspace[wsId] ?? [];

      const keyFor = (kind: string, ident: string) => `${kind}:${ident}`;
      const fileKey = (f: { path: string }) => keyFor("file", f.path);
      const termKey = (_t: TerminalSession, i: number) => keyFor("terminal", String(i));
      const diffKey = (d: DiffTab) => keyFor("diff", d.filePath);
      const compareKey = (c: CompareTab) => keyFor("compare", `${c.baseRef}..${c.headRef}`);
      const stackKey = (s: StackTab) => keyFor("stack", s.topBranch);

      const activeKey: string | null = active
        ? active.type === "file"
          ? fileKey({ path: active.path })
          : active.type === "terminal"
            ? (() => {
                const idx = terminals.findIndex((t) => t.id === active.id);
                return idx === -1 ? null : termKey(terminals[idx], idx);
              })()
            : active.type === "diff"
              ? (() => {
                  const d = diffs.find((d) => d.id === active.id);
                  return d ? diffKey(d) : null;
                })()
              : active.type === "compare"
                ? (() => {
                    const c = compares.find((c) => c.id === active.id);
                    return c ? compareKey(c) : null;
                  })()
                : (() => {
                    const s = stacks.find((s) => s.id === active.id);
                    return s ? stackKey(s) : null;
                  })()
        : null;

      const pinned: string[] = [];
      for (const f of files) if (pinnedIds.has(f.id)) pinned.push(fileKey(f));
      for (const d of diffs) if (pinnedIds.has(d.id)) pinned.push(diffKey(d));
      for (const c of compares) if (pinnedIds.has(c.id)) pinned.push(compareKey(c));
      for (const s of stacks) if (pinnedIds.has(s.id)) pinned.push(stackKey(s));

      const snap: WorkspaceSnapshot = {
        name: trimmed,
        savedAt: Date.now(),
        files: files.map((f) => f.path),
        terminals: terminals.map((t) => ({ label: t.label, cwd: t.cwd })),
        diffs: diffs.map((d) => d.filePath),
        compares: compares.map((c) => ({
          baseRef: c.baseRef,
          headRef: c.headRef,
          useMergeBase: c.useMergeBase,
          selectedFilePath: c.selectedFilePath,
          treeMode: c.treeMode,
          treeFilter: c.treeFilter,
        })),
        stacks: stacks.map((s) => ({ trunk: s.trunk, topBranch: s.topBranch })),
        active: activeKey,
        pinned,
        ui: {
          gitSidebarCollapsed: state.gitSidebarCollapsed,
          leftSidebarCollapsed: state.leftSidebarCollapsed,
          sidebarsSwapped: state.sidebarsSwapped,
          diffMode: state.diffMode,
          gitTab: state.gitTab,
          ignoreWhitespace: state.ignoreWhitespace,
          sidebarTab: state.sidebarTab,
        },
      };
      upsertSnapshot(wsId, snap);
    },

    /// Replace the workspace's open-state with the snapshot named `name`.
    /// Closes existing tabs *without* pushing them to the reopen-LIFO so
    /// restores don't pollute Cmd+Shift+T history. Returns true on hit.
    async restoreWorkspaceSnapshot(wsId: string, name: string): Promise<boolean> {
      const list = snapshotsFor(wsId);
      const snap = list.find((s) => s.name === name);
      if (!snap) return false;

      // Wipe tabs without affecting closed-tab history / pins.
      const terms = state.terminalsByWorkspace[wsId] ?? [];
      for (const t of terms) {
        void terminalApi.closePty(t.ptyId).catch(() => {});
      }
      setState(produce((s) => {
        s.openFilesByWorkspace[wsId] = [];
        s.terminalsByWorkspace[wsId] = [];
        s.diffTabsByWorkspace[wsId] = [];
        s.compareTabsByWorkspace[wsId] = [];
        s.stackTabsByWorkspace[wsId] = [];
        s.pinnedTabsByWorkspace[wsId] = [];
        s.activeItemByWorkspace[wsId] = null;
      }));

      // Restore UI prefs (these are app-global today but snapshot was
      // taken with these values active — applying them keeps the experience
      // coherent with the saved layout).
      setState({
        gitSidebarCollapsed: snap.ui.gitSidebarCollapsed,
        leftSidebarCollapsed: snap.ui.leftSidebarCollapsed,
        sidebarsSwapped: snap.ui.sidebarsSwapped,
        diffMode: snap.ui.diffMode,
        gitTab: snap.ui.gitTab,
        ignoreWhitespace: snap.ui.ignoreWhitespace,
        sidebarTab: snap.ui.sidebarTab,
      });

      // Track new IDs by content key so we can re-pin and re-activate.
      const idByKey = new Map<string, string>();

      const fileIds: string[] = [];
      setState(produce((s) => {
        for (const path of snap.files) {
          const tab: OpenFileTab = { id: crypto.randomUUID(), path };
          s.openFilesByWorkspace[wsId].push(tab);
          fileIds.push(tab.id);
          idByKey.set(`file:${path}`, tab.id);
        }
      }));

      const diffIds: string[] = [];
      setState(produce((s) => {
        for (const filePath of snap.diffs) {
          const tab: DiffTab = { id: crypto.randomUUID(), filePath };
          s.diffTabsByWorkspace[wsId].push(tab);
          diffIds.push(tab.id);
          idByKey.set(`diff:${filePath}`, tab.id);
        }
      }));

      setState(produce((s) => {
        for (const c of snap.compares) {
          const tab: CompareTab = {
            id: crypto.randomUUID(),
            baseRef: c.baseRef,
            headRef: c.headRef,
            useMergeBase: c.useMergeBase,
            selectedFilePath: c.selectedFilePath,
            treeMode: c.treeMode,
            treeFilter: c.treeFilter,
          };
          s.compareTabsByWorkspace[wsId].push(tab);
          idByKey.set(`compare:${c.baseRef}..${c.headRef}`, tab.id);
        }
      }));

      setState(produce((s) => {
        for (const st of snap.stacks) {
          const tab: StackTab = {
            id: crypto.randomUUID(),
            trunk: st.trunk,
            topBranch: st.topBranch,
          };
          s.stackTabsByWorkspace[wsId].push(tab);
          idByKey.set(`stack:${st.topBranch}`, tab.id);
        }
      }));

      // Terminals come last because the spawn is async. We don't await
      // each spawn individually — the UI surface is already responsive
      // for everything else, and a failed PTY spawn just leaves an
      // unrestored terminal slot.
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (ws?.repoRoot) {
        for (let i = 0; i < snap.terminals.length; i++) {
          const t = snap.terminals[i];
          try {
            // Note: we don't have a per-cwd spawn API; the existing
            // spawnTerminal uses the workspace's repoRoot. Honoring
            // arbitrary cwds would need a backend change — for now we
            // capture the cwd in the label so the user knows the intent.
            const ptyId = await terminalApi.createPty(ws.repoRoot);
            setState(produce((s) => {
              const term: TerminalSession = {
                id: crypto.randomUUID(),
                ptyId,
                label: t.label,
                cwd: t.cwd,
              };
              s.terminalsByWorkspace[wsId].push(term);
              idByKey.set(`terminal:${i}`, term.id);
            }));
          } catch {
            // Skip silently — the workspace still has other tabs.
          }
        }
      }

      // Re-pin by content key.
      const newPinned = snap.pinned
        .map((key) => idByKey.get(key))
        .filter((id): id is string => !!id);
      setState("pinnedTabsByWorkspace", wsId, newPinned);

      // Re-activate by content key. If the original active tab didn't
      // round-trip (deleted file / removed branch), default to the
      // first restored tab in render order.
      const activeId = snap.active ? idByKey.get(snap.active) : null;
      if (activeId) {
        // Determine kind from the key prefix.
        const kind = snap.active!.split(":")[0];
        setState(
          "activeItemByWorkspace",
          wsId,
          buildActiveItem(kind, activeId, state.openFilesByWorkspace[wsId] ?? []),
        );
      } else {
        // Fall back to the first available tab.
        const firstFile = state.openFilesByWorkspace[wsId]?.[0];
        const firstTerm = state.terminalsByWorkspace[wsId]?.[0];
        const firstDiff = state.diffTabsByWorkspace[wsId]?.[0];
        const firstCompare = state.compareTabsByWorkspace[wsId]?.[0];
        const firstStack = state.stackTabsByWorkspace[wsId]?.[0];
        const fallback: ActiveItem | null = firstFile
          ? { type: "file", id: firstFile.id, path: firstFile.path }
          : firstTerm
            ? { type: "terminal", id: firstTerm.id }
            : firstDiff
              ? { type: "diff", id: firstDiff.id }
              : firstCompare
                ? { type: "compare", id: firstCompare.id }
                : firstStack
                  ? { type: "stack", id: firstStack.id }
                  : null;
        setState("activeItemByWorkspace", wsId, fallback);
      }

      return true;
    },

    // ── Tab pinning ──────────────────────────────────────────────────────
    togglePinTab(wsId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.pinnedTabsByWorkspace[wsId] ?? (s.pinnedTabsByWorkspace[wsId] = []);
        const idx = arr.indexOf(tabId);
        if (idx === -1) arr.push(tabId);
        else arr.splice(idx, 1);
      }));
    },

    isTabPinned(wsId: string, tabId: string): boolean {
      return (state.pinnedTabsByWorkspace[wsId] ?? []).includes(tabId);
    },

    // ── Item tab reordering ──────────────────────────────────────────────
    /// Reorder a tab inside one of the per-workspace lists. `kind` selects
    /// which list (file/terminal/diff/compare/stack); `fromId` is the moved
    /// item; `toId === null` drops at the end. Drag-and-drop on the unified
    /// tab bar in MainSurface routes through this single action so all tab
    /// types stay consistent.
    reorderItemTab(
      wsId: string,
      kind: "file" | "terminal" | "diff" | "compare" | "stack",
      fromId: string,
      toId: string | null,
    ) {
      const key: keyof AppStoreState =
        kind === "file"
          ? "openFilesByWorkspace"
          : kind === "terminal"
            ? "terminalsByWorkspace"
            : kind === "diff"
              ? "diffTabsByWorkspace"
              : kind === "compare"
                ? "compareTabsByWorkspace"
                : "stackTabsByWorkspace";
      setState(produce((s) => {
        const arr = (s[key] as Record<string, { id: string }[]>)[wsId];
        if (!arr) return;
        const from = arr.findIndex((t) => t.id === fromId);
        if (from === -1) return;
        const [item] = arr.splice(from, 1);
        if (toId === null) {
          arr.push(item);
          return;
        }
        const to = arr.findIndex((t) => t.id === toId);
        if (to === -1) {
          arr.push(item);
          return;
        }
        arr.splice(to, 0, item);
      }));
    },
  };

  return {
    state,
    activeWorkspace,
    activeTerminals,
    activeDiffTabs,
    activeOpenFiles,
    activeCompareTabs,
    activeStackTabs,
    activeConflictTabs,
    activeItem,
    activeClosedTabs,
    activePinnedTabs,
    actions,
  } as const;
}

export type AppStore = ReturnType<typeof createAppStore>;
