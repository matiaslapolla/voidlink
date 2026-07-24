import { createStore, produce } from "solid-js/store";
import { createEffect, createMemo } from "solid-js";
import { terminalApi } from "@/api/terminal";
import {
  type PersistedWorkspace,
  type TerminalSession,
  type Workspace,
  makeWorkspace,
  makeWorktree,
} from "@/types/workspace";
import {
  type WorkspaceSnapshot,
  snapshotsFor,
  upsertSnapshot,
} from "@/commands/snapshots";
import { gitApi } from "@/api/git";
import { WORKSPACES_KEY, runLayoutMigration } from "@/store/migrate";

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
  | { type: "conflict"; id: string }
  | { type: "history"; id: string }
  | { type: "preview"; id: string; path: string }
  | { type: "brain"; id: string };

export interface ConflictTab {
  id: string;
  filePath: string;
}

/// A commit-graph tab. Repo-wide (the graph spans every branch), so it
/// carries no params beyond its id — one per workspace is enough.
export interface HistoryTab {
  id: string;
}

export interface PreviewTab {
  id: string;
  filePath: string;
}

/// A Brain (second-brain vault browser) tab. Reads a single vault path from
/// settings, not per-tab state, so — like HistoryTab — one per workspace is
/// all we ever need.
export interface BrainTab {
  id: string;
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
  /// The worktree every `*ByWorktree` collection below is currently read
  /// through. Denormalised from `activeWorkspace.activeWorktreeId` so the whole
  /// component tree can key off a single field; `selectWorkspace` /
  /// `selectWorktree` are the only writers and they keep both in step.
  activeWorktreeId: string;
  terminalsByWorktree: Record<string, TerminalSession[]>;
  diffTabsByWorktree: Record<string, DiffTab[]>;
  openFilesByWorktree: Record<string, OpenFileTab[]>;
  compareTabsByWorktree: Record<string, CompareTab[]>;
  stackTabsByWorktree: Record<string, StackTab[]>;
  conflictTabsByWorktree: Record<string, ConflictTab[]>;
  historyTabsByWorktree: Record<string, HistoryTab[]>;
  previewTabsByWorktree: Record<string, PreviewTab[]>;
  brainTabsByWorktree: Record<string, BrainTab[]>;
  /// LIFO stack of recently closed tabs, capped at CLOSED_TAB_HISTORY_LIMIT.
  /// Lives in memory only — closing the app drops the history (matches
  /// what most editors do with reopen-last-closed).
  closedTabsByWorktree: Record<string, ClosedTab[]>;
  /// Pinned tab IDs per worktree; pins survive close-all-others actions
  /// and render leftmost in the tab strip.
  pinnedTabsByWorktree: Record<string, string[]>;
  activeItemByWorktree: Record<string, ActiveItem | null>;
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  sidebarsSwapped: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: { changes: boolean; branches: boolean; worktrees: boolean; stack: boolean; stashes: boolean; history: boolean; openedDiffs: boolean };
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
  gitSections: { changes: boolean; branches: boolean; worktrees: boolean; stack: boolean; stashes: boolean; history: boolean; openedDiffs: boolean };
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
          worktrees: parsed.gitSections?.worktrees ?? false,
          stack: parsed.gitSections?.stack ?? true,
          stashes: parsed.gitSections?.stashes ?? false,
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
    gitSections: { changes: true, branches: true, worktrees: false, stack: true, stashes: false, history: true, openedDiffs: true },
    sidebarSections: { files: true, terminals: true },
  };
}

const COMPARE_TABS_KEY = "voidlink-compare-tabs";
const STACK_TABS_KEY = "voidlink-stack-tabs";
const PINNED_TABS_KEY = "voidlink-pinned-tabs";

/// Compare two absolute paths for "same directory". We can't call
/// `fs::canonicalize` from the frontend, so we normalise what we can see:
/// trailing slashes, duplicate separators, and macOS's `/private` prefix for
/// `/tmp` and `/var` (git reports the resolved form, our stored path may not).
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(p: string): string {
  return p
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .replace(/^\/private\/(tmp|var)\b/, "/$1");
}

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

function loadPinnedTabs(worktreeIds: string[]): Record<string, string[]> {
  const empty = Object.fromEntries(worktreeIds.map((id) => [id, [] as string[]]));
  try {
    const raw = localStorage.getItem(PINNED_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, string[]> = { ...empty };
    for (const wtId of worktreeIds) {
      const list = Array.isArray(parsed[wtId]) ? parsed[wtId] : [];
      out[wtId] = list.filter((id): id is string => typeof id === "string");
    }
    return out;
  } catch {
    return empty;
  }
}

function loadStackTabs(worktreeIds: string[]): Record<string, StackTab[]> {
  const empty = Object.fromEntries(worktreeIds.map((id) => [id, [] as StackTab[]]));
  try {
    const raw = localStorage.getItem(STACK_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, StackTab[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, StackTab[]> = { ...empty };
    for (const wtId of worktreeIds) {
      const list = Array.isArray(parsed[wtId]) ? parsed[wtId] : [];
      out[wtId] = list
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

function loadCompareTabs(worktreeIds: string[]): Record<string, CompareTab[]> {
  const empty = Object.fromEntries(worktreeIds.map((id) => [id, [] as CompareTab[]]));
  try {
    const raw = localStorage.getItem(COMPARE_TABS_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, CompareTab[]>;
    if (!parsed || typeof parsed !== "object") return empty;
    const out: Record<string, CompareTab[]> = { ...empty };
    for (const wtId of worktreeIds) {
      const list = Array.isArray(parsed[wtId]) ? parsed[wtId] : [];
      out[wtId] = list
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

/// Rebuild a runtime `Workspace` from its persisted form. Defensive about
/// every field because this is user-editable JSON on disk: a workspace with no
/// worktrees array (or an empty one) is repaired with a synthetic main worktree
/// rather than crashing the app on boot.
function reviveWorkspace(p: PersistedWorkspace): Workspace {
  const repoRoot = p.repoRoot ?? null;
  const worktrees = (Array.isArray(p.worktrees) ? p.worktrees : [])
    .filter((w) => w && typeof w.id === "string" && typeof w.path === "string")
    .map((w) =>
      makeWorktree({
        id: w.id,
        path: w.path,
        branch: typeof w.branch === "string" ? w.branch : null,
        isMain: !!w.isMain,
        isSynthetic: !!w.isSynthetic,
      }),
    );
  if (worktrees.length === 0) {
    worktrees.push(
      makeWorktree({ id: p.id, path: repoRoot ?? "", isMain: true, isSynthetic: true }),
    );
  }
  const activeWorktreeId = worktrees.some((w) => w.id === p.activeWorktreeId)
    ? p.activeWorktreeId
    : worktrees[0].id;
  return {
    id: p.id,
    name: p.name,
    repoRoot,
    worktrees,
    activeWorktreeId,
    isRepo: !!p.isRepo,
  };
}

function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  // Upgrade the on-disk shape before we read a byte of it. Idempotent and
  // gated on `voidlink-layout-version`, so this is a no-op on every boot after
  // the first — see `store/migrate.ts` for why the tab blobs need no re-keying.
  runLayoutMigration(localStorage);
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedWorkspace[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const workspaces = parsed.map(reviveWorkspace);
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
  // Every tab collection is keyed by worktree id, so the seed set is the union
  // of every workspace's worktrees — not one slot per workspace.
  const worktreeIds = workspaces.flatMap((w) => w.worktrees.map((wt) => wt.id));
  const emptyPerWorktree = <T,>() =>
    Object.fromEntries(worktreeIds.map((id) => [id, [] as T[]]));
  const activeWorkspaceOnLoad = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  const [state, setState] = createStore<AppStoreState>({
    workspaces,
    activeWorkspaceId: activeId,
    activeWorktreeId: activeWorkspaceOnLoad.activeWorktreeId,
    terminalsByWorktree: emptyPerWorktree<TerminalSession>(),
    diffTabsByWorktree: emptyPerWorktree<DiffTab>(),
    openFilesByWorktree: emptyPerWorktree<OpenFileTab>(),
    compareTabsByWorktree: loadCompareTabs(worktreeIds),
    stackTabsByWorktree: loadStackTabs(worktreeIds),
    conflictTabsByWorktree: emptyPerWorktree<ConflictTab>(),
    historyTabsByWorktree: emptyPerWorktree<HistoryTab>(),
    previewTabsByWorktree: emptyPerWorktree<PreviewTab>(),
    brainTabsByWorktree: emptyPerWorktree<BrainTab>(),
    closedTabsByWorktree: emptyPerWorktree<ClosedTab>(),
    pinnedTabsByWorktree: loadPinnedTabs(worktreeIds),
    activeItemByWorktree: Object.fromEntries(worktreeIds.map((id) => [id, null])),
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
      worktrees: w.worktrees.map((wt) => ({
        id: wt.id,
        path: wt.path,
        branch: wt.branch,
        isMain: wt.isMain,
        isSynthetic: wt.isSynthetic,
      })),
      activeWorktreeId: w.activeWorktreeId,
      isRepo: w.isRepo,
    }));
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(serialized));
    localStorage.setItem(ACTIVE_WS_KEY, state.activeWorkspaceId);
  });

  createEffect(() => {
    localStorage.setItem(
      COMPARE_TABS_KEY,
      JSON.stringify(state.compareTabsByWorktree),
    );
  });

  createEffect(() => {
    localStorage.setItem(
      STACK_TABS_KEY,
      JSON.stringify(state.stackTabsByWorktree),
    );
  });

  createEffect(() => {
    localStorage.setItem(
      PINNED_TABS_KEY,
      JSON.stringify(state.pinnedTabsByWorktree),
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
  /// The worktree every tab collection is scoped to right now.
  const activeWorktree = createMemo(
    () =>
      activeWorkspace()?.worktrees.find((wt) => wt.id === state.activeWorktreeId) ?? null,
  );
  /// The filesystem path repo-scoped panes (file tree, git sidebar, blame,
  /// compare, terminals) should operate on. This is the *worktree's* directory,
  /// not the workspace's repo root — that difference is the whole point of the
  /// two-level model.
  const activeRepoPath = createMemo(() => {
    const path = activeWorktree()?.path ?? "";
    return path.length > 0 ? path : null;
  });
  const activeTerminals = createMemo(
    () => state.terminalsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeDiffTabs = createMemo(
    () => state.diffTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeOpenFiles = createMemo(
    () => state.openFilesByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeCompareTabs = createMemo(
    () => state.compareTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeStackTabs = createMemo(
    () => state.stackTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeConflictTabs = createMemo(
    () => state.conflictTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeHistoryTabs = createMemo(
    () => state.historyTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activePreviewTabs = createMemo(
    () => state.previewTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeBrainTabs = createMemo(
    () => state.brainTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activeItem = createMemo(
    () => state.activeItemByWorktree[state.activeWorktreeId] ?? null,
  );
  const activeClosedTabs = createMemo(
    () => state.closedTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activePinnedTabs = createMemo(
    () => state.pinnedTabsByWorktree[state.activeWorktreeId] ?? [],
  );

  /// Create the (empty) tab collections a worktree needs. Called from every
  /// path that introduces a worktree id — workspace creation, wizard, and
  /// hydration — so no collection lookup ever has to invent a default.
  function seedWorktreeCollections(s: AppStoreState, wtId: string) {
    s.terminalsByWorktree[wtId] ??= [];
    s.diffTabsByWorktree[wtId] ??= [];
    s.openFilesByWorktree[wtId] ??= [];
    s.compareTabsByWorktree[wtId] ??= [];
    s.stackTabsByWorktree[wtId] ??= [];
    s.conflictTabsByWorktree[wtId] ??= [];
    s.historyTabsByWorktree[wtId] ??= [];
    s.previewTabsByWorktree[wtId] ??= [];
    s.brainTabsByWorktree[wtId] ??= [];
    s.closedTabsByWorktree[wtId] ??= [];
    s.pinnedTabsByWorktree[wtId] ??= [];
    if (!(wtId in s.activeItemByWorktree)) s.activeItemByWorktree[wtId] = null;
  }

  /// Drop everything keyed by a worktree id. The caller is responsible for
  /// killing that worktree's PTYs first — this only touches store state.
  function dropWorktreeCollections(s: AppStoreState, wtId: string) {
    delete s.terminalsByWorktree[wtId];
    delete s.diffTabsByWorktree[wtId];
    delete s.openFilesByWorktree[wtId];
    delete s.compareTabsByWorktree[wtId];
    delete s.stackTabsByWorktree[wtId];
    delete s.conflictTabsByWorktree[wtId];
    delete s.historyTabsByWorktree[wtId];
    delete s.previewTabsByWorktree[wtId];
    delete s.brainTabsByWorktree[wtId];
    delete s.closedTabsByWorktree[wtId];
    delete s.pinnedTabsByWorktree[wtId];
    delete s.activeItemByWorktree[wtId];
  }

  /// Find a worktree anywhere in the store by id, with its owning workspace.
  function locateWorktree(wtId: string) {
    for (const ws of state.workspaces) {
      const wt = ws.worktrees.find((w) => w.id === wtId);
      if (wt) return { workspace: ws, worktree: wt };
    }
    return null;
  }

  // Keep the previous default: a fresh workspace with one terminal focuses it.
  // Items are focused directly by their spawn/select actions below.

  /// Push `tab` to the workspace's closed-tab LIFO. Same snapshot present
  /// multiple times back-to-back collapses to a single entry so closing
  /// the same diff twice doesn't bury other recent closes.
  function pushClosed(s: AppStoreState, wtId: string, tab: ClosedTab) {
    const list = s.closedTabsByWorktree[wtId] ?? [];
    const last = list[list.length - 1];
    if (last && closedTabsEqual(last, tab)) return;
    list.push(tab);
    if (list.length > CLOSED_TAB_HISTORY_LIMIT) {
      list.splice(0, list.length - CLOSED_TAB_HISTORY_LIMIT);
    }
    s.closedTabsByWorktree[wtId] = list;
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

  function unpin(s: AppStoreState, wtId: string, tabId: string) {
    const arr = s.pinnedTabsByWorktree[wtId];
    if (!arr) return;
    const idx = arr.indexOf(tabId);
    if (idx !== -1) arr.splice(idx, 1);
  }

  const actions = {
    // ── Workspaces ──────────────────────────────────────────────────────
    addWorkspace(name?: string, repoRoot: string | null = null) {
      const count = state.workspaces.length + 1;
      const ws = makeWorkspace(name ?? `Workspace ${count}`, repoRoot);
      setState(produce((s) => {
        s.workspaces.push(ws);
        for (const wt of ws.worktrees) seedWorktreeCollections(s, wt.id);
        s.activeWorkspaceId = ws.id;
        s.activeWorktreeId = ws.activeWorktreeId;
      }));
      return ws.id;
    },

    removeWorkspace(id: string) {
      const ws = state.workspaces.find((w) => w.id === id);
      const worktreeIds = ws?.worktrees.map((wt) => wt.id) ?? [id];
      for (const wtId of worktreeIds) {
        for (const t of state.terminalsByWorktree[wtId] ?? []) {
          void terminalApi.closePty(t.ptyId).catch(() => {});
        }
      }
      setState(produce((s) => {
        s.workspaces = s.workspaces.filter((w) => w.id !== id);
        for (const wtId of worktreeIds) dropWorktreeCollections(s, wtId);
        if (s.workspaces.length === 0) {
          const fresh = makeWorkspace("Main");
          s.workspaces.push(fresh);
          for (const wt of fresh.worktrees) seedWorktreeCollections(s, wt.id);
          s.activeWorkspaceId = fresh.id;
          s.activeWorktreeId = fresh.activeWorktreeId;
        } else if (s.activeWorkspaceId === id) {
          const next = s.workspaces[s.workspaces.length - 1];
          s.activeWorkspaceId = next.id;
          s.activeWorktreeId = next.activeWorktreeId;
        }
      }));
    },

    renameWorkspace(id: string, name: string) {
      setState("workspaces", (w) => w.id === id, "name", name.trim() || "Workspace");
    },

    /// Switch workspaces, restoring whichever worktree that workspace was last
    /// looking at. Selecting a workspace never silently resets you to main.
    selectWorkspace(id: string) {
      const ws = state.workspaces.find((w) => w.id === id);
      if (!ws) return;
      setState(produce((s) => {
        s.activeWorkspaceId = id;
        s.activeWorktreeId = ws.activeWorktreeId;
      }));
    },

    // ── Worktrees ───────────────────────────────────────────────────────
    /// Make `wtId` the active worktree (switching workspaces if needed). The
    /// whole tab set swaps as a side effect because every collection is keyed
    /// by worktree id.
    selectWorktree(wtId: string) {
      const found = locateWorktree(wtId);
      if (!found) return;
      setState(produce((s) => {
        s.activeWorkspaceId = found.workspace.id;
        s.activeWorktreeId = wtId;
        const ws = s.workspaces.find((w) => w.id === found.workspace.id);
        if (ws) ws.activeWorktreeId = wtId;
        seedWorktreeCollections(s, wtId);
      }));
    },

    /// Register a worktree the wizard (or hydration) just discovered. Returns
    /// the worktree id. Matching is by path so re-adding an existing worktree
    /// updates it in place instead of orphaning its tabs.
    addWorktree(
      workspaceId: string,
      init: { path: string; branch: string | null; isMain?: boolean },
    ): string | null {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws) return null;
      const existing = ws.worktrees.find((wt) => samePath(wt.path, init.path));
      if (existing) {
        setState(
          "workspaces",
          (w) => w.id === workspaceId,
          "worktrees",
          (wt) => wt.id === existing.id,
          (wt) => ({ ...wt, branch: init.branch, isSynthetic: false }),
        );
        return existing.id;
      }
      const wt = makeWorktree({
        path: init.path,
        branch: init.branch,
        isMain: init.isMain ?? false,
      });
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        target.worktrees.push(wt);
        seedWorktreeCollections(s, wt.id);
      }));
      return wt.id;
    },

    /// Forget a worktree and everything open inside it. The main worktree is
    /// never removable — that is the workspace itself.
    removeWorktree(workspaceId: string, wtId: string) {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      const wt = ws?.worktrees.find((w) => w.id === wtId);
      if (!ws || !wt || wt.isMain) return;
      for (const t of state.terminalsByWorktree[wtId] ?? []) {
        void terminalApi.closePty(t.ptyId).catch(() => {});
      }
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        target.worktrees = target.worktrees.filter((w) => w.id !== wtId);
        dropWorktreeCollections(s, wtId);
        const fallback = target.worktrees.find((w) => w.isMain) ?? target.worktrees[0];
        if (!fallback) return;
        if (target.activeWorktreeId === wtId) target.activeWorktreeId = fallback.id;
        if (s.activeWorktreeId === wtId) s.activeWorktreeId = target.activeWorktreeId;
      }));
    },

    /// Reconcile a workspace's worktree list against `git worktree list`.
    /// Existing entries are matched by canonicalised path so their ids — and
    /// therefore their open tabs — survive. Entries git no longer reports are
    /// dropped, but only on a successful listing: a failed call means "not a
    /// repo (yet)" and leaves the synthetic worktree in place.
    async hydrateWorktrees(workspaceId: string): Promise<void> {
      const ws = state.workspaces.find((w) => w.id === workspaceId);
      if (!ws?.repoRoot) return;
      let listed;
      try {
        listed = await gitApi.listWorktrees(ws.repoRoot);
      } catch {
        setState("workspaces", (w) => w.id === workspaceId, "isRepo", false);
        return;
      }
      if (listed.length === 0) return;
      setState(produce((s) => {
        const target = s.workspaces.find((w) => w.id === workspaceId);
        if (!target) return;
        const keptIds = new Set<string>();
        const next: typeof target.worktrees = [];
        for (const info of listed) {
          const prior =
            target.worktrees.find((wt) => samePath(wt.path, info.path)) ??
            // The migrated/synthetic main worktree may still be pointing at the
            // repo root under a different spelling; adopt it for git's main
            // entry so its tabs come along.
            (info.isMain ? target.worktrees.find((wt) => wt.isMain) : undefined);
          const id = prior?.id ?? crypto.randomUUID();
          keptIds.add(id);
          next.push({
            id,
            path: info.path,
            branch: info.branch,
            isMain: info.isMain,
            isSynthetic: false,
            isDirty: info.isDirty,
            ahead: info.ahead,
            behind: info.behind,
            isLocked: info.isLocked,
            isDetached: info.isDetached,
          });
          seedWorktreeCollections(s, id);
        }
        for (const old of target.worktrees) {
          if (!keptIds.has(old.id)) dropWorktreeCollections(s, old.id);
        }
        target.worktrees = next;
        target.isRepo = true;
        if (!keptIds.has(target.activeWorktreeId)) {
          target.activeWorktreeId = (next.find((w) => w.isMain) ?? next[0]).id;
        }
        if (s.activeWorkspaceId === workspaceId) {
          s.activeWorktreeId = target.activeWorktreeId;
        }
      }));
      // PTYs belonging to worktrees git no longer knows about are already
      // orphaned by the state drop above; close them so we don't leak shells.
      for (const wtId of Object.keys(state.terminalsByWorktree)) {
        if (locateWorktree(wtId)) continue;
        for (const t of state.terminalsByWorktree[wtId] ?? []) {
          void terminalApi.closePty(t.ptyId).catch(() => {});
        }
      }
    },

    /// Hydrate every workspace that has a repo root. Fire-and-forget on boot.
    async hydrateAllWorktrees(): Promise<void> {
      await Promise.all(
        state.workspaces
          .filter((w) => !!w.repoRoot)
          .map((w) => actions.hydrateWorktrees(w.id)),
      );
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

    /// Point a workspace at a folder. The main worktree follows the root — it
    /// *is* the root — and we immediately try to read the real worktree list so
    /// picking a repo with linked worktrees populates the rail without a reload.
    setRepoRoot(id: string, repoRoot: string | null) {
      setState(produce((s) => {
        const ws = s.workspaces.find((w) => w.id === id);
        if (!ws) return;
        ws.repoRoot = repoRoot;
        ws.isRepo = false;
        const main = ws.worktrees.find((w) => w.isMain) ?? ws.worktrees[0];
        if (main) {
          main.path = repoRoot ?? "";
          main.branch = null;
          main.isSynthetic = true;
        }
      }));
      if (repoRoot) void actions.hydrateWorktrees(id);
    },

    // ── Terminals ───────────────────────────────────────────────────────
    /// Spawn a PTY rooted at the worktree's own directory — not the
    /// workspace's repo root — so a terminal in a linked worktree lands on
    /// that worktree's branch.
    async spawnTerminal(wtId: string) {
      const found = locateWorktree(wtId);
      const cwd = found?.worktree.path;
      if (!cwd) return null;
      const ptyId = await terminalApi.createPty(cwd);
      const count = (state.terminalsByWorktree[wtId]?.length ?? 0) + 1;
      const term: TerminalSession = {
        id: crypto.randomUUID(),
        ptyId,
        label: `Terminal ${count}`,
        cwd,
      };
      setState(produce((s) => {
        s.terminalsByWorktree[wtId] = [...(s.terminalsByWorktree[wtId] ?? []), term];
        s.activeItemByWorktree[wtId] = { type: "terminal", id: term.id };
      }));
      return term.id;
    },

    removeTerminal(wtId: string, termId: string) {
      const list = state.terminalsByWorktree[wtId] ?? [];
      const term = list.find((t) => t.id === termId);
      if (term) void terminalApi.closePty(term.ptyId).catch(() => {});
      setState(produce((s) => {
        const arr = s.terminalsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === termId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "terminal" && active.id === termId) {
          // fall back to another terminal, else a diff tab, else nothing
          const nextTerm = arr[arr.length - 1];
          const diffs = s.diffTabsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextTerm
            ? { type: "terminal", id: nextTerm.id }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : null;
        }
      }));
    },

    selectTerminal(wtId: string, termId: string) {
      setState("activeItemByWorktree", wtId, { type: "terminal", id: termId });
    },

    // ── Diff tabs ───────────────────────────────────────────────────────
    openDiffTab(wtId: string, filePath: string) {
      const existing = (state.diffTabsByWorktree[wtId] ?? []).find((d) => d.filePath === filePath);
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "diff", id: existing.id });
        return existing.id;
      }
      const tab: DiffTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.diffTabsByWorktree[wtId] = [...(s.diffTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "diff", id: tab.id };
      }));
      return tab.id;
    },

    closeDiffTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.diffTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const closed = arr[idx];
        pushClosed(s, wtId, { type: "diff", filePath: closed.filePath });
        unpin(s, wtId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "diff" && active.id === tabId) {
          const nextDiff = arr[arr.length - 1];
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextDiff
            ? { type: "diff", id: nextDiff.id }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectDiffTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "diff", id: tabId });
    },

    // ── Compare tabs ────────────────────────────────────────────────────
    openCompareTab(
      wtId: string,
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
          s.compareTabsByWorktree[wtId] = [
            ...(s.compareTabsByWorktree[wtId] ?? []),
            tab,
          ];
          s.activeItemByWorktree[wtId] = { type: "compare", id: tab.id };
        }),
      );
      return tab.id;
    },

    closeCompareTab(wtId: string, tabId: string) {
      setState(
        produce((s) => {
          const arr = s.compareTabsByWorktree[wtId] ?? [];
          const idx = arr.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const closed = arr[idx];
          pushClosed(s, wtId, {
            type: "compare",
            baseRef: closed.baseRef,
            headRef: closed.headRef,
            useMergeBase: closed.useMergeBase,
            selectedFilePath: closed.selectedFilePath,
            treeMode: closed.treeMode,
            treeFilter: closed.treeFilter,
          });
          unpin(s, wtId, tabId);
          arr.splice(idx, 1);
          const active = s.activeItemByWorktree[wtId];
          if (active?.type === "compare" && active.id === tabId) {
            const nextCompare = arr[arr.length - 1];
            const diffs = s.diffTabsByWorktree[wtId] ?? [];
            const terms = s.terminalsByWorktree[wtId] ?? [];
            s.activeItemByWorktree[wtId] = nextCompare
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

    selectCompareTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "compare", id: tabId });
    },

    // ── Stack tabs ──────────────────────────────────────────────────────
    /// Open the stack tab for `{trunk, topBranch}` (focus if already open).
    /// Returns the tab id so callers can keep a handle if they want.
    openStackTab(wtId: string, opts: { trunk: string; topBranch: string }) {
      const existing = (state.stackTabsByWorktree[wtId] ?? []).find(
        (t) => t.trunk === opts.trunk && t.topBranch === opts.topBranch,
      );
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "stack", id: existing.id });
        return existing.id;
      }
      const tab: StackTab = {
        id: crypto.randomUUID(),
        trunk: opts.trunk,
        topBranch: opts.topBranch,
      };
      setState(
        produce((s) => {
          s.stackTabsByWorktree[wtId] = [
            ...(s.stackTabsByWorktree[wtId] ?? []),
            tab,
          ];
          s.activeItemByWorktree[wtId] = { type: "stack", id: tab.id };
        }),
      );
      return tab.id;
    },

    closeStackTab(wtId: string, tabId: string) {
      setState(
        produce((s) => {
          const arr = s.stackTabsByWorktree[wtId] ?? [];
          const idx = arr.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          const closed = arr[idx];
          pushClosed(s, wtId, {
            type: "stack",
            trunk: closed.trunk,
            topBranch: closed.topBranch,
          });
          unpin(s, wtId, tabId);
          arr.splice(idx, 1);
          const active = s.activeItemByWorktree[wtId];
          if (active?.type === "stack" && active.id === tabId) {
            const nextStack = arr[arr.length - 1];
            const compares = s.compareTabsByWorktree[wtId] ?? [];
            const diffs = s.diffTabsByWorktree[wtId] ?? [];
            const terms = s.terminalsByWorktree[wtId] ?? [];
            s.activeItemByWorktree[wtId] = nextStack
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

    selectStackTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "stack", id: tabId });
    },

    setCompareRefs(
      wtId: string,
      tabId: string,
      patch: { baseRef?: string; headRef?: string; useMergeBase?: boolean },
    ) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
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

    setCompareSelectedFile(wtId: string, tabId: string, path: string | null) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.selectedFilePath = path;
        }),
      );
    },

    setCompareTreeMode(wtId: string, tabId: string, mode: CompareTreeMode) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.treeMode = mode;
        }),
      );
    },

    setCompareTreeFilter(wtId: string, tabId: string, filter: string) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
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
    openFileTab(wtId: string, path: string) {
      const existing = (state.openFilesByWorktree[wtId] ?? []).find((f) => f.path === path);
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "file", id: existing.id, path });
        return existing.id;
      }
      const tab: OpenFileTab = { id: crypto.randomUUID(), path };
      setState(produce((s) => {
        s.openFilesByWorktree[wtId] = [...(s.openFilesByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "file", id: tab.id, path };
      }));
      return tab.id;
    },

    closeFileTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.openFilesByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        const closed = arr[idx];
        pushClosed(s, wtId, { type: "file", path: closed.path });
        unpin(s, wtId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "file" && active.id === tabId) {
          const nextFile = arr[arr.length - 1];
          const diffs = s.diffTabsByWorktree[wtId] ?? [];
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextFile
            ? { type: "file", id: nextFile.id, path: nextFile.path }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : terms[0]
                ? { type: "terminal", id: terms[0].id }
                : null;
        }
      }));
    },

    selectFileTab(wtId: string, tabId: string, path: string) {
      setState("activeItemByWorktree", wtId, { type: "file", id: tabId, path });
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
    reopenLastClosedTab(wtId: string): ClosedTab | null {
      const list = state.closedTabsByWorktree[wtId] ?? [];
      if (list.length === 0) return null;
      const popped = list[list.length - 1];
      setState(produce((s) => {
        s.closedTabsByWorktree[wtId]?.pop();
      }));
      switch (popped.type) {
        case "file":
          actions.openFileTab(wtId, popped.path);
          break;
        case "diff":
          actions.openDiffTab(wtId, popped.filePath);
          break;
        case "compare": {
          const id = actions.openCompareTab(wtId, {
            baseRef: popped.baseRef,
            headRef: popped.headRef,
            useMergeBase: popped.useMergeBase,
          });
          setState(produce((s) => {
            const tab = s.compareTabsByWorktree[wtId]?.find((t) => t.id === id);
            if (!tab || popped.type !== "compare") return;
            tab.selectedFilePath = popped.selectedFilePath;
            tab.treeMode = popped.treeMode;
            tab.treeFilter = popped.treeFilter;
          }));
          break;
        }
        case "stack":
          actions.openStackTab(wtId, { trunk: popped.trunk, topBranch: popped.topBranch });
          break;
      }
      return popped;
    },

    // ── Conflict tabs ────────────────────────────────────────────────────
    openConflictTab(wtId: string, filePath: string) {
      const existing = (state.conflictTabsByWorktree[wtId] ?? []).find(
        (t) => t.filePath === filePath,
      );
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "conflict", id: existing.id });
        return existing.id;
      }
      const tab: ConflictTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.conflictTabsByWorktree[wtId] = [...(s.conflictTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "conflict", id: tab.id };
      }));
      return tab.id;
    },

    closeConflictTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.conflictTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "conflict" && active.id === tabId) {
          const nextConflict = arr[arr.length - 1];
          s.activeItemByWorktree[wtId] = nextConflict
            ? { type: "conflict", id: nextConflict.id }
            : null;
        }
      }));
    },

    selectConflictTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "conflict", id: tabId });
    },

    // ── History (commit graph) tab ───────────────────────────────────────
    /// Open the commit-graph tab for the workspace, focusing the existing
    /// one if present. The graph is repo-wide so a single tab per workspace
    /// is all we ever need.
    openHistoryTab(wtId: string) {
      const existing = (state.historyTabsByWorktree[wtId] ?? [])[0];
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "history", id: existing.id });
        return existing.id;
      }
      const tab: HistoryTab = { id: crypto.randomUUID() };
      setState(produce((s) => {
        s.historyTabsByWorktree[wtId] = [...(s.historyTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "history", id: tab.id };
      }));
      return tab.id;
    },

    closeHistoryTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.historyTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "history" && active.id === tabId) {
          const terms = s.terminalsByWorktree[wtId] ?? [];
          const files = s.openFilesByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = files[0]
            ? { type: "file", id: files[0].id, path: files[0].path }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectHistoryTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "history", id: tabId });
    },

    // ── Brain (second-brain vault browser) tab ──────────────────────────
    /// Open the Brain tab for the workspace, focusing the existing one if
    /// present. It reads from settings.brain.vaultPath, not per-tab state,
    /// so a single tab per workspace is all we ever need.
    openBrainTab(wtId: string) {
      const existing = (state.brainTabsByWorktree[wtId] ?? [])[0];
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "brain", id: existing.id });
        return existing.id;
      }
      const tab: BrainTab = { id: crypto.randomUUID() };
      setState(produce((s) => {
        s.brainTabsByWorktree[wtId] = [...(s.brainTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "brain", id: tab.id };
      }));
      return tab.id;
    },

    closeBrainTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.brainTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "brain" && active.id === tabId) {
          const terms = s.terminalsByWorktree[wtId] ?? [];
          const files = s.openFilesByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = files[0]
            ? { type: "file", id: files[0].id, path: files[0].path }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectBrainTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "brain", id: tabId });
    },

    // ── Preview tabs (markdown preview) ─────────────────────────────────
    openPreviewTab(wtId: string, filePath: string) {
      const existing = (state.previewTabsByWorktree[wtId] ?? []).find(
        (t) => t.filePath === filePath,
      );
      if (existing) {
        setState("activeItemByWorktree", wtId, {
          type: "preview",
          id: existing.id,
          path: filePath,
        });
        return existing.id;
      }
      const tab: PreviewTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.previewTabsByWorktree[wtId] = [
          ...(s.previewTabsByWorktree[wtId] ?? []),
          tab,
        ];
        s.activeItemByWorktree[wtId] = { type: "preview", id: tab.id, path: filePath };
      }));
      return tab.id;
    },

    closePreviewTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.previewTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        unpin(s, wtId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "preview" && active.id === tabId) {
          const nextPreview = arr[arr.length - 1];
          const files = s.openFilesByWorktree[wtId] ?? [];
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextPreview
            ? { type: "preview", id: nextPreview.id, path: nextPreview.filePath }
            : files[0]
              ? { type: "file", id: files[0].id, path: files[0].path }
              : terms[0]
                ? { type: "terminal", id: terms[0].id }
                : null;
        }
      }));
    },

    selectPreviewTab(wtId: string, tabId: string) {
      const tab = (state.previewTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
      if (!tab) return;
      setState("activeItemByWorktree", wtId, {
        type: "preview",
        id: tabId,
        path: tab.filePath,
      });
    },

    // ── Workspace snapshots ──────────────────────────────────────────────
    /// Capture the current open-state of `wtId` into a named snapshot.
    /// Re-saving with the same name overwrites. Pinned/active are stored
    /// by content key so a future restore lands on the right tab even
    /// after IDs regenerate.
    saveWorkspaceSnapshot(wtId: string, name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;
      const pinnedIds = new Set(state.pinnedTabsByWorktree[wtId] ?? []);
      const active = state.activeItemByWorktree[wtId];
      const files = state.openFilesByWorktree[wtId] ?? [];
      const terminals = state.terminalsByWorktree[wtId] ?? [];
      const diffs = state.diffTabsByWorktree[wtId] ?? [];
      const compares = state.compareTabsByWorktree[wtId] ?? [];
      const stacks = state.stackTabsByWorktree[wtId] ?? [];

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
      upsertSnapshot(wtId, snap);
    },

    /// Replace the workspace's open-state with the snapshot named `name`.
    /// Closes existing tabs *without* pushing them to the reopen-LIFO so
    /// restores don't pollute Cmd+Shift+T history. Returns true on hit.
    async restoreWorkspaceSnapshot(wtId: string, name: string): Promise<boolean> {
      const list = snapshotsFor(wtId);
      const snap = list.find((s) => s.name === name);
      if (!snap) return false;

      // Wipe tabs without affecting closed-tab history / pins.
      const terms = state.terminalsByWorktree[wtId] ?? [];
      for (const t of terms) {
        void terminalApi.closePty(t.ptyId).catch(() => {});
      }
      setState(produce((s) => {
        s.openFilesByWorktree[wtId] = [];
        s.terminalsByWorktree[wtId] = [];
        s.diffTabsByWorktree[wtId] = [];
        s.compareTabsByWorktree[wtId] = [];
        s.stackTabsByWorktree[wtId] = [];
        s.pinnedTabsByWorktree[wtId] = [];
        s.activeItemByWorktree[wtId] = null;
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
          s.openFilesByWorktree[wtId].push(tab);
          fileIds.push(tab.id);
          idByKey.set(`file:${path}`, tab.id);
        }
      }));

      const diffIds: string[] = [];
      setState(produce((s) => {
        for (const filePath of snap.diffs) {
          const tab: DiffTab = { id: crypto.randomUUID(), filePath };
          s.diffTabsByWorktree[wtId].push(tab);
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
          s.compareTabsByWorktree[wtId].push(tab);
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
          s.stackTabsByWorktree[wtId].push(tab);
          idByKey.set(`stack:${st.topBranch}`, tab.id);
        }
      }));

      // Terminals come last because the spawn is async. We don't await
      // each spawn individually — the UI surface is already responsive
      // for everything else, and a failed PTY spawn just leaves an
      // unrestored terminal slot.
      const cwd = locateWorktree(wtId)?.worktree.path;
      if (cwd) {
        for (let i = 0; i < snap.terminals.length; i++) {
          const t = snap.terminals[i];
          try {
            // The snapshot records each terminal's original cwd, but we spawn
            // in the worktree's directory: restoring a snapshot into a
            // *different* worktree must not resurrect shells pointing at the
            // old one. The recorded cwd stays on the session for context.
            const ptyId = await terminalApi.createPty(cwd);
            setState(produce((s) => {
              const term: TerminalSession = {
                id: crypto.randomUUID(),
                ptyId,
                label: t.label,
                cwd: t.cwd,
              };
              s.terminalsByWorktree[wtId].push(term);
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
      setState("pinnedTabsByWorktree", wtId, newPinned);

      // Re-activate by content key. If the original active tab didn't
      // round-trip (deleted file / removed branch), default to the
      // first restored tab in render order.
      const activeId = snap.active ? idByKey.get(snap.active) : null;
      if (activeId) {
        // Determine kind from the key prefix.
        const kind = snap.active!.split(":")[0];
        setState(
          "activeItemByWorktree",
          wtId,
          buildActiveItem(kind, activeId, state.openFilesByWorktree[wtId] ?? []),
        );
      } else {
        // Fall back to the first available tab.
        const firstFile = state.openFilesByWorktree[wtId]?.[0];
        const firstTerm = state.terminalsByWorktree[wtId]?.[0];
        const firstDiff = state.diffTabsByWorktree[wtId]?.[0];
        const firstCompare = state.compareTabsByWorktree[wtId]?.[0];
        const firstStack = state.stackTabsByWorktree[wtId]?.[0];
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
        setState("activeItemByWorktree", wtId, fallback);
      }

      return true;
    },

    // ── Tab pinning ──────────────────────────────────────────────────────
    togglePinTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.pinnedTabsByWorktree[wtId] ?? (s.pinnedTabsByWorktree[wtId] = []);
        const idx = arr.indexOf(tabId);
        if (idx === -1) arr.push(tabId);
        else arr.splice(idx, 1);
      }));
    },

    isTabPinned(wtId: string, tabId: string): boolean {
      return (state.pinnedTabsByWorktree[wtId] ?? []).includes(tabId);
    },

    // ── Item tab reordering ──────────────────────────────────────────────
    /// Reorder a tab inside one of the per-workspace lists. `kind` selects
    /// which list (file/terminal/diff/compare/stack); `fromId` is the moved
    /// item; `toId === null` drops at the end. Drag-and-drop on the unified
    /// tab bar in MainSurface routes through this single action so all tab
    /// types stay consistent.
    reorderItemTab(
      wtId: string,
      kind: "file" | "terminal" | "diff" | "compare" | "stack" | "preview",
      fromId: string,
      toId: string | null,
    ) {
      const key: keyof AppStoreState =
        kind === "file"
          ? "openFilesByWorktree"
          : kind === "terminal"
            ? "terminalsByWorktree"
            : kind === "diff"
              ? "diffTabsByWorktree"
              : kind === "compare"
                ? "compareTabsByWorktree"
                : kind === "stack"
                  ? "stackTabsByWorktree"
                  : "previewTabsByWorktree";
      setState(produce((s) => {
        const arr = (s[key] as Record<string, { id: string }[]>)[wtId];
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
    activeWorktree,
    activeRepoPath,
    activeTerminals,
    activeDiffTabs,
    activeOpenFiles,
    activeCompareTabs,
    activeStackTabs,
    activeConflictTabs,
    activeHistoryTabs,
    activePreviewTabs,
    activeBrainTabs,
    activeItem,
    activeClosedTabs,
    activePinnedTabs,
    actions,
  } as const;
}

export type AppStore = ReturnType<typeof createAppStore>;
