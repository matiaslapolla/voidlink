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

export interface UiPrefs {
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

export function loadPrefs(): UiPrefs {
  return parsePrefs(readJson<Partial<UiPrefs> | null>(STORAGE_KEYS.gitPrefs, null));
}

export function persistPrefs(prefs: UiPrefs): void {
  writeJson(STORAGE_KEYS.gitPrefs, prefs);
}
