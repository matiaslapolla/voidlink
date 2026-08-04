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
  SNAPSHOT_VERSION,
  type WorkspaceSnapshot,
  snapshotsFor,
  upsertSnapshot,
} from "@/commands/snapshots";
import {
  STORAGE_KEYS,
  readJson,
  readRawChecked,
  writeJson,
} from "./persistence";
import { clampPanelWidth, loadPrefs, persistPrefs } from "./prefs";
import type { DiffMode, GitSectionKey, PanelId } from "./prefs";
import {
  findGroup,
  groupList,
  groupOwning,
  mapPaneTabIds,
  moveTabToGroup,
  parsePaneLayout,
  parsePaneLayouts,
  pruneClosedTabs,
  removeGroup,
  resolveGroupTabs,
  serializePaneLayout,
  setGroupActiveTab,
  setSplitRatios,
  singleGroupLayout,
  splitGroup,
  type SplitOrientation,
} from "./panes";
import {
  addTabToGroup,
  createTabGroup,
  dissolveTabGroup,
  effectiveTabGroups,
  emptyTabGroupState,
  materializeAutoGroups,
  moveTabGroupToPane,
  parseTabGroupStates,
  pruneTabGroups,
  recolorTabGroup,
  removeTabFromGroup,
  renameTabGroup,
  reorderTabGroups,
  serializeTabGroupState,
  setAutoGroupMode,
  toggleTabGroupCollapsed,
  type AutoGroupMode,
  type TabGroup,
  type TabGroupColor,
  type TabGroupDerivation,
  type TabGroupState,
} from "./tabGroups";
import {
  applyLayoutPreset,
  captureLayoutPreset,
  presetsFor,
  upsertPreset,
  type LayoutPreset,
} from "./presets";
import {
  canNavigateBack,
  canNavigateForward,
  emptyNavHistory,
  mruIndexAfter,
  mruOrder,
  parseGroupMrus,
  parseNavHistories,
  pruneMru,
  pruneNav,
  pushNav,
  removeFromMru,
  stepNav,
  touchMru,
  type NavEntry,
  type NavHistory,
} from "./navigation";
import {
  TAB_KINDS,
  COMPARE_TREE_WIDTH_DEFAULT,
  TAB_KIND_GROUP_LABELS,
  TAB_SPECS,
  WORKBENCH_TAB_KINDS,
  clampCompareTreeWidth,
  closedTabsEqual,
  deserializeClosedTab,
  deserializeTabRecord,
  isEditorKind,
  parseEditorTabs,
  serializeEditorTabs,
} from "./tabs";
import type {
  ActiveItem,
  TabRestoreContext,
  AgentTab,
  CombinedDiffTab,
  TimelineTab,
  MissionTab,
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
  TabTypes,
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
  AgentTab,
  CombinedDiffTab,
  TimelineTab,
  MissionTab,
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
export {
  COMPARE_TREE_WIDTH_MAX,
  COMPARE_TREE_WIDTH_MIN,
  TAB_KINDS,
  TAB_SPECS,
  parseEditorTabs,
  samePath,
  serializeEditorTabs,
} from "./tabs";
export type {
  DiffMode,
  GitSectionKey,
  GitSections,
  GitTab,
  PanelId,
  PanelWidths,
  SidebarTab,
  UiPrefs,
} from "./prefs";
export { GIT_SECTION_KEYS, PANEL_BOUNDS } from "./prefs";
export type { PaneGroup, PaneNode, SplitOrientation } from "./panes";
export type {
  AutoGroupMode,
  StripEntry,
  TabGroup,
  TabGroupColor,
  TabGroupDerivation,
  TabGroupState,
} from "./tabGroups";
export {
  AUTO_GROUP_MODES,
  TAB_GROUP_COLORS,
  emptyTabGroupState,
  stripEntries,
  tabGroupOf,
  visibleStripTabIds,
} from "./tabGroups";
export type { LayoutPreset } from "./presets";
export {
  PRESET_VERSION,
  allPresets,
  presetsFor,
  removePreset,
  renamePreset,
} from "./presets";
export type { GroupMru, MruList, NavEntry, NavHistory } from "./navigation";
export {
  NAV_HISTORY_LIMIT,
  canNavigateBack,
  canNavigateForward,
  emptyNavHistory,
  mruOrder,
} from "./navigation";
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
export {
  LAYOUT_STORAGE_KEYS,
  STORAGE_KEYS,
  flushWrites,
  resetLayoutStorage,
  setCorruptKeyHandler,
  setPersistenceErrorHandler,
} from "./persistence";

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
///
/// Terminals are excluded on purpose even though they now have a key: their
/// `restore()` has to spawn a PTY, which cannot happen inside a synchronous
/// store initialiser. They arrive through `restoreTerminalSessions()` below,
/// which is the only path that may put a `TerminalSession` in state.
function loadKindRecord<K extends TabKind>(
  kind: K,
  worktreeIds: string[],
): Record<string, unknown[]> {
  const spec = TAB_SPECS[kind];
  if (!spec.storage || spec.storage.field || kind === "terminal") {
    return Object.fromEntries(worktreeIds.map((id) => [id, [] as unknown[]]));
  }
  return deserializeTabRecord(kind, readJson(spec.storage.key, null), worktreeIds);
}

/// The workbench's saved front tab, per worktree.
///
/// This pointer had never been persisted before Wave 4 — only the editor
/// window's, which rides inside `voidlink-editor-tabs`. Session restore made
/// keeping it the obvious call: a reload that brings back nine tabs and then
/// picks one of them arbitrarily is not a restored session. Editor kinds are
/// rejected on the way in, because this pointer names a tab the workbench
/// itself renders and an editor kind here would leave the surface blank.
function loadActiveItems(worktreeIds: string[]): Record<string, ActiveItem | null> {
  const out: Record<string, ActiveItem | null> = Object.fromEntries(
    worktreeIds.map((id) => [id, null]),
  );
  const parsed = readJson<Record<string, unknown> | null>(STORAGE_KEYS.activeItem, null);
  if (!parsed || typeof parsed !== "object") return out;
  for (const wtId of worktreeIds) {
    const item = parsed[wtId];
    if (!item || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; id?: unknown; path?: unknown };
    if (typeof candidate.type !== "string" || typeof candidate.id !== "string") continue;
    if (isEditorKind(candidate.type)) continue;
    if (!TAB_KINDS.includes(candidate.type as TabKind)) continue;
    out[wtId] = candidate as ActiveItem;
  }
  return out;
}

/// The reopen-last-closed LIFO, per worktree. Persisted since Wave 4: closing
/// a tab you wanted five minutes before a reload is the same mistake either
/// side of that reload.
function loadClosedTabs(worktreeIds: string[]): Record<string, ClosedTab[]> {
  const out: Record<string, ClosedTab[]> = Object.fromEntries(
    worktreeIds.map((id) => [id, [] as ClosedTab[]]),
  );
  const parsed = readJson<Record<string, unknown> | null>(STORAGE_KEYS.closedTabs, null);
  if (!parsed || typeof parsed !== "object") return out;
  for (const wtId of worktreeIds) {
    const list = parsed[wtId];
    if (!Array.isArray(list)) continue;
    out[wtId] = list
      .map((entry) => deserializeClosedTab(entry))
      .filter((t): t is ClosedTab => t !== null)
      .slice(-CLOSED_TAB_HISTORY_LIMIT);
  }
  return out;
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
  const editorTabs = parseEditorTabs(readRawChecked(STORAGE_KEYS.editorTabs), worktreeIds);
  /// Read before any persist effect can run: the terminal restore below is
  /// async, and the effect that writes `terminalsByWorktree` fires on the
  /// store's first tick with the collection still empty.
  const persistedTerminals = readJson<Record<string, unknown> | null>(
    STORAGE_KEYS.terminalTabs,
    null,
  );
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
    historyTabsByWorktree: loadKindRecord("history", worktreeIds) as Record<
      string,
      HistoryTab[]
    >,
    previewTabsByWorktree: editorTabs.previews,
    timelineTabsByWorktree: loadKindRecord("timeline", worktreeIds) as Record<string, TimelineTab[]>,
    combinedTabsByWorktree: loadKindRecord("combined", worktreeIds) as Record<
      string,
      CombinedDiffTab[]
    >,
    missionTabsByWorktree: loadKindRecord("mission", worktreeIds) as Record<string, MissionTab[]>,
    browserTabsByWorktree: loadKindRecord("browser", worktreeIds) as Record<
      string,
      BrowserTab[]
    >,
    agentTabsByWorktree: loadKindRecord("agent", worktreeIds) as Record<string, AgentTab[]>,
    closedTabsByWorktree: loadClosedTabs(worktreeIds),
    pinnedTabsByWorktree: loadPinnedTabs(worktreeIds),
    activeItemByWorktree: loadActiveItems(worktreeIds),
    editorActiveItemByWorktree: editorTabs.active,
    paneLayoutByWorktree: parsePaneLayouts(
      readJson(STORAGE_KEYS.paneLayout, null),
      worktreeIds,
    ),
    tabGroupsByWorktree: parseTabGroupStates(
      readJson(STORAGE_KEYS.tabGroups, null),
      worktreeIds,
    ),
    focusedGroupByWorktree: Object.fromEntries(worktreeIds.map((id) => [id, null])),
    tabMruByWorktree: parseGroupMrus(readJson(STORAGE_KEYS.tabMru, null), worktreeIds),
    navHistoryByWorktree: parseNavHistories(
      readJson(STORAGE_KEYS.navHistory, null),
      worktreeIds,
    ),
    panels: prefs.panels,
    gitSidebarCollapsed: prefs.gitSidebarCollapsed,
    leftSidebarCollapsed: prefs.leftSidebarCollapsed,
    sidebarsSwapped: prefs.sidebarsSwapped,
    diffMode: prefs.diffMode,
    diffLineNumbers: prefs.diffLineNumbers,
    gitTab: prefs.gitTab,
    ignoreWhitespace: prefs.ignoreWhitespace,
    sidebarTab: prefs.sidebarTab,
    gitSections: prefs.gitSections,
    gitSectionOrder: prefs.gitSectionOrder,
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
    writeJson(STORAGE_KEYS.activeItem, state.activeItemByWorktree);
  });

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.closedTabs, state.closedTabsByWorktree);
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
    const out: Record<string, unknown> = {};
    for (const [wtId, groups] of Object.entries(state.tabGroupsByWorktree)) {
      out[wtId] = serializeTabGroupState(groups);
    }
    writeJson(STORAGE_KEYS.tabGroups, out);
  });

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.editorTabs, serializeEditorTabs(state));
  });

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.tabMru, state.tabMruByWorktree);
  });

  createEffect(() => {
    if (!persist) return;
    writeJson(STORAGE_KEYS.navHistory, state.navHistoryByWorktree);
  });

  createEffect(() => {
    if (!persist) return;
    persistPrefs({
      panels: state.panels,
      gitSidebarCollapsed: state.gitSidebarCollapsed,
      leftSidebarCollapsed: state.leftSidebarCollapsed,
      sidebarsSwapped: state.sidebarsSwapped,
      diffMode: state.diffMode,
      diffLineNumbers: state.diffLineNumbers,
      gitTab: state.gitTab,
      ignoreWhitespace: state.ignoreWhitespace,
      sidebarTab: state.sidebarTab,
      gitSections: state.gitSections,
      gitSectionOrder: [...state.gitSectionOrder],
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

  /// The eleven `active*Tabs` memos, generated from the registry. Adding a kind
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
  const activeTimelineTabs = activeOf<TimelineTab>("timeline");
  const activeCombinedTabs = activeOf<CombinedDiffTab>("combined");
  const activeMissionTabs = activeOf<MissionTab>("mission");
  const activeBrowserTabs = activeOf<BrowserTab>("browser");
  const activeAgentTabs = activeOf<AgentTab>("agent");

  /// Every workbench tab id for the active worktree, in strip order. The pane
  /// tree stores claims by id, so this is what turns those claims into content
  /// — and what tells the tree which claims have gone stale.
  ///
  /// Workbench kinds only: the editor window's four kinds live in a different
  /// window with its own pointer, and a pane group here can never show one.
  /// Driven by the registry, so registering a kind is all it takes to make its
  /// tabs claimable — a kind left out here has a tab strip entry and a pane
  /// body and still never appears.
  const workbenchTabIds = createMemo(() => worktreeTabIds(state.activeWorktreeId));

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

  // ── Tab groups ────────────────────────────────────────────────────────────
  // A second axis over the pane tree: which *labelled set* a tab is in, inside
  // whatever strip its pane group resolved to. Everything structural lives in
  // `tabGroups.ts`; what is here is the reactive plumbing and the rule that a
  // hand-edit of a derived group materialises the derivation first.

  /// Every workbench tab id for an *arbitrary* worktree. `workbenchTabIds` is
  /// the memoised version for the active one; actions take a worktree id, so
  /// they need this.
  function worktreeTabIds(wtId: string): string[] {
    const out: string[] = [];
    for (const kind of WORKBENCH_TAB_KINDS) {
      const list = (state[TAB_SPECS[kind].stateKey] as Record<string, { id: string }[]>)[wtId];
      if (list) for (const tab of list) out.push(tab.id);
    }
    return out;
  }

  function tabKindMap(wtId: string): Map<string, TabKind> {
    const out = new Map<string, TabKind>();
    for (const kind of WORKBENCH_TAB_KINDS) {
      const list = (state[TAB_SPECS[kind].stateKey] as Record<string, { id: string }[]>)[wtId];
      if (list) for (const tab of list) out.set(tab.id, kind);
    }
    return out;
  }

  function tabGroupStateOf(wtId: string): TabGroupState {
    return state.tabGroupsByWorktree[wtId] ?? emptyTabGroupState();
  }

  /// Pane group id → the tabs it resolves to, for any worktree.
  function paneTabIdsOf(wtId: string): Map<string, string[]> {
    const layout = state.paneLayoutByWorktree[wtId];
    if (!layout) return new Map();
    return resolveGroupTabs(layout, worktreeTabIds(wtId));
  }

  /// How the worktree's auto-grouping mode buckets tabs, or `null` under `off`.
  ///
  /// **A note on `worktree` mode.** Every workbench tab collection is keyed by
  /// worktree id, so every tab in this worktree *is* from this worktree — the
  /// mode therefore yields a single bucket named after the worktree. It is
  /// implemented as specified rather than reinterpreted; the axis only earns
  /// its keep once a pane can show another worktree's tab.
  function derivationFor(wtId: string): TabGroupDerivation | null {
    const mode = tabGroupStateOf(wtId).mode;
    if (mode === "off") return null;
    if (mode === "kind") {
      const kinds = tabKindMap(wtId);
      return {
        key: (tabId) => kinds.get(tabId) ?? null,
        label: (key) => TAB_KIND_GROUP_LABELS[key as TabKind] ?? key,
      };
    }
    const names = new Map<string, string>();
    const found = locateWorktree(wtId);
    if (found) {
      names.set(wtId, found.worktree.branch || found.worktree.path.split("/").pop() || "Worktree");
    }
    return {
      key: () => wtId,
      label: (key) => names.get(key) ?? "Worktree",
    };
  }

  /// The active worktree's groups as they should render: the manual ones under
  /// `off`, the derivation otherwise.
  const tabGroupsByPane = createMemo<Record<string, TabGroup[]>>(() => {
    const wtId = state.activeWorktreeId;
    const groups = state.tabGroupsByWorktree[wtId];
    if (!groups) return {};
    const paneTabs = resolveGroupTabs(paneLayout(), workbenchTabIds());
    return effectiveTabGroups(groups, paneTabs, derivationFor(wtId));
  });

  /// Forget grouped tabs that closed or moved to another pane, and the groups
  /// they emptied. Same shape (and same termination guard) as the pane tree's
  /// prune: the reducer returns its input by reference when nothing changed.
  createEffect(() => {
    const wtId = state.activeWorktreeId;
    const groups = state.tabGroupsByWorktree[wtId];
    if (!groups || groups.mode !== "off") return;
    const next = pruneTabGroups(groups, resolveGroupTabs(paneLayout(), workbenchTabIds()));
    if (next !== groups) setState("tabGroupsByWorktree", wtId, next);
  });

  /// Every tab-group mutation goes through here.
  ///
  /// The materialise step is the whole contract of "derived groups are
  /// read-only": the edit lands, and the rule that would have undone it stops
  /// applying. Without it a rename would appear to work and then vanish on the
  /// next re-derivation, which is the exact frustration Wave 4 exists to avoid.
  function editTabGroups(wtId: string, fn: (s: TabGroupState) => TabGroupState) {
    const current = tabGroupStateOf(wtId);
    const manual = materializeAutoGroups(current, paneTabIdsOf(wtId), derivationFor(wtId));
    const next = fn(manual);
    if (next === current) return;
    setState("tabGroupsByWorktree", wtId, next);
  }

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

  // ── Navigation: MRU and history ───────────────────────────────────────────

  /// The MRU-ordered candidate list for one group: recorded order first, then
  /// the group's untouched tabs in strip order. This is exactly what the
  /// `Ctrl+Tab` overlay lists, so the overlay needs no ordering logic of its
  /// own.
  function mruOrderFor(groupId: string | null): string[] {
    const target = groupId ?? focusedGroupId();
    if (!target) return [];
    const ids = resolveGroupTabs(paneLayout(), workbenchTabIds()).get(target) ?? [];
    const mru = state.tabMruByWorktree[state.activeWorktreeId]?.[target] ?? [];
    return mruOrder(mru, ids);
  }

  /// The candidate list for the focused group, as a memo so the overlay can
  /// track it reactively while it is held open.
  const focusedGroupMru = createMemo(() => mruOrderFor(focusedGroupId()));

  const navHistory = createMemo(
    () => state.navHistoryByWorktree[state.activeWorktreeId] ?? emptyNavHistory(),
  );
  const canGoBack = createMemo(() => canNavigateBack(navHistory()));
  const canGoForward = createMemo(() => canNavigateForward(navHistory()));

  /// Record every workbench tab activation, whatever caused it — a click, a
  /// chord, a drop, a restore. One effect rather than a call at each of the six
  /// `select*Tab` actions: those are not the only writers of `activeItem`, and a
  /// history with holes in it is worse than none.
  ///
  /// Back/forward do not need to suppress this. `pushNav` dedupes against the
  /// entry the cursor is *on*, so re-reporting the tab a back step just landed
  /// on is a no-op — see `navigation.ts`.
  createEffect(() => {
    const wtId = state.activeWorktreeId;
    const item = activeItem();
    if (!item) return;
    const groupId = groupOwning(paneLayout(), item.id, workbenchTabIds());
    setState(
      produce((s) => {
        const groups = (s.tabMruByWorktree[wtId] ??= {});
        if (groupId) groups[groupId] = touchMru(groups[groupId] ?? [], item.id);
        const history = s.navHistoryByWorktree[wtId] ?? emptyNavHistory();
        s.navHistoryByWorktree[wtId] = pushNav(history, { groupId, item });
      }),
    );
  });

  /// Forget closed tabs. Runs on the same signal the pane tree's prune does,
  /// and is likewise guarded on "did anything actually change" — the reducers
  /// return their input by reference when it did not.
  createEffect(() => {
    const wtId = state.activeWorktreeId;
    const live = workbenchTabIds();
    const mru = state.tabMruByWorktree[wtId];
    const history = state.navHistoryByWorktree[wtId];
    setState(
      produce((s) => {
        if (mru) {
          for (const [groupId, list] of Object.entries(mru)) {
            const next = pruneMru(list, live);
            if (next !== list) s.tabMruByWorktree[wtId][groupId] = next;
          }
        }
        if (history) {
          const next = pruneNav(history, live);
          if (next !== history) s.navHistoryByWorktree[wtId] = next;
        }
      }),
    );
  });

  /// Find a worktree anywhere in the store by id, with its owning workspace.
  function locateWorktree(wtId: string) {
    for (const ws of state.workspaces) {
      const wt = ws.worktrees.find((w) => w.id === wtId);
      if (wt) return { workspace: ws, worktree: wt };
    }
    return null;
  }

  /// Bring every persisted terminal session back, in saved order, each against
  /// a PTY spawned now. The tab keeps its saved id — pins, pane claims, the
  /// MRU and the restored active-tab pointer are all id-keyed — and is marked
  /// `restored` so the tab tooltip can say the scrollback is gone rather than
  /// let an empty pane imply it survived.
  ///
  /// Only the window that persists does this. The git window hydrates the same
  /// state and must not spawn a second set of shells for it.
  async function restoreTerminalSessions() {
    if (!persistedTerminals || typeof persistedTerminals !== "object") return;
    for (const [wtId, rawList] of Object.entries(persistedTerminals)) {
      if (!Array.isArray(rawList)) continue;
      const worktreePath = locateWorktree(wtId)?.worktree.path ?? "";
      // A worktree that has been removed since the last run takes its
      // terminals with it; there is nowhere to root the shell.
      if (!worktreePath) continue;
      const ctx: TabRestoreContext = {
        worktreePath,
        spawnPty: (cwd) => terminalApi.createPty(cwd, lastGridSize() ?? undefined),
      };
      for (const raw of rawList) {
        let session: TerminalSession | null = null;
        try {
          session = await TAB_SPECS.terminal.restore(raw, ctx);
        } catch {
          // A failed spawn costs one terminal, not the rest of the session.
          session = null;
        }
        const restored = session;
        if (!restored) continue;
        setState(
          produce((s) => {
            const list = s.terminalsByWorktree[wtId];
            if (!list) return;
            if (list.some((t) => t.id === restored.id)) return;
            list.push(restored);
          }),
        );
      }
    }
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

  /// Record a close through the registry, so what a kind keeps in order to be
  /// reopened is stated once — in its spec — rather than at each close action.
  function recordClose<K extends TabKind>(
    s: AppStoreState,
    wtId: string,
    kind: K,
    tab: TabTypes[K],
  ) {
    const snapshot = (TAB_SPECS[kind].closedSnapshot as (t: TabTypes[K]) => ClosedTab | null)(
      tab,
    );
    if (snapshot) pushClosed(s, wtId, snapshot);
  }

  /// Reconstruct an ActiveItem from a kind string + id (post-snapshot
  /// restore). For files we need the path too; we look it up by id in
  /// the freshly-restored file list.
  function buildActiveItem(
    kind: string,
    id: string,
    lookup: { files: OpenFileTab[]; previews: PreviewTab[] },
  ): ActiveItem | null {
    switch (kind) {
      // The two pointers that carry a path alongside the id have to find it
      // again; the rest are the id and the kind.
      case "file": {
        const f = lookup.files.find((f) => f.id === id);
        return f ? { type: "file", id, path: f.path } : null;
      }
      case "preview": {
        const p = lookup.previews.find((p) => p.id === id);
        return p ? { type: "preview", id, path: p.filePath } : null;
      }
      case "terminal": return { type: "terminal", id };
      case "diff": return { type: "diff", id };
      case "compare": return { type: "compare", id };
      case "stack": return { type: "stack", id };
      case "conflict": return { type: "conflict", id };
      case "history": return { type: "history", id };
      case "timeline": return { type: "timeline", id };
      case "combined": return { type: "combined", id };
      case "mission": return { type: "mission", id };
      case "browser": return { type: "browser", id };
      case "agent": return { type: "agent", id };
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
        recordClose(s, wtId, "terminal", arr[idx]);
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
    /// `staged` is part of the key, not a flag on the tab.
    ///
    /// A partially-staged file has two sidebar rows and two different diffs.
    /// Deduping on `filePath` alone made the second row select the first row's
    /// tab, so whichever side you clicked second was simply unreachable.
    openDiffTab(wtId: string, filePath: string, staged = false) {
      const existing = (state.diffTabsByWorktree[wtId] ?? []).find(
        (d) => d.filePath === filePath && d.staged === staged,
      );
      if (existing) {
        setState("editorActiveItemByWorktree", wtId, { type: "diff", id: existing.id });
        return existing.id;
      }
      const tab: DiffTab = { id: crypto.randomUUID(), filePath, staged };
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
    /// Open a compare tab, reusing one that already asks the same question.
    ///
    /// It used to create a tab unconditionally, unlike `openHistoryTab` beside
    /// it. Clicking ten rows in the commit graph produced ten identical tabs,
    /// and clicking the same row twice produced two — the tab strip filled with
    /// duplicates of a view that has no per-tab state worth duplicating.
    openCompareTab(
      wtId: string,
      opts?: {
        baseRef?: string;
        headRef?: string;
        useMergeBase?: boolean;
        label?: string;
      },
    ) {
      const baseRef = opts?.baseRef ?? "";
      const headRef = opts?.headRef ?? "";
      const useMergeBase = opts?.useMergeBase ?? true;
      // Only dedupe a tab that names both refs: a blank compare tab is the
      // "pick two refs" surface, and the user may legitimately want two.
      if (baseRef && headRef) {
        const existing = (state.compareTabsByWorktree[wtId] ?? []).find(
          (t) =>
            t.baseRef === baseRef &&
            t.headRef === headRef &&
            t.useMergeBase === useMergeBase,
        );
        if (existing) {
          setState(
            produce((s) => {
              s.activeItemByWorktree[wtId] = { type: "compare", id: existing.id };
            }),
          );
          return existing.id;
        }
      }
      const tab: CompareTab = {
        id: crypto.randomUUID(),
        baseRef,
        headRef,
        useMergeBase,
        selectedFilePath: null,
        treeMode: "tree",
        treeFilter: "",
        treeWidth: COMPARE_TREE_WIDTH_DEFAULT,
        ...(opts?.label ? { label: opts.label } : {}),
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
            label: closed.label,
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

    /// Per tab, where the mode and the filter already were. One shared
    /// `localStorage` key meant dragging the divider in one comparison moved
    /// it in every other one — and only after a reload, since nothing told the
    /// live tabs.
    setCompareTreeWidth(wtId: string, tabId: string, width: number) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.treeWidth = clampCompareTreeWidth(width);
        }),
      );
    },

    /// Per tab, deliberately not `setDiffMode` below. `CompareDiffPane` reads
    /// this instead of the global `state.diffMode` the working-tree toolbar
    /// drives — rendering only, so unlike `setCompareIgnoreWhitespace` it
    /// touches no resource key and refetches nothing.
    setCompareDiffMode(wtId: string, tabId: string, mode: DiffMode) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.diffMode = mode;
        }),
      );
    },

    /// Per tab, deliberately not `toggleIgnoreWhitespace` below. That global
    /// toggle is shared with the working-tree diff toolbar; flipping it would
    /// refetch every open compare tab at once, each re-running a full diff
    /// behind the same per-repo git mutex (CMP-F10 is the payload budget that
    /// exists to bound that serialization). `ignoreWhitespace` sits in
    /// `CompareTab.tsx`'s resource key, so writing it here refetches exactly
    /// this tab and no other.
    setCompareIgnoreWhitespace(wtId: string, tabId: string, value: boolean) {
      setState(
        produce((s) => {
          const tab = (s.compareTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
          if (tab) tab.ignoreWhitespace = value;
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
    /// Line numbers on both diff gutters. A preference about reading, not about
    /// this file — so it lives beside `diffMode` rather than in a tab.
    toggleDiffLineNumbers() {
      setState("diffLineNumbers", (v) => !v);
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

    // ── Tab groups ───────────────────────────────────────────────────────
    /// Create a labelled group in `paneGroupId` holding `tabIds`. Returns its
    /// id, or `null` when the pane group does not exist — a group with nowhere
    /// to render is worse than no group.
    createTabGroup(
      wtId: string,
      paneGroupId: string,
      tabIds: string[],
      label?: string,
    ): string | null {
      const layout = state.paneLayoutByWorktree[wtId];
      if (!layout || !findGroup(layout, paneGroupId)) return null;
      let created: string | null = null;
      editTabGroups(wtId, (s) => {
        const out = createTabGroup(s, paneGroupId, { tabIds, label });
        created = out.groupId;
        return out.state;
      });
      return created;
    },

    renameTabGroup(wtId: string, groupId: string, label: string) {
      editTabGroups(wtId, (s) => renameTabGroup(s, groupId, label));
    },

    recolorTabGroup(wtId: string, groupId: string, color: TabGroupColor) {
      editTabGroups(wtId, (s) => recolorTabGroup(s, groupId, color));
    },

    /// Collapse or expand. A collapsed group occupies one chip and renders
    /// none of its members — which is why `store/activity.ts` had to learn
    /// about them: a signal on a hidden member escalates to the chip.
    toggleTabGroup(wtId: string, groupId: string) {
      editTabGroups(wtId, (s) => toggleTabGroupCollapsed(s, groupId));
    },

    /// Put `tabId` in `groupId`, or take it out of whatever group holds it
    /// when `groupId` is `null`. One action rather than two because the drag
    /// that does it is one gesture with two landing zones.
    assignTabToGroup(
      wtId: string,
      tabId: string,
      groupId: string | null,
      beforeTabId: string | null = null,
    ) {
      editTabGroups(wtId, (s) =>
        groupId === null
          ? removeTabFromGroup(s, tabId)
          : addTabToGroup(s, groupId, tabId, beforeTabId),
      );
    },

    /// Reorder a group within its own strip.
    reorderTabGroup(wtId: string, groupId: string, beforeGroupId: string | null) {
      editTabGroups(wtId, (s) => reorderTabGroups(s, groupId, beforeGroupId));
    },

    /// Move a whole group to another pane group. The members are re-claimed
    /// one at a time through the pane reducer, so the two models cannot
    /// disagree about who owns what.
    moveTabGroupToPane(wtId: string, groupId: string, toPaneGroupId: string) {
      const layout = state.paneLayoutByWorktree[wtId];
      if (!layout) return;
      const current = tabGroupStateOf(wtId);
      const manual = materializeAutoGroups(current, paneTabIdsOf(wtId), derivationFor(wtId));
      const moved = moveTabGroupToPane(manual, layout, groupId, toPaneGroupId);
      if (moved.state === current && moved.layout === layout) return;
      setState(
        produce((s) => {
          s.tabGroupsByWorktree[wtId] = moved.state;
          s.paneLayoutByWorktree[wtId] = moved.layout;
          s.focusedGroupByWorktree[wtId] = toPaneGroupId;
        }),
      );
    },

    /// Drop the group, leaving its tabs in the strip.
    dissolveTabGroup(wtId: string, groupId: string) {
      editTabGroups(wtId, (s) => dissolveTabGroup(s, groupId));
    },

    /// Every workbench tab in the window, mapped to the worktree that owns it.
    ///
    /// Exists for §7.5.3 rule 1 across worktrees. Every other consumer of tab
    /// state asks about the *active* worktree, because that is the only one
    /// rendered — but a signal raised in a worktree the user is not in has to
    /// reach a surface, and deciding that requires knowing which worktree each
    /// signalling tab belongs to. Nothing else in the store answers that
    /// question, because until agents ran in several worktrees at once nothing
    /// needed to.
    tabWorktreeMap(): Map<string, string> {
      const out = new Map<string, string>();
      for (const ws of state.workspaces) {
        for (const wt of ws.worktrees) {
          for (const id of worktreeTabIds(wt.id)) out.set(id, wt.id);
        }
      }
      return out;
    },

    /// The groups one pane group's strip should render, derivation applied.
    tabGroupsOfPane(paneGroupId: string): TabGroup[] {
      return tabGroupsByPane()[paneGroupId] ?? [];
    },

    /// The group holding `tabId` right now, or `null`.
    tabGroupHolding(tabId: string): TabGroup | null {
      for (const list of Object.values(tabGroupsByPane())) {
        const hit = list.find((g) => g.tabIds.includes(tabId));
        if (hit) return hit;
      }
      return null;
    },

    /// Look a group up by id across every pane, derivation applied.
    findTabGroup(groupId: string): TabGroup | null {
      for (const list of Object.values(tabGroupsByPane())) {
        const hit = list.find((g) => g.id === groupId);
        if (hit) return hit;
      }
      return null;
    },

    autoGroupMode(wtId: string): AutoGroupMode {
      return tabGroupStateOf(wtId).mode;
    },

    /// Switch the worktree between manual assignment and a derivation.
    /// Switching *into* a derived mode discards the manual arrangement rather
    /// than keeping a shadow copy that would reappear unannounced later.
    setAutoGroupMode(wtId: string, mode: AutoGroupMode) {
      const current = tabGroupStateOf(wtId);
      const next = setAutoGroupMode(current, mode);
      if (next === current) return;
      setState("tabGroupsByWorktree", wtId, next);
    },

    // ── Layout presets ───────────────────────────────────────────────────
    /// Capture the active worktree's arrangement — the pane tree, the
    /// tab-group structure, each pane group's front tab and the three panel
    /// widths — under `name`, in the *workspace's* preset list.
    ///
    /// Deliberately not `saveWorkspaceSnapshot`: a snapshot is a session and
    /// restoring one closes and reopens every tab. A preset carries no tab
    /// contents at all.
    saveLayoutPreset(wtId: string, name: string): boolean {
      const layout = state.paneLayoutByWorktree[wtId];
      if (!layout) return false;
      const preset = captureLayoutPreset(name, layout, tabGroupStateOf(wtId), state.panels);
      if (!preset) return false;
      upsertPreset(state.activeWorkspaceId, preset);
      return true;
    },

    layoutPresets(): LayoutPreset[] {
      return presetsFor(state.activeWorkspaceId);
    },

    /// Apply a preset to `wtId`. Degrades rather than fails: geometry that
    /// names tabs this worktree does not have is placed empty, where the
    /// pane's existing empty state already says what to do about it.
    applyLayoutPreset(wtId: string, name: string): boolean {
      const preset = presetsFor(state.activeWorkspaceId).find((p) => p.name === name);
      if (!preset) return false;
      const applied = applyLayoutPreset(preset, worktreeTabIds(wtId));
      setState(
        produce((s) => {
          s.paneLayoutByWorktree[wtId] = applied.layout;
          s.tabGroupsByWorktree[wtId] = applied.tabGroups;
          s.panels = applied.panels;
          s.focusedGroupByWorktree[wtId] = null;
        }),
      );
      return true;
    },

    // ── Navigation ───────────────────────────────────────────────────────
    /// The MRU-ordered tab ids for a group (default: the focused one). Index 0
    /// is the tab you are on, so `Ctrl+Tab` once is index 1.
    tabMruOrder(groupId?: string | null): string[] {
      return mruOrderFor(groupId ?? null);
    },

    /// Where `steps` presses of `Ctrl+Tab` land in `groupId`'s MRU, or `null`
    /// when the group has nothing to cycle.
    tabAfterMruSteps(steps: number, groupId?: string | null): string | null {
      const order = mruOrderFor(groupId ?? null);
      if (order.length < 2) return null;
      return order[mruIndexAfter(order.length, steps)] ?? null;
    },

    /// Drop a tab from every group's MRU. Closing is handled by the prune
    /// effect; this is for the case where a tab has to be forgotten without
    /// having closed — a snapshot restore replacing the whole tab set.
    forgetTabInMru(wtId: string, tabId: string) {
      setState(
        produce((s) => {
          const groups = s.tabMruByWorktree[wtId];
          if (!groups) return;
          for (const [groupId, list] of Object.entries(groups)) {
            const next = removeFromMru(list, tabId);
            if (next !== list) groups[groupId] = next;
          }
        }),
      );
    },

    /// Record a visit the activation effect cannot see: an editor-window
    /// target, which the workbench opens but never renders and which therefore
    /// never moves `activeItem`. The line is what makes back land on the place
    /// you were reading rather than the top of the file.
    recordNavVisit(wtId: string, entry: NavEntry) {
      setState(
        produce((s) => {
          s.navHistoryByWorktree[wtId] = pushNav(
            s.navHistoryByWorktree[wtId] ?? emptyNavHistory(),
            entry,
          );
        }),
      );
    },

    /// Step back (`-1`) or forward (`1`), returning the entry the caller should
    /// now activate. `null` means the end of the history — the caller renders a
    /// disabled control rather than reporting a failure.
    navigateHistory(wtId: string, direction: -1 | 1): NavEntry | null {
      const current: NavHistory = state.navHistoryByWorktree[wtId] ?? emptyNavHistory();
      const { history, entry } = stepNav(current, direction);
      if (!entry) return null;
      setState(
        produce((s) => {
          s.navHistoryByWorktree[wtId] = history;
          // Landing in another pane focuses it: back is a statement about where
          // you want to be, not just what you want to look at.
          if (entry.groupId) s.focusedGroupByWorktree[wtId] = entry.groupId;
        }),
      );
      return entry;
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

    /// Move one git section up (`-1`) or down (`+1`) in the sidebar's order.
    /// A relative move rather than a drag payload because the same action then
    /// serves the header's two chevrons *and* a keyboard user, and neither has
    /// to know the whole list.
    moveGitSection(section: GitSectionKey, delta: number) {
      setState(produce((s) => {
        const from = s.gitSectionOrder.indexOf(section);
        if (from === -1) return;
        const to = Math.min(s.gitSectionOrder.length - 1, Math.max(0, from + delta));
        if (to === from) return;
        const [moved] = s.gitSectionOrder.splice(from, 1);
        s.gitSectionOrder.splice(to, 0, moved);
      }));
    },

    /// Drop `section` at `index`. The drag-and-drop half of the same reorder.
    setGitSectionIndex(section: GitSectionKey, index: number) {
      setState(produce((s) => {
        const from = s.gitSectionOrder.indexOf(section);
        if (from === -1) return;
        const to = Math.min(s.gitSectionOrder.length - 1, Math.max(0, index));
        if (to === from) return;
        const [moved] = s.gitSectionOrder.splice(from, 1);
        s.gitSectionOrder.splice(to, 0, moved);
      }));
    },

    // ── Left sidebar collapsible sections ────────────────────────────────
    toggleSidebarSection(section: keyof AppStoreState["sidebarSections"]) {
      setState("sidebarSections", section, (v) => !v);
    },

    // ── Reopen recently closed ───────────────────────────────────────────
    /// Pop the worktree's most-recent closed tab and recreate it, returning
    /// what was reopened (or `null` when the history is empty).
    ///
    /// Every one of the ten kinds is here now, driven by the registry's
    /// `closedSnapshot`. A reopened terminal is a *new shell* in the closed
    /// one's cwd under its old label — the same trade session restore makes,
    /// and the reason `spawnTerminal` is not simply called (it would invent a
    /// `Terminal N` label and lose the one the user renamed).
    ///
    /// We reuse the `openXxxTab` actions rather than reconstructing inline
    /// because their focus + dedupe behaviour is wanted here too, but the
    /// popped value is captured first so it is not lost inside the produce.
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
          actions.openDiffTab(wtId, popped.filePath, popped.staged ?? false);
          break;
        case "compare": {
          const id = actions.openCompareTab(wtId, {
            baseRef: popped.baseRef,
            headRef: popped.headRef,
            useMergeBase: popped.useMergeBase,
            label: popped.label,
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
        case "terminal":
          // Async, and deliberately not awaited: the caller reports what came
          // back synchronously, and the pane appears when the PTY does.
          void actions.reopenTerminal(wtId, popped.label, popped.cwd);
          break;
        case "conflict":
          actions.openConflictTab(wtId, popped.filePath);
          break;
        case "preview":
          actions.openPreviewTab(wtId, popped.filePath);
          break;
        case "history":
          actions.openHistoryTab(wtId);
          break;
        case "combined":
          actions.openCombinedTab(wtId);
          break;
        case "timeline":
          actions.openTimelineTab(wtId);
          break;
        case "mission":
          actions.openMissionTab(wtId);
          break;
        case "browser": {
          const id = actions.openBrowserTab(wtId, popped.url);
          if (popped.title) actions.setBrowserTitle(wtId, id, popped.title);
          break;
        }
        case "agent":
          // The thread's transcript is keyed by the tab id that just went away,
          // so what comes back is a fresh thread with the same agent — the same
          // trade a reopened terminal makes with its scrollback.
          actions.openAgentTab(wtId, popped.agentId, popped.title);
          break;
      }
      return popped;
    },

    /// Spawn a terminal that keeps a closed one's label. `spawnTerminal`
    /// numbers its own (`Terminal 3`), which would quietly discard a rename on
    /// every reopen.
    async reopenTerminal(wtId: string, label: string, cwd: string): Promise<string | null> {
      const found = locateWorktree(wtId);
      const root = found?.worktree.path;
      if (!root) return null;
      let ptyId: string;
      try {
        ptyId = await terminalApi.createPty(root, lastGridSize() ?? undefined);
      } catch {
        return null;
      }
      const term: TerminalSession = {
        id: crypto.randomUUID(),
        ptyId,
        label,
        // The recorded cwd is kept for context; the shell itself is rooted in
        // the worktree, as every other spawn path is.
        cwd,
        restored: true,
      };
      setState(
        produce((s) => {
          s.terminalsByWorktree[wtId] = [...(s.terminalsByWorktree[wtId] ?? []), term];
          s.activeItemByWorktree[wtId] = { type: "terminal", id: term.id };
        }),
      );
      return term.id;
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
        recordClose(s, wtId, "conflict", arr[idx]);
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
        recordClose(s, wtId, "history", arr[idx]);
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

    // ── Combined-diff tab ───────────────────────────────────────────────
    /// Open the worktree's one "all changes" tab, focusing the existing one
    /// if it is already open. Repo-wide, so a second one would show the same
    /// thing twice.
    openCombinedTab(wtId: string) {
      const existing = (state.combinedTabsByWorktree[wtId] ?? [])[0];
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "combined", id: existing.id });
        return existing.id;
      }
      const tab: CombinedDiffTab = { id: crypto.randomUUID() };
      setState(produce((s) => {
        s.combinedTabsByWorktree[wtId] = [...(s.combinedTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "combined", id: tab.id };
      }));
      return tab.id;
    },

    closeCombinedTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.combinedTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        recordClose(s, wtId, "combined", arr[idx]);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "combined" && active.id === tabId) {
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = terms[0]
            ? { type: "terminal", id: terms[0].id }
            : null;
        }
      }));
    },

    selectCombinedTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "combined", id: tabId });
    },

    // ── Timeline (event log) tab ────────────────────────────────────────
    /// Open the Timeline tab for the workspace, focusing the existing one if
    /// present. A singleton for the same reason the commit graph is: it holds no per-tab
    /// state, so a second one would be an identical view of identical data.
    openTimelineTab(wtId: string) {
      const existing = (state.timelineTabsByWorktree[wtId] ?? [])[0];
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "timeline", id: existing.id });
        return existing.id;
      }
      const tab: TimelineTab = { id: crypto.randomUUID() };
      setState(produce((s) => {
        s.timelineTabsByWorktree[wtId] = [...(s.timelineTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "timeline", id: tab.id };
      }));
      return tab.id;
    },

    closeTimelineTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.timelineTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        recordClose(s, wtId, "timeline", arr[idx]);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "timeline" && active.id === tabId) {
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = terms[0]
            ? { type: "terminal", id: terms[0].id }
            : null;
        }
      }));
    },

    selectTimelineTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "timeline", id: tabId });
    },

    // ── Mission Control tab ─────────────────────────────────────────────
    /// Open Mission Control, focusing the existing one if present. A singleton
    /// like Timeline — and more emphatically so, because what it
    /// shows is not scoped to this worktree at all: two of them would be two
    /// identical views of every workspace.
    openMissionTab(wtId: string) {
      const existing = (state.missionTabsByWorktree[wtId] ?? [])[0];
      if (existing) {
        setState("activeItemByWorktree", wtId, { type: "mission", id: existing.id });
        return existing.id;
      }
      const tab: MissionTab = { id: crypto.randomUUID() };
      setState(produce((s) => {
        s.missionTabsByWorktree[wtId] = [...(s.missionTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "mission", id: tab.id };
      }));
      return tab.id;
    },

    closeMissionTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.missionTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        recordClose(s, wtId, "mission", arr[idx]);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "mission" && active.id === tabId) {
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = terms[0]
            ? { type: "terminal", id: terms[0].id }
            : null;
        }
      }));
    },

    selectMissionTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "mission", id: tabId });
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
        recordClose(s, wtId, "browser", arr[idx]);
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

    /// Remember a tab's page scale. The webview is what actually zooms; this
    /// only keeps it across a reload, and stores `undefined` for 1 so an
    /// unzoomed tab serializes to the same narrow blob it always did.
    setBrowserZoom(wtId: string, tabId: string, zoom: number) {
      setState(produce((s) => {
        const tab = (s.browserTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
        if (tab) tab.zoom = zoom === 1 ? undefined : zoom;
      }));
    },

    /// Record the title the page reported for itself. Drives the tab label.
    setBrowserTitle(wtId: string, tabId: string, title: string) {
      setState(produce((s) => {
        const tab = (s.browserTabsByWorktree[wtId] ?? []).find((t) => t.id === tabId);
        if (tab) tab.title = title.trim() || undefined;
      }));
    },

    // ── Agent tabs (AI threads) ─────────────────────────────────────────
    /// Open a new agent thread in the active pane group. Like a browser tab and
    /// unlike the singleton kinds, this never dedupes: two threads on the same
    /// roster entry are two conversations, and that is the normal case.
    ///
    /// `title` is the agent's display name snapshotted here, because the store
    /// cannot reach settings and the tab label has to say something.
    openAgentTab(wtId: string, agentId: string, title?: string) {
      const tab: AgentTab = { id: crypto.randomUUID(), agentId, title };
      setState(produce((s) => {
        s.agentTabsByWorktree[wtId] = [...(s.agentTabsByWorktree[wtId] ?? []), tab];
        s.activeItemByWorktree[wtId] = { type: "agent", id: tab.id };
      }));
      return tab.id;
    },

    closeAgentTab(wtId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.agentTabsByWorktree[wtId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        recordClose(s, wtId, "agent", arr[idx]);
        unpin(s, wtId, tabId);
        arr.splice(idx, 1);
        const active = s.activeItemByWorktree[wtId];
        if (active?.type === "agent" && active.id === tabId) {
          const nextAgent = arr[arr.length - 1];
          const terms = s.terminalsByWorktree[wtId] ?? [];
          s.activeItemByWorktree[wtId] = nextAgent
            ? { type: "agent", id: nextAgent.id }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectAgentTab(wtId: string, tabId: string) {
      setState("activeItemByWorktree", wtId, { type: "agent", id: tabId });
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
        recordClose(s, wtId, "preview", arr[idx]);
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
    /// Re-saving with the same name overwrites.
    ///
    /// Everything — the tabs, the pins, the active pointer and now the pane
    /// geometry — is written as a content key (`"kind:identifier"`), never as
    /// a tab id. A restore mints new ids, so ids captured here would name
    /// nothing by the time anyone restored them.
    saveWorkspaceSnapshot(wtId: string, name: string) {
      const trimmed = name.trim();
      if (!trimmed) return;

      const files = state.openFilesByWorktree[wtId] ?? [];
      const terminals = state.terminalsByWorktree[wtId] ?? [];
      const diffs = state.diffTabsByWorktree[wtId] ?? [];
      const compares = state.compareTabsByWorktree[wtId] ?? [];
      const stacks = state.stackTabsByWorktree[wtId] ?? [];
      const conflicts = state.conflictTabsByWorktree[wtId] ?? [];
      const previews = state.previewTabsByWorktree[wtId] ?? [];
      const browsers = state.browserTabsByWorktree[wtId] ?? [];
      const histories = state.historyTabsByWorktree[wtId] ?? [];
      const timelines = state.timelineTabsByWorktree[wtId] ?? [];
      const missions = state.missionTabsByWorktree[wtId] ?? [];
      const agents = state.agentTabsByWorktree[wtId] ?? [];

      /// tab id → content key, for every open tab. Built once and used three
      /// times: for the active pointer, for the pins, and for rewriting the
      /// pane tree's claims.
      ///
      /// Terminals, browser tabs and agent threads are keyed by *index* because
      /// none has a stable identity of its own — two shells in the same
      /// directory, two tabs on the same URL, or two threads with the same agent
      /// are all a normal thing to have open.
      const keyByTabId = new Map<string, string>();
      for (const f of files) keyByTabId.set(f.id, `file:${f.path}`);
      terminals.forEach((t, i) => keyByTabId.set(t.id, `terminal:${i}`));
      for (const d of diffs) keyByTabId.set(d.id, `diff:${d.filePath}`);
      for (const c of compares) keyByTabId.set(c.id, `compare:${c.baseRef}..${c.headRef}`);
      for (const s of stacks) keyByTabId.set(s.id, `stack:${s.topBranch}`);
      for (const c of conflicts) keyByTabId.set(c.id, `conflict:${c.filePath}`);
      for (const p of previews) keyByTabId.set(p.id, `preview:${p.filePath}`);
      browsers.forEach((b, i) => keyByTabId.set(b.id, `browser:${i}`));
      for (const c of state.combinedTabsByWorktree[wtId] ?? []) keyByTabId.set(c.id, "combined:");
      for (const h of histories) keyByTabId.set(h.id, "history:");
      agents.forEach((a, i) => keyByTabId.set(a.id, `agent:${i}`));

      // A snapshot spans both windows, so it records whichever pointer is set.
      // The workbench's wins when both are: it is the window you were looking
      // at when you typed the snapshot's name.
      const active =
        state.activeItemByWorktree[wtId] ?? state.editorActiveItemByWorktree[wtId];
      const activeKey = active ? (keyByTabId.get(active.id) ?? null) : null;

      const pinnedIds = new Set(state.pinnedTabsByWorktree[wtId] ?? []);
      const pinned = [...keyByTabId]
        .filter(([id]) => pinnedIds.has(id))
        .map(([, key]) => key);

      const layout = state.paneLayoutByWorktree[wtId];
      const panes = layout
        ? serializePaneLayout(mapPaneTabIds(layout, (id) => keyByTabId.get(id) ?? null))
        : null;

      const snap: WorkspaceSnapshot = {
        version: SNAPSHOT_VERSION,
        name: trimmed,
        savedAt: Date.now(),
        tabs: {
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
          conflicts: conflicts.map((c) => c.filePath),
          previews: previews.map((p) => p.filePath),
          browsers: browsers.map((b) => ({ url: b.url, title: b.title })),
          history: histories.length > 0,
          timeline: timelines.length > 0,
          combined: (state.combinedTabsByWorktree[wtId] ?? []).length > 0,
          mission: missions.length > 0,
          // The tab, not the conversation: a snapshot is a named arrangement of
          // panes, and restoring one into a transcript from another day would be
          // a stranger outcome than an empty thread on the right agent.
          agents: agents.map((a) => ({ agentId: a.agentId, title: a.title })),
        },
        panes,
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

    /// Replace the worktree's open-state with the snapshot named `name`.
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
        for (const kind of TAB_KINDS) {
          (s[TAB_SPECS[kind].stateKey] as Record<string, unknown[]>)[wtId] = [];
        }
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

      // Track new IDs by content key so we can re-pin, re-activate and
      // rebuild the pane geometry.
      const idByKey = new Map<string, string>();

      setState(produce((s) => {
        for (const path of snap.tabs.files) {
          const tab: OpenFileTab = { id: crypto.randomUUID(), path };
          s.openFilesByWorktree[wtId].push(tab);
          idByKey.set(`file:${path}`, tab.id);
        }
        for (const filePath of snap.tabs.diffs) {
          // Snapshots record diffs as bare paths, so which side of the index
          // was open is not in the format. Unstaged is the restore: it is the
          // view every snapshot written before `staged` existed was showing,
          // and widening the snapshot schema is a migration this does not need.
          const tab: DiffTab = { id: crypto.randomUUID(), filePath, staged: false };
          s.diffTabsByWorktree[wtId].push(tab);
          idByKey.set(`diff:${filePath}`, tab.id);
        }
        for (const filePath of snap.tabs.conflicts) {
          const tab: ConflictTab = { id: crypto.randomUUID(), filePath };
          s.conflictTabsByWorktree[wtId].push(tab);
          idByKey.set(`conflict:${filePath}`, tab.id);
        }
        for (const filePath of snap.tabs.previews) {
          const tab: PreviewTab = { id: crypto.randomUUID(), filePath };
          s.previewTabsByWorktree[wtId].push(tab);
          idByKey.set(`preview:${filePath}`, tab.id);
        }
        for (const c of snap.tabs.compares) {
          const tab: CompareTab = {
            id: crypto.randomUUID(),
            baseRef: c.baseRef,
            headRef: c.headRef,
            useMergeBase: c.useMergeBase,
            selectedFilePath: c.selectedFilePath,
            treeMode: c.treeMode,
            treeFilter: c.treeFilter,
            treeWidth: COMPARE_TREE_WIDTH_DEFAULT,
          };
          s.compareTabsByWorktree[wtId].push(tab);
          idByKey.set(`compare:${c.baseRef}..${c.headRef}`, tab.id);
        }
        for (const st of snap.tabs.stacks) {
          const tab: StackTab = {
            id: crypto.randomUUID(),
            trunk: st.trunk,
            topBranch: st.topBranch,
          };
          s.stackTabsByWorktree[wtId].push(tab);
          idByKey.set(`stack:${st.topBranch}`, tab.id);
        }
        snap.tabs.browsers.forEach((b, i) => {
          const tab: BrowserTab = { id: crypto.randomUUID(), url: b.url, title: b.title };
          s.browserTabsByWorktree[wtId].push(tab);
          idByKey.set(`browser:${i}`, tab.id);
        });
        if (snap.tabs.history) {
          const tab: HistoryTab = { id: crypto.randomUUID() };
          s.historyTabsByWorktree[wtId].push(tab);
          idByKey.set("history:", tab.id);
        }
        if (snap.tabs.combined) {
          const tab: CombinedDiffTab = { id: crypto.randomUUID() };
          s.combinedTabsByWorktree[wtId].push(tab);
          idByKey.set("combined:", tab.id);
        }
        if (snap.tabs.timeline) {
          const tab: TimelineTab = { id: crypto.randomUUID() };
          s.timelineTabsByWorktree[wtId].push(tab);
          idByKey.set("timeline:", tab.id);
        }
        if (snap.tabs.mission) {
          const tab: MissionTab = { id: crypto.randomUUID() };
          s.missionTabsByWorktree[wtId].push(tab);
          idByKey.set("mission:", tab.id);
        }
        snap.tabs.agents.forEach((a, i) => {
          const tab: AgentTab = {
            id: crypto.randomUUID(),
            agentId: a.agentId,
            title: a.title,
          };
          s.agentTabsByWorktree[wtId].push(tab);
          idByKey.set(`agent:${i}`, tab.id);
        });
      }));

      // Terminals come last because the spawn is async. We don't await
      // each spawn individually — the UI surface is already responsive
      // for everything else, and a failed PTY spawn just leaves an
      // unrestored terminal slot.
      const cwd = locateWorktree(wtId)?.worktree.path;
      if (cwd) {
        for (let i = 0; i < snap.tabs.terminals.length; i++) {
          const t = snap.tabs.terminals[i];
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
                // A restored terminal is a fresh shell, whether it came back
                // from a snapshot or from a reload.
                restored: true,
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

      // Rebuild the pane geometry, translating claims back from content keys
      // to the ids just minted. A snapshot from before pane groups (v1) has no
      // geometry and lands in the single-group default, which is the layout it
      // was taken in.
      const savedPanes = snap.panes ? parsePaneLayout(snap.panes) : null;
      setState(
        "paneLayoutByWorktree",
        wtId,
        savedPanes
          ? mapPaneTabIds(savedPanes, (key) => idByKey.get(key) ?? null)
          : singleGroupLayout(),
      );
      setState("focusedGroupByWorktree", wtId, null);

      // Re-activate by content key. If the original active tab didn't
      // round-trip (deleted file / removed branch), default to the
      // first restored tab in render order.
      const activeId = snap.active ? idByKey.get(snap.active) : null;
      const restored: ActiveItem | null =
        activeId && snap.active
          ? buildActiveItem(snap.active.split(":")[0], activeId, {
              files: state.openFilesByWorktree[wtId] ?? [],
              previews: state.previewTabsByWorktree[wtId] ?? [],
            })
          : null;

      // Each window gets the first tab it can actually show, and the restored
      // item overrides whichever of the two owns its kind. Setting both is what
      // stops a snapshot whose active tab was a file from leaving the workbench
      // pointing at nothing.
      const firstTerm = state.terminalsByWorktree[wtId]?.[0];
      const firstCompare = state.compareTabsByWorktree[wtId]?.[0];
      const firstStack = state.stackTabsByWorktree[wtId]?.[0];
      const firstBrowser = state.browserTabsByWorktree[wtId]?.[0];
      const firstHistory = state.historyTabsByWorktree[wtId]?.[0];
      const mainFallback: ActiveItem | null = firstTerm
        ? { type: "terminal", id: firstTerm.id }
        : firstCompare
          ? { type: "compare", id: firstCompare.id }
          : firstStack
            ? { type: "stack", id: firstStack.id }
            : firstBrowser
              ? { type: "browser", id: firstBrowser.id }
              : firstHistory
                ? { type: "history", id: firstHistory.id }
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

  // Session restore's one asynchronous step, kicked off after the store is
  // fully composed. Fire-and-forget: the shell renders now and the terminal
  // panes appear as their PTYs come up.
  if (persist) void restoreTerminalSessions();

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
    activeTimelineTabs,
    activeCombinedTabs,
    activeMissionTabs,
    activeBrowserTabs,
    activeAgentTabs,
    activeItem,
    editorActiveItem,
    workbenchTabIds,
    paneLayout,
    focusedGroupId,
    focusedGroupMru,
    navHistory,
    canGoBack,
    canGoForward,
    activeClosedTabs,
    activePinnedTabs,
    actions,
  } as const;
}

export type AppStore = ReturnType<typeof createAppStore>;
