/// The shell's global UI preferences: which sidebars are collapsed, which git
/// tab is showing, how diffs are rendered, which sections are open.
///
/// These are *not* per worktree. Collapsing the git sidebar in one worktree and
/// having it spring back when you switch is the behaviour nobody wants, so they
/// live at the top of the store and in one storage key.
import { STORAGE_KEYS, readJson, writeJson } from "./persistence";

export type DiffMode = "inline" | "split";
export type GitTab = "changes" | "branches" | "history";
export type SidebarTab = "files" | "terminals";

export interface GitSections {
  changes: boolean;
  branches: boolean;
  worktrees: boolean;
  stack: boolean;
  stashes: boolean;
  history: boolean;
  openedDiffs: boolean;
}

export interface SidebarSections {
  files: boolean;
  terminals: boolean;
}

/// The three resizable columns of the shell, in px.
///
/// These lived in `createSignal` inside `WorkspaceRail`, `TerminalSidebar` and
/// `GitSidebar`, which meant every reload — and, in stacked mode, every switch
/// away from the workbench view and back — threw the user's layout away. They
/// are geometry, not view state, so they belong to the store.
export interface PanelWidths {
  rail: number;
  sidebar: number;
  gitSidebar: number;
}

export type PanelId = keyof PanelWidths;

/// Bounds and defaults, moved here from the three components so the clamp that
/// `<Splitter>` applies and the clamp that hydration applies are the same one.
export const PANEL_BOUNDS: Record<PanelId, { min: number; max: number; default: number }> = {
  rail: { min: 160, max: 380, default: 212 },
  sidebar: { min: 180, max: 520, default: 256 },
  gitSidebar: { min: 220, max: 600, default: 320 },
};

export interface UiPrefs {
  panels: PanelWidths;
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  sidebarsSwapped: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: GitSections;
  sidebarSections: SidebarSections;
}

/// Today's spacing is the default (MASTER §5 and the workbench prompt's
/// assumption list). Kept here so Wave 5's density preference has a home that
/// is already persisted rather than needing a new key.
export const DEFAULT_PREFS: UiPrefs = {
  panels: {
    rail: PANEL_BOUNDS.rail.default,
    sidebar: PANEL_BOUNDS.sidebar.default,
    gitSidebar: PANEL_BOUNDS.gitSidebar.default,
  },
  gitSidebarCollapsed: false,
  leftSidebarCollapsed: false,
  sidebarsSwapped: false,
  diffMode: "inline",
  gitTab: "changes",
  ignoreWhitespace: false,
  sidebarTab: "terminals",
  gitSections: {
    changes: true,
    branches: true,
    worktrees: false,
    stack: true,
    stashes: false,
    history: true,
    openedDiffs: true,
  },
  sidebarSections: { files: true, terminals: true },
};

/// Field-by-field so a blob written by an older (or newer) build cannot
/// introduce a value the UI has no branch for — `diffMode: "sidebyside"` would
/// render nothing at all.
export function parsePrefs(parsed: Partial<UiPrefs> | null): UiPrefs {
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PREFS };
  const d = DEFAULT_PREFS;
  return {
    panels: parsePanelWidths(parsed.panels),
    gitSidebarCollapsed: parsed.gitSidebarCollapsed ?? d.gitSidebarCollapsed,
    leftSidebarCollapsed: parsed.leftSidebarCollapsed ?? d.leftSidebarCollapsed,
    sidebarsSwapped: parsed.sidebarsSwapped ?? d.sidebarsSwapped,
    diffMode: parsed.diffMode === "split" ? "split" : "inline",
    gitTab:
      parsed.gitTab === "branches" || parsed.gitTab === "history"
        ? parsed.gitTab
        : "changes",
    ignoreWhitespace: parsed.ignoreWhitespace ?? d.ignoreWhitespace,
    sidebarTab: parsed.sidebarTab === "files" ? "files" : "terminals",
    gitSections: {
      changes: parsed.gitSections?.changes ?? d.gitSections.changes,
      branches: parsed.gitSections?.branches ?? d.gitSections.branches,
      worktrees: parsed.gitSections?.worktrees ?? d.gitSections.worktrees,
      stack: parsed.gitSections?.stack ?? d.gitSections.stack,
      stashes: parsed.gitSections?.stashes ?? d.gitSections.stashes,
      history: parsed.gitSections?.history ?? d.gitSections.history,
      openedDiffs: parsed.gitSections?.openedDiffs ?? d.gitSections.openedDiffs,
    },
    sidebarSections: {
      files: parsed.sidebarSections?.files ?? d.sidebarSections.files,
      terminals: parsed.sidebarSections?.terminals ?? d.sidebarSections.terminals,
    },
  };
}

/// Clamp on the way in as well as on the way out. A width persisted by a build
/// with different bounds — or hand-edited — must not be able to render a 4000px
/// rail that leaves no room for the workbench and no handle to drag back.
export function clampPanelWidth(panel: PanelId, value: number): number {
  const { min, max, default: fallback } = PANEL_BOUNDS[panel];
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parsePanelWidths(raw: Partial<PanelWidths> | undefined): PanelWidths {
  return {
    rail: clampPanelWidth("rail", raw?.rail ?? PANEL_BOUNDS.rail.default),
    sidebar: clampPanelWidth("sidebar", raw?.sidebar ?? PANEL_BOUNDS.sidebar.default),
    gitSidebar: clampPanelWidth(
      "gitSidebar",
      raw?.gitSidebar ?? PANEL_BOUNDS.gitSidebar.default,
    ),
  };
}

export function loadPrefs(): UiPrefs {
  return parsePrefs(readJson<Partial<UiPrefs> | null>(STORAGE_KEYS.gitPrefs, null));
}

export function persistPrefs(prefs: UiPrefs): void {
  writeJson(STORAGE_KEYS.gitPrefs, prefs);
}
