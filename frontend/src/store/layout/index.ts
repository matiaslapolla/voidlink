/// `createAppStore()` — the workbench's single source of truth, composed from
/// the four modules beside this one.
///
/// This file used to be 2049 lines holding ten parallel tab collections, eight
/// storage keys, every UI preference and every action. What is left here is the
/// composition and the tab actions themselves; `tabs.ts` owns what a tab kind
/// *is*, `persistence.ts` owns every `localStorage` touch, `prefs.ts` owns the
/// UI preferences and `workspaces.ts` owns the two-level workspace model.
///
/// The public surface — the object returned at the bottom, and every type
/// re-exported below — is unchanged, so `@/store/layout` keeps resolving for
/// all ~40 importers and `layout.test.ts` passes unmodified. That is the
/// decomposition's whole proof.
import { createStore, produce } from "solid-js/store";
import { createEffect, createMemo } from "solid-js";
import { terminalApi } from "@/api/terminal";
import { lastGridSize } from "@/commands/terminalSize";
import type { TerminalSession } from "@/types/workspace";
import {
  type WorkspaceSnapshot,
  snapshotsFor,
  upsertSnapshot,
} from "@/commands/snapshots";
import {
  STORAGE_KEYS,
  readJson,
  readRaw,
  writeJson,
} from "./persistence";
import { clampPanelWidth, loadPrefs, persistPrefs } from "./prefs";
import type { PanelId } from "./prefs";
import {
  groupList,
  groupOwning,
  moveTabToGroup,
  parsePaneLayouts,
  pruneClosedTabs,
  removeGroup,
  serializePaneLayout,
  setGroupActiveTab,
  setSplitRatios,
  singleGroupLayout,
  splitGroup,
  type SplitOrientation,
} from "./panes";
import {
  TAB_KINDS,
  TAB_SPECS,
  closedTabsEqual,
  deserializeTabRecord,
  isEditorKind,
  parseEditorTabs,
  serializeEditorTabs,
} from "./tabs";
import type {
  ActiveItem,
  BrainTab,
  BrowserTab,
  ClosedTab,
  CompareTab,
  CompareTreeMode,
  ConflictTab,
  DiffTab,
  HistoryTab,
  OpenFileTab,
  PreviewTab,
  StackTab,
  TabKind,
} from "./tabs";
import { type AppStoreState, CLOSED_TAB_HISTORY_LIMIT } from "./state";
import {
  createWorkspaceActions,
  loadWorkspaces,
  persistWorkspaces,
} from "./workspaces";

// ── Public surface re-exports ─────────────────────────────────────────────
// Everything `layout.ts` exported, from the same specifier. Consumers import
// `@/store/layout`; where a type physically lives is this directory's business.

export type {
  ActiveItem,
  BrainTab,
  BrowserTab,
  ClosedTab,
  CompareTab,
  CompareTreeMode,
  ConflictTab,
  DiffTab,
  HistoryTab,
  OpenFileTab,
  PersistedEditorTabs,
  PreviewTab,
  StackTab,
  TabKind,
  TabKindSpec,
} from "./tabs";
export { TAB_KINDS, TAB_SPECS, parseEditorTabs, samePath, serializeEditorTabs } from "./tabs";
export type { DiffMode, GitTab, PanelId, PanelWidths, SidebarTab, UiPrefs } from "./prefs";
export { PANEL_BOUNDS } from "./prefs";
export type { PaneGroup, PaneNode, SplitOrientation } from "./panes";
export {
  MAX_GROUPS,
  MIN_RATIO,
  canSplit,
  groupCount,
  groupList,
  groupOwning,
  resolveGroupTabs,
} from "./panes";
export type { AppStoreState } from "./state";
export { LAYOUT_STORAGE_KEYS, STORAGE_KEYS, flushWrites, resetLayoutStorage } from "./persistence";

export interface CreateAppStoreOptions {
  /// Whether this store writes its state back to localStorage.
  ///
  /// Exactly one window may persist. The workbench (`main`) does; the git
  /// window creates a store only because the panes it reuses call
  /// `useAppStore()`, and if it also persisted, the two windows would race on
  /// the same keys and the last writer would silently clobber the other's
  /// tabs. A non-persisting store still *hydrates* from localStorage, so the
  /// git window opens on the right workspace.
  persist?: boolean;
}

/// Load one kind's persisted collection through the registry. Kinds that share
/// the editor blob are loaded by `parseEditorTabs` instead, and memory-only
/// kinds come back empty.
function loadKindRecord<K extends TabKind>(
  kind: K,
  worktreeIds: string[],
): Record<string, unknown[]> {
  const spec = TAB_SPECS[kind];
  if (!spec.storage || spec.storage.field) {
    return Object.fromEntries(worktreeIds.map((id) => [id, [] as unknown[]]));
  }
  return deserializeTabRecord(kind, readJson(spec.storage.key, null), worktreeIds);
}

function loadPinnedTabs(worktreeIds: string[]): Record<string, string[]> {
  const empty = Object.fromEntries(worktreeIds.map((id) => [id, [] as string[]]));
  const parsed = readJson<Record<string, unknown> | null>(STORAGE_KEYS.pinnedTabs, null);
  if (!parsed || typeof parsed !== "object") return empty;
  const out: Record<string, string[]> = { ...empty };
  for (const wtId of worktreeIds) {
    const list = parsed[wtId];
    out[wtId] = Array.isArray(list)
      ? list.filter((id): id is string => typeof id === "string")
      : [];
  }
  return out;
}

export function createAppStore(options: CreateAppStoreOptions = {}) {
  const persist = options.persist ?? true;
  const { workspaces, activeId } = loadWorkspaces();
  const prefs = loadPrefs();
  // Every tab collection is keyed by worktree id, so the seed set is the union
  // of every workspace's worktrees — not one slot per workspace.
  const worktreeIds = workspaces.flatMap((w) => w.worktrees.map((wt) => wt.id));
  const emptyPerWorktree = <T,>() =>
    Object.fromEntries(worktreeIds.map((id) => [id, [] as T[]]));
  const activeWorkspaceOnLoad = workspaces.find((w) => w.id === activeId) ?? workspaces[0];
  const editorTabs = parseEditorTabs(readRaw(STORAGE_KEYS.editorTabs), worktreeIds);
  const [state, setState] = createStore<AppStoreState>({
    workspaces,
    activeWorkspaceId: activeId,
    activeWorktreeId: activeWorkspaceOnLoad.activeWorktreeId,
    terminalsByWorktree: emptyPerWorktree<TerminalSession>(),
    diffTabsByWorktree: editorTabs.diffs,
    openFilesByWorktree: editorTabs.files,
    compareTabsByWorktree: loadKindRecord("compare", worktreeIds) as Record<
      string,
      CompareTab[]
    >,
    stackTabsByWorktree: loadKindRecord("stack", worktreeIds) as Record<string, StackTab[]>,
    conflictTabsByWorktree: editorTabs.conflicts,
    historyTabsByWorktree: emptyPerWorktree<HistoryTab>(),
    previewTabsByWorktree: editorTabs.previews,
    brainTabsByWorktree: emptyPerWorktree<BrainTab>(),
    browserTabsByWorktree: loadKindRecord("browser", worktreeIds) as Record<
      string,
      BrowserTab[]
    >,
    closedTabsByWorktree: emptyPerWorktree<ClosedTab>(),
    pinnedTabsByWorktree: loadPinnedTabs(worktreeIds),
    activeItemByWorktree: Object.fromEntries(worktreeIds.map((id) => [id, null])),
    editorActiveItemByWorktree: editorTabs.active,
    paneLayoutByWorktree: parsePaneLayouts(
      readJson(STORAGE_KEYS.paneLayout, null),
      worktreeIds,
    ),
    focusedGroupByWorktree: Object.fromEntries(worktreeIds.map((id) => [id, null])),
    panels: prefs.panels,
    gitSidebarCollapsed: prefs.gitSidebarCollapsed,
    leftSidebarCollapsed: prefs.leftSidebarCollapsed,
    sidebarsSwapped: prefs.sidebarsSwapped,
    diffMode: prefs.diffMode,
    gitTab: prefs.gitTab,
    ignoreWhitespace: prefs.ignoreWhitespace,
    sidebarTab: prefs.sidebarTab,
    gitSections: prefs.gitSections,
    sidebarSections: prefs.sidebarSections,
  });

  createEffect(() => {
    if (!persist) return;
    persistWorkspaces(state.workspaces, state.activeWorkspaceId);
  });

  // One effect per kind that owns a key of its own, driven by the registry
  // rather than by three hand-written copies. Kinds that share the editor blob
  // are handled by the effect below; memory-only kinds write nothing.
  for (const kind of TAB_KINDS) {
    const spec = TAB_SPECS[kind];
    const storage = spec.storage;
    if (!storage || storage.field) continue;
    createEffect(() => {
      if (!persist) return;
      const record = state[spec.stateKey] as Record<string, { id: string }[]>;
      const out: Record<string, unknown[]> = {};
      for (const [wtId, list] of Object.entries(record)) {
        out[wtId] = list.map((t) =>
          (spec.serialize as (tab: { id: string }) => unknown)(t),
        );
      }
      writeJson(storage.key, out);
    });
  }

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.pinnedTabs, state.pinnedTabsByWorktree);
  });

  createEffect(() => {
    if (!persist) return;
    const out: Record<string, unknown> = {};
    for (const [wtId, layout] of Object.entries(state.paneLayoutByWorktree)) {
      out[wtId] = serializePaneLayout(layout);
    }
    writeJson(STORAGE_KEYS.paneLayout, out);
  });

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.editorTabs, serializeEditorTabs(state));
  });

  createEffect(() => {
    if (!persist) return;
    persistPrefs({
      panels: state.panels,
      gitSidebarCollapsed: state.gitSidebarCollapsed,
      leftSidebarCollapsed: state.leftSidebarCollapsed,
      sidebarsSwapped: state.sidebarsSwapped,
      diffMode: state.diffMode,
      gitTab: state.gitTab,
      ignoreWhitespace: state.ignoreWhitespace,
      sidebarTab: state.sidebarTab,
      gitSections: state.gitSections,
      sidebarSections: state.sidebarSections,
    });
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

  /// The ten `active*Tabs` memos, generated from the registry. Adding a kind
  /// used to mean writing an eleventh by hand; now the spec entry is enough.
  const activeOf = <T,>(kind: TabKind) =>
    createMemo(
      () =>
        (state[TAB_SPECS[kind].stateKey] as Record<string, T[]>)[state.activeWorktreeId] ?? [],
    );

  const activeTerminals = activeOf<TerminalSession>("terminal");
  const activeDiffTabs = activeOf<DiffTab>("diff");
  const activeOpenFiles = activeOf<OpenFileTab>("file");
  const activeCompareTabs = activeOf<CompareTab>("compare");
  const activeStackTabs = activeOf<StackTab>("stack");
  const activeConflictTabs = activeOf<ConflictTab>("conflict");
  const activeHistoryTabs = activeOf<HistoryTab>("history");
  const activePreviewTabs = activeOf<PreviewTab>("preview");
  const activeBrainTabs = activeOf<BrainTab>("brain");
  const activeBrowserTabs = activeOf<BrowserTab>("browser");

  /// Every workbench tab id for the active worktree, in strip order. The pane
  /// tree stores claims by id, so this is what turns those claims into content
  /// — and what tells the tree which claims have gone stale.
  ///
  /// Workbench kinds only: the editor window's four kinds live in a different
  /// window with its own pointer, and a pane group here can never show one.
  const workbenchTabIds = createMemo(() => [
    ...activeTerminals().map((t) => t.id),
    ...activeCompareTabs().map((t) => t.id),
    ...activeStackTabs().map((t) => t.id),
    ...activeHistoryTabs().map((t) => t.id),
    ...activeBrainTabs().map((t) => t.id),
    ...activeBrowserTabs().map((t) => t.id),
  ]);

  /// The active worktree's split tree, defaulted rather than `undefined` so no
  /// render path has to branch on "no geometry yet".
  const paneLayout = createMemo(
    () => state.paneLayoutByWorktree[state.activeWorktreeId] ?? singleGroupLayout(),
  );

  /// The focused group, resolved. A stale id (its group was collapsed) falls
  /// back to the first group rather than leaving keyboard focus nowhere.
  const focusedGroupId = createMemo(() => {
    const groups = groupList(paneLayout());
    const stored = state.focusedGroupByWorktree[state.activeWorktreeId] ?? null;
    return groups.some((g) => g.id === stored) ? stored! : (groups[0]?.id ?? null);
  });

  /// Closing the last tab in a group collapses it, and a claim on a tab that no
  /// longer exists is dropped. Both are structural, so they run here rather
  /// than in each of the six per-kind close actions.
  ///
  /// The stringify guard is what makes this terminate: `pruneClosedTabs`
  /// rebuilds split nodes unconditionally, so writing its result back
  /// unconditionally would retrigger this effect forever.
  createEffect(() => {
    const wtId = state.activeWorktreeId;
    const current = state.paneLayoutByWorktree[wtId];
    if (!current) return;
    const next = pruneClosedTabs(current, workbenchTabIds());
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      setState("paneLayoutByWorktree", wtId, next);
    }
  });

  const activeItem = createMemo(
    () => state.activeItemByWorktree[state.activeWorktreeId] ?? null,
  );
  /// The editor window's front tab for the active worktree. Broadcast to that
  /// window rather than read by any pane here.
  const editorActiveItem = createMemo(
    () => state.editorActiveItemByWorktree[state.activeWorktreeId] ?? null,
  );
  const activeClosedTabs = createMemo(
    () => state.closedTabsByWorktree[state.activeWorktreeId] ?? [],
  );
  const activePinnedTabs = createMemo(
    () => state.pinnedTabsByWorktree[state.activeWorktreeId] ?? [],
  );

  /// Find a worktree anywhere in the store by id, with its owning workspace.
  function locateWorktree(wtId: string) {
    for (const ws of state.workspaces) {
      const wt = ws.worktrees.find((w) => w.id === wtId);
      if (wt) return { workspace: ws, worktree: wt };
    }
    return null;
  }

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

  const workspaceActions = createWorkspaceActions({ state, setState, locateWorktree });

  const actions = {
    ...workspaceActions,

    // ── Terminals ───────────────────────────────────────────────────────
    /// Spawn a PTY rooted at the worktree's own directory — not the
    /// workspace's repo root — so a terminal in a linked worktree lands on
    /// that worktree's branch.
    async spawnTerminal(wtId: string) {
      const found = locateWorktree(wtId);
      const cwd = found?.worktree.path;
      if (!cwd) return null;
      const ptyId = await terminalApi.createPty(cwd, lastGridSize() ?? undefined);
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

    /// Look up a spawned terminal session by id. Callers that need the raw
    /// `ptyId` — e.g. to write a command into a terminal they just opened —
    /// go through this rather than reaching into the state record.
    findTerminal(wtId: string, termId: string): TerminalSession | null {
      return (state.terminalsByWorktree[wtId] ?? []).find((t) => t.id === termId) ?? null;
    },

    selectTerminal(wtId: string, termId: string) {
      setState("activeItemByWorktree", wtId, { type: "terminal", id: termId });
    },

    // ── Diff tabs ───────────────────────────────────────────────────────
    openDiffTab(wtId: string, filePath: string) {
      const existing = (state.diffTabsByWorktree[wtId] ?? []).find((d) => d.filePath === filePath);
      if (existing) {
        setState("editorActiveItemByWorktree", wtId, { type: "diff", id: existing.id });
        return existing.id;
      }
      const tab: DiffTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.diffTabsByWorktree[wtId] = [...(s.diffTabsByWorktree[wtId] ?? []), tab];
        s.editorActiveItemByWorktree[wtId] = { type: "diff", id: tab.id };
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
        const active = s.editorActiveItemByWorktree[wtId];
        if (active?.type === "diff" && active.id === tabId) {
          // Fall back within the editor window's own kinds — a terminal is not
          // something this window can show.
          const nextDiff = arr[arr.length - 1];
          const files = s.openFilesByWorktree[wtId] ?? [];
          s.editorActiveItemByWorktree[wtId] = nextDiff
            ? { type: "diff", id: nextDiff.id }
            : files[0]
              ? { type: "file", id: files[0].id, path: files[0].path }
              : null;
        }
      }));
    },

    selectDiffTab(wtId: string, tabId: string) {
      setState("editorActiveItemByWorktree", wtId, { type: "diff", id: tabId });
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
            const terms = s.terminalsByWorktree[wtId] ?? [];
            s.activeItemByWorktree[wtId] = nextCompare
              ? { type: "compare", id: nextCompare.id }
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
            const terms = s.terminalsByWorktree[wtId] ?? [];
            s.activeItemByWorktree[wtId] = nextStack
              ? { type: "stack", id: nextStack.id }
              : compares[0]
                ? { type: "compare", id: compares[0].id }
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
    setGitTab(tab: AppStoreState["gitTab"]) {
      setState("gitTab", tab);
    },
    setDiffMode(mode: AppStoreState["diffMode"]) {
      setState("diffMode", mode);
    },
    toggleIgnoreWhitespace() {
      setState("ignoreWhitespace", (v) => !v);
    },

    // ── Pane groups ──────────────────────────────────────────────────────
    /// Split `groupId` (default: the focused group), returning the new group's
    /// id or `null` when the four-group cap refused. The caller decides what
    /// to put in it — a drag drops the dragged tab there, the keybinding moves
    /// the active one.
    splitPaneGroup(
      wtId: string,
      orientation: SplitOrientation,
      placement: "before" | "after" = "after",
      groupId?: string,
    ): string | null {
      const current = state.paneLayoutByWorktree[wtId] ?? singleGroupLayout();
      const target = groupId ?? focusedGroupId() ?? groupList(current)[0]?.id;
      if (!target) return null;
      const { layout, newGroupId } = splitGroup(current, target, orientation, placement);
      if (!newGroupId) return null;
      setState(produce((s) => {
        s.paneLayoutByWorktree[wtId] = layout;
        s.focusedGroupByWorktree[wtId] = newGroupId;
      }));
      return newGroupId;
    },

    /// Collapse a group. Its tabs are not closed — they fall back to the first
    /// group, because a pane going away must never take a terminal with it.
    closePaneGroup(wtId: string, groupId: string) {
      const current = state.paneLayoutByWorktree[wtId];
      if (!current) return;
      const next = removeGroup(current, groupId);
      if (next === current) return;
      setState(produce((s) => {
        s.paneLayoutByWorktree[wtId] = next;
        if (s.focusedGroupByWorktree[wtId] === groupId) {
          s.focusedGroupByWorktree[wtId] = groupList(next)[0]?.id ?? null;
        }
      }));
    },

    /// Move a tab into a group, landing before `beforeTabId` or at the end.
    /// Focus follows the tab: a drop is a statement about where you want to be
    /// looking.
    moveTabToPaneGroup(
      wtId: string,
      tabId: string,
      groupId: string,
      beforeTabId: string | null = null,
    ) {
      const current = state.paneLayoutByWorktree[wtId] ?? singleGroupLayout();
      const next = moveTabToGroup(current, tabId, groupId, beforeTabId);
      if (next === current) return;
      setState(produce((s) => {
        s.paneLayoutByWorktree[wtId] = next;
        s.focusedGroupByWorktree[wtId] = groupId;
      }));
    },

    /// Which group has keyboard focus. Split-aware navigation and the group
    /// header's `--primary` rule both read it.
    focusPaneGroup(wtId: string, groupId: string) {
      setState("focusedGroupByWorktree", wtId, groupId);
    },

    /// Focus a tab *within* a group, without moving it. The worktree-wide
    /// active item follows only when the group is the focused one — otherwise
    /// clicking a tab in a background pane would steal the front pane's tab.
    setPaneGroupActiveTab(wtId: string, groupId: string, tabId: string | null) {
      const current = state.paneLayoutByWorktree[wtId] ?? singleGroupLayout();
      setState("paneLayoutByWorktree", wtId, setGroupActiveTab(current, groupId, tabId));
    },

    /// Drag on a splitter between two groups.
    setPaneSplitRatios(wtId: string, splitId: string, ratios: number[]) {
      const current = state.paneLayoutByWorktree[wtId];
      if (!current) return;
      setState("paneLayoutByWorktree", wtId, setSplitRatios(current, splitId, ratios));
    },

    /// Back to one group holding everything. The escape hatch for a split the
    /// user cannot undo by closing panes one at a time.
    resetPaneLayout(wtId: string) {
      setState(produce((s) => {
        s.paneLayoutByWorktree[wtId] = singleGroupLayout();
        s.focusedGroupByWorktree[wtId] = null;
      }));
    },

    /// Which group is showing `tabId` right now, unclaimed tabs included.
    paneGroupOwning(wtId: string, tabId: string): string | null {
      const current = state.paneLayoutByWorktree[wtId];
      if (!current) return null;
      return groupOwning(current, tabId, workbenchTabIds());
    },

    // ── Panel geometry ───────────────────────────────────────────────────
    /// Resize one of the shell's three columns. Called on every frame of a
    /// `<Splitter>` drag, which is why the write path behind it is debounced.
    setPanelWidth(panel: PanelId, width: number) {
      setState("panels", panel, clampPanelWidth(panel, width));
    },

    // ── File tabs ────────────────────────────────────────────────────────
    openFileTab(wtId: string, path: string) {
      const existing = (state.openFilesByWorktree[wtId] ?? []).find((f) => f.path === path);
      if (existing) {
        setState("editorActiveItemByWorktree", wtId, { type: "file", id: existing.id, path });
        return existing.id;
      }
      const tab: OpenFileTab = { id: crypto.randomUUID(), path };
      setState(produce((s) => {
        s.openFilesByWorktree[wtId] = [...(s.openFilesByWorktree[wtId] ?? []), tab];
        s.editorActiveItemByWorktree[wtId] = { type: "file", id: tab.id, path };
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
        const active = s.editorActiveItemByWorktree[wtId];
        if (active?.type === "file" && active.id === tabId) {
          const nextFile = arr[arr.length - 1];
          const diffs = s.diffTabsByWorktree[wtId] ?? [];
          s.editorActiveItemByWorktree[wtId] = nextFile
            ? { type: "file", id: nextFile.id, path: nextFile.path }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : null;
        }
      }));
    },

    selectFileTab(wtId: string, tabId: string, path: string) {
      setState("editorActiveItemByWorktree", wtId, { type: "file", id: tabId, path });
    },

    // ── Sidebar tab ──────────────────────────────────────────────────────
    setSidebarTab(tab: AppStoreState["sidebarTab"]) {
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
        setState("editorActiveItemByWorktree", wtId, { type: "conflict", id: existing.id });
        return existing.id;
      }
      const tab: ConflictTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.conflictTabsByWorktree[wtId] = [...(s.conflictTabsByWorktree[wtId] ?? []), tab];
        s.editorActiveItemByWorktree[wtId] = { type: "conflict", id: tab.id };
      }));
      return tab.id;
    },

    closeConflictTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.conflictTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.editorActiveItemByWorktree[wtId];
        if (active?.type === "conflict" && active.id === tabId) {
          const nextConflict = arr[arr.length - 1];
          const files = s.openFilesByWorktree[wtId] ?? [];
          s.editorActiveItemByWorktree[wtId] = nextConflict
            ? { type: "conflict", id: nextConflict.id }
            : files[0]
              ? { type: "file", id: files[0].id, path: files[0].path }
              : null;
        }
      }));
    },

    selectConflictTab(wtId: string, tabId: string) {
      setState("editorActiveItemByWorktree", wtId, { type: "conflict", id: tabId });
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
          s.activeItemByWorktree[wtId] = terms[0]
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
          s.activeItemByWorktree[wtId] = terms[0]
            ? { type: "terminal", id: terms[0].id }
            : null;
        }
      }));
    },

    selectBrainTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "brain", id: tabId });
    },

    // ── Browser tabs (embedded child webview) ───────────────────────────
    /// Open a browser tab pointed at `url`. Unlike the other tab kinds we
    /// never dedupe by URL: two tabs on the same site is a normal thing to
    /// want, and each one owns its own webview.
    openBrowserTab(wtId: string, url: string) {
      const tab: BrowserTab = { id: crypto.randomUUID(), url };
      setState(produce((s) => {
        s.browserTabsByWorktree[wtId] = [...(s.browserTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "browser", id: tab.id };
      }));
      return tab.id;
    },

    closeBrowserTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.browserTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        unpin(s, wtId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "browser" && active.id === tabId) {
          const nextBrowser = arr[arr.length - 1];
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextBrowser
            ? { type: "browser", id: nextBrowser.id }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectBrowserTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "browser", id: tabId });
    },

    /// Record where a browser tab navigated to. The webview does the actual
    /// navigating; this only keeps the persisted address in sync so a reload
    /// comes back to the same page.
    setBrowserUrl(wtId: string, tabId: string, url: string) {
      setState(produce((s) => {
        const tab = (s.browserTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
        if (tab) tab.url = url;
      }));
    },

    /// Record the title the page reported for itself. Drives the tab label.
    setBrowserTitle(wtId: string, tabId: string, title: string) {
      setState(produce((s) => {
        const tab = (s.browserTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
        if (tab) tab.title = title.trim() || undefined;
      }));
    },

    // ── Preview tabs (markdown preview) ─────────────────────────────────
    openPreviewTab(wtId: string, filePath: string) {
      const existing = (state.previewTabsByWorktree[wtId] ?? []).find(
        (t) => t.filePath === filePath,
      );
      if (existing) {
        setState("editorActiveItemByWorktree", wtId, {
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
        s.editorActiveItemByWorktree[wtId] = { type: "preview", id: tab.id, path: filePath };
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
        const active = s.editorActiveItemByWorktree[wtId];
        if (active?.type === "preview" && active.id === tabId) {
          const nextPreview = arr[arr.length - 1];
          const files = s.openFilesByWorktree[wtId] ?? [];
          s.editorActiveItemByWorktree[wtId] = nextPreview
            ? { type: "preview", id: nextPreview.id, path: nextPreview.filePath }
            : files[0]
              ? { type: "file", id: files[0].id, path: files[0].path }
              : null;
        }
      }));
    },

    selectPreviewTab(wtId: string, tabId: string) {
      const tab = (state.previewTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
      if (!tab) return;
      setState("editorActiveItemByWorktree", wtId, {
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
      // A snapshot spans both windows, so it records whichever pointer is set.
      // The workbench's wins when both are: it is the window you were looking
      // at when you typed the snapshot's name.
      const active =
        state.activeItemByWorktree[wtId] ?? state.editorActiveItemByWorktree[wtId];
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
        s.conflictTabsByWorktree[wtId] = [];
        s.previewTabsByWorktree[wtId] = [];
        s.pinnedTabsByWorktree[wtId] = [];
        s.activeItemByWorktree[wtId] = null;
        s.editorActiveItemByWorktree[wtId] = null;
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
            const ptyId = await terminalApi.createPty(cwd, lastGridSize() ?? undefined);
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
      const restored: ActiveItem | null = activeId
        ? buildActiveItem(
            // Determine kind from the key prefix.
            snap.active!.split(":")[0],
            activeId,
            state.openFilesByWorktree[wtId] ?? [],
          )
        : null;

      // Each window gets the first tab it can actually show, and the restored
      // item overrides whichever of the two owns its kind. Setting both is what
      // stops a snapshot whose active tab was a file from leaving the workbench
      // pointing at nothing.
      const firstTerm = state.terminalsByWorktree[wtId]?.[0];
      const firstCompare = state.compareTabsByWorktree[wtId]?.[0];
      const firstStack = state.stackTabsByWorktree[wtId]?.[0];
      const mainFallback: ActiveItem | null = firstTerm
        ? { type: "terminal", id: firstTerm.id }
        : firstCompare
          ? { type: "compare", id: firstCompare.id }
          : firstStack
            ? { type: "stack", id: firstStack.id }
            : null;

      const firstFile = state.openFilesByWorktree[wtId]?.[0];
      const firstDiff = state.diffTabsByWorktree[wtId]?.[0];
      const editorFallback: ActiveItem | null = firstFile
        ? { type: "file", id: firstFile.id, path: firstFile.path }
        : firstDiff
          ? { type: "diff", id: firstDiff.id }
          : null;

      const restoredIsEditorKind = !!restored && isEditorKind(restored.type);

      setState(
        "activeItemByWorktree",
        wtId,
        restored && !restoredIsEditorKind ? restored : mainFallback,
      );
      setState(
        "editorActiveItemByWorktree",
        wtId,
        restored && restoredIsEditorKind ? restored : editorFallback,
      );

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
    /// which list; `fromId` is the moved item; `toId === null` drops at the
    /// end. Drag-and-drop on the unified tab bar in MainSurface routes through
    /// this single action so all tab types stay consistent. Which state field
    /// a kind lives in comes from the registry.
    reorderItemTab(
      wtId: string,
      kind: "file" | "terminal" | "diff" | "compare" | "stack" | "preview",
      fromId: string,
      toId: string | null,
    ) {
      const key = TAB_SPECS[kind].stateKey;
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
    activeBrowserTabs,
    activeItem,
    editorActiveItem,
    workbenchTabIds,
    paneLayout,
    focusedGroupId,
    activeClosedTabs,
    activePinnedTabs,
    actions,
  } as const;
}

export type AppStore = ReturnType<typeof createAppStore>;
