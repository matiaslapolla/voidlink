/// The store's state shape, and the two operations that keep it consistent
/// when a worktree appears or disappears.
///
/// Split out of `index.ts` so `workspaces.ts` can type its context without
/// importing the module that composes it. The field names are byte-for-byte
/// what `layout.ts` had — they are read directly by ~40 components and by
/// `layout.test.ts`, and the decomposition is not allowed to move them.
import type { TerminalSession, Workspace } from "@/types/workspace";
import { TAB_KINDS, TAB_SPECS } from "./tabs";
import { singleGroupLayout, type PaneNode } from "./panes";
import { emptyTabGroupState, type TabGroupState } from "./tabGroups";
import { emptyNavHistory, type GroupMru, type NavHistory } from "./navigation";
import type {
  ActiveItem,
  AgentTab,
  CombinedDiffTab,
  TimelineTab,
  MissionTab,
  BrowserTab,
  ClosedTab,
  CompareTab,
  ConflictTab,
  DiffTab,
  HistoryTab,
  OpenFileTab,
  PaneGroupTab,
  PreviewTab,
  StackTab,
  TabCollectionKey,
} from "./tabs";
import type { TabGroupColor } from "./tabGroups";
import type { DockSide, SidebarId } from "./dock";
import type {
  GitSectionKey,
  GitSections,
  SidebarSections,
  DiffMode,
  GitTab,
  PanelWidths,
  SidebarTab,
} from "./prefs";

export interface AppStoreState {
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
  timelineTabsByWorktree: Record<string, TimelineTab[]>;
  combinedTabsByWorktree: Record<string, CombinedDiffTab[]>;
  missionTabsByWorktree: Record<string, MissionTab[]>;
  browserTabsByWorktree: Record<string, BrowserTab[]>;
  /// AI agent threads, several per worktree. The tabs only; each thread's
  /// transcript lives under `STORAGE_KEYS.agentThreads` keyed by tab id, because
  /// a conversation is far larger than a tab and is written far more often.
  agentTabsByWorktree: Record<string, AgentTab[]>;
  /// Split panes, as tabs — each payload its own nested `PaneNode`. See
  /// `PaneGroupTab`'s header for the one-level-of-nesting rule.
  panegroupTabsByWorktree: Record<string, PaneGroupTab[]>;
  /// A tab's custom label, keyed by tab id. Absent (no entry) means "use the
  /// kind's derived label" — `TAB_SPECS[kind].label(tab)` — which is also
  /// what clearing a rename restores it to. Not part of any kind's own tab
  /// shape: every kind gets renaming for free this way, rather than each
  /// carrying an optional `label` field with its own restore/clear rules.
  tabLabelByWorktree: Record<string, Record<string, string>>;
  /// A tab's custom label colour, keyed by tab id, the same shape and the
  /// same reasoning as `tabLabelByWorktree` above. Absent means unstyled —
  /// the default tab chrome, not `DEFAULT_TAB_GROUP_COLOR` — so a tab nobody
  /// ever coloured persists nothing extra at all.
  tabColorByWorktree: Record<string, Record<string, TabGroupColor>>;
  /// LIFO stack of recently closed tabs, capped at CLOSED_TAB_HISTORY_LIMIT.
  /// Persisted since Wave 4 (`voidlink-closed-tabs`): the tab you closed by
  /// accident five minutes before a reload is the same mistake on either side
  /// of it, and every kind can be reopened now rather than four of them.
  closedTabsByWorktree: Record<string, ClosedTab[]>;
  /// Pinned tab IDs per worktree; pins survive close-all-others actions
  /// and render leftmost in the tab strip.
  pinnedTabsByWorktree: Record<string, string[]>;
  /// Which tab is in front *in the workbench* — terminals, compares, stacks,
  /// the commit graph, browser and agent tabs.
  activeItemByWorktree: Record<string, ActiveItem | null>;
  /// Which tab is in front *in the editor window* — files, diffs, conflicts and
  /// previews. Two pointers rather than one because the windows focus
  /// independently: clicking a file in the editor must not blank out the
  /// terminal the user is watching in the workbench, and vice versa.
  editorActiveItemByWorktree: Record<string, ActiveItem | null>;
  /// The split tree per worktree: 1-4 tab groups. The default — one group
  /// claiming nothing — resolves to today's single-strip workbench, so a
  /// worktree that has never been split needs no saved geometry at all.
  paneLayoutByWorktree: Record<string, PaneNode>;
  /// The labelled, collapsible tab groups inside each pane group's strip, per
  /// worktree, plus that worktree's auto-grouping mode. A *second axis* over
  /// the pane tree, not part of it: a tab in no tab group renders exactly as it
  /// did before groups existed, so a worktree that never groups anything keeps
  /// an empty state here forever.
  tabGroupsByWorktree: Record<string, TabGroupState>;
  /// Per-group most-recently-used tab order, per worktree. `Ctrl+Tab` cycles
  /// this; `tab.next` / `tab.prev` deliberately do not — document order and
  /// recency are two different questions and both have their users.
  tabMruByWorktree: Record<string, GroupMru>;
  /// Back/forward across (group, tab, line), per worktree.
  navHistoryByWorktree: Record<string, NavHistory>;
  /// Which group has keyboard focus, per worktree. `null` means the first.
  /// Persisted with the geometry: coming back to a split worktree and landing
  /// in a different pane than you left is disorienting.
  focusedGroupByWorktree: Record<string, string | null>;
  /// Width of each resizable column, in px. Persisted, so a reload comes back
  /// to the layout the user dragged rather than to the defaults.
  panels: PanelWidths;
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  workspaceRailCollapsed: boolean;
  /// Which edge each sidebar is docked to, the screen order they render in, and
  /// which of them are in a window of their own. See `store/layout/dock.ts`.
  dockSide: Record<SidebarId, DockSide>;
  dockOrder: SidebarId[];
  detachedSidebars: SidebarId[];
  /// Workspace ids handed off to a window of their own. The rail draws these as
  /// "over there" rather than as selectable rows, and `main` renders none of
  /// their tabs — see `commands/workspaceWindows.ts` for why the rule is
  /// hand-off and not mirroring.
  detachedWorkspaces: string[];
  diffMode: DiffMode;
  diffLineNumbers: boolean;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: GitSections;
  gitSectionOrder: GitSectionKey[];
  sidebarSections: SidebarSections;
  collapsedWorkspaces: string[];
  /// Workspace ids whose rail labels are blurred for screencasts. See
  /// `UiPrefs.blurredWorkspaces` in `prefs.ts`.
  blurredWorkspaces: string[];
}

/// Compile-time proof that every `stateKey` a registry spec names is a real
/// field on the state. Without it, a typo in `tabs.ts` would be a runtime
/// `undefined[wtId] = []` on the first worktree that appears.
type _AssertTabKeysExist = TabCollectionKey extends keyof AppStoreState ? true : never;
const _assertTabKeysExist: _AssertTabKeysExist = true;
void _assertTabKeysExist;

export const CLOSED_TAB_HISTORY_LIMIT = 50;

/// Create the (empty) tab collections a worktree needs. Called from every
/// path that introduces a worktree id — workspace creation, wizard, and
/// hydration — so no collection lookup ever has to invent a default.
///
/// Registry-driven: a new tab kind is seeded by adding its spec, not by
/// remembering to add a line here.
export function seedWorktreeCollections(s: AppStoreState, wtId: string) {
  for (const kind of TAB_KINDS) {
    const bucket = s[TAB_SPECS[kind].stateKey] as Record<string, unknown[]>;
    bucket[wtId] ??= [];
  }
  s.closedTabsByWorktree[wtId] ??= [];
  s.pinnedTabsByWorktree[wtId] ??= [];
  s.tabLabelByWorktree[wtId] ??= {};
  s.tabColorByWorktree[wtId] ??= {};
  s.paneLayoutByWorktree[wtId] ??= singleGroupLayout();
  s.tabGroupsByWorktree[wtId] ??= emptyTabGroupState();
  s.tabMruByWorktree[wtId] ??= {};
  s.navHistoryByWorktree[wtId] ??= emptyNavHistory();
  if (!(wtId in s.focusedGroupByWorktree)) s.focusedGroupByWorktree[wtId] = null;
  if (!(wtId in s.activeItemByWorktree)) s.activeItemByWorktree[wtId] = null;
  if (!(wtId in s.editorActiveItemByWorktree)) s.editorActiveItemByWorktree[wtId] = null;
}

/// Drop everything keyed by a worktree id. The caller is responsible for
/// killing that worktree's PTYs first — this only touches store state.
export function dropWorktreeCollections(s: AppStoreState, wtId: string) {
  for (const kind of TAB_KINDS) {
    const bucket = s[TAB_SPECS[kind].stateKey] as Record<string, unknown[]>;
    delete bucket[wtId];
  }
  delete s.closedTabsByWorktree[wtId];
  delete s.pinnedTabsByWorktree[wtId];
  delete s.tabLabelByWorktree[wtId];
  delete s.tabColorByWorktree[wtId];
  delete s.paneLayoutByWorktree[wtId];
  delete s.tabGroupsByWorktree[wtId];
  delete s.tabMruByWorktree[wtId];
  delete s.navHistoryByWorktree[wtId];
  delete s.focusedGroupByWorktree[wtId];
  delete s.activeItemByWorktree[wtId];
  delete s.editorActiveItemByWorktree[wtId];
}
