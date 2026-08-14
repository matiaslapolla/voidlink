/// The shell's global UI preferences: which sidebars are collapsed, which git
/// tab is showing, how diffs are rendered, which sections are open.
///
/// These are *not* per worktree. Collapsing the git sidebar in one worktree and
/// having it spring back when you switch is the behaviour nobody wants, so they
/// live at the top of the store and in one storage key.
import { STORAGE_KEYS, readJson, writeJson } from "./persistence";
import { DEFAULT_SPLIT_FRACTION, clampFraction } from "@/components/editor/editorGroups";
import {
  parseDetachedSidebars,
  parseDockOrder,
  parseDockSide,
  parseDockStripSide,
  DEFAULT_DOCK_ORDER,
  DEFAULT_DOCK_SIDE,
  DEFAULT_DOCK_STRIP_SIDE,
  type DockSide,
  type SidebarId,
} from "./dock";

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

export type GitSectionKey = keyof GitSections;

/// The git sidebar's sections in their shipped order, and the only keys a
/// persisted order is allowed to contain. Also the fallback: a saved order
/// written by an older build is repaired against this list rather than
/// rejected, so adding a section here makes it appear at the bottom of every
/// existing user's sidebar instead of nowhere.
export const GIT_SECTION_KEYS: GitSectionKey[] = [
  "changes",
  "branches",
  "worktrees",
  "stack",
  "stashes",
  "history",
  "openedDiffs",
];

/// The left sidebar's two disclosures.
///
/// `files` is the file explorer's expanded/collapsed state and it is global on
/// purpose (see this file's header): collapsing the explorer in one worktree
/// and having it spring back on the next switch is the behaviour nobody wants.
///
/// It means slightly different things in the explorer's two homes, because the
/// axis it reclaims differs. In the left sidebar it collapses the *panel* to a
/// `SIDEBAR_RAIL_WIDTH` icon rail, so the width goes back to the workbench; in
/// the right column (vertical tabs) the column's width belongs to the git
/// panel, so it reclaims the vertical space instead. One flag either way — two
/// would be two things to keep in step for one user intent.
export interface SidebarSections {
  files: boolean;
  terminals: boolean;
  /// The Agent Dashboard's disclosure. Persisted like the other two even
  /// though the section only exists behind `experimental.agentDashboard` —
  /// the preference is about the *section*, and losing it every time the flag
  /// is toggled would make the experiment more annoying than the feature.
  agents: boolean;
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
  /// Width of the terminals sidebar, now that it is a dockable panel of its
  /// own rather than a section stacked under the explorer.
  terminalsSidebar: number;
  /// Width of the agent dashboard sidebar, for the same reason.
  agentsSidebar: number;
  /// Height of the left sidebar's Terminals disclosure, in px, while it and
  /// the Files section above it are both open. The list's `max-h-52` used to
  /// be a constant; it is now the same kind of persisted extent as the three
  /// widths above, resized by the handle on the Files/Terminals seam.
  ///
  /// Dead now that `TerminalsSidebar` is its own full-height column rather
  /// than a section stacked inside `TerminalSidebar`, and kept rather than
  /// removed: it is a persisted key, and dropping it would not free anything
  /// — an old blob still has it — while removing the field here would just be
  /// one more migration to write for a value nothing reads. See MASTER.md.
  sidebarTerminalsHeight: number;
  /// Height of the left sidebar's Agent Dashboard disclosure, in px, while it
  /// and Terminals are both open. Only ever read while
  /// `experimental.agentDashboard` is on, like the section itself. Dead for
  /// the same reason `sidebarTerminalsHeight` is — `AgentsSidebar` is its own
  /// column now.
  sidebarAgentsHeight: number;
}

export type PanelId = keyof PanelWidths;

/// Bounds and defaults, moved here from the three components so the clamp that
/// `<Splitter>` applies and the clamp that hydration applies are the same one.
export const PANEL_BOUNDS: Record<PanelId, { min: number; max: number; default: number }> = {
  rail: { min: 160, max: 380, default: 212 },
  sidebar: { min: 180, max: 520, default: 256 },
  gitSidebar: { min: 220, max: 600, default: 320 },
  // Same bounds as `sidebar` — the three left-edge column panels (explorer,
  // terminals, agents) are the same kind of thing at a different edge slot.
  terminalsSidebar: { min: 180, max: 520, default: 256 },
  agentsSidebar: { min: 180, max: 520, default: 256 },
  sidebarTerminalsHeight: { min: 80, max: 400, default: 208 }, // 208px = the old `max-h-52`.
  sidebarAgentsHeight: { min: 100, max: 480, default: 256 }, // 256px = the old `max-h-64`.
};

/// Width of a sidebar that has been collapsed to its icon rail, in px.
///
/// Beside `PANEL_BOUNDS` rather than in it, because it is not a *bound*: a rail
/// has no min, no max and nothing to drag. It is the one width the panel takes
/// while the user has asked for the space back, and it matches the git
/// sidebar's collapsed rail (`GitSidebarCollapsed`, `w-8`) so the shell has one
/// rail idiom rather than two.
///
/// Deliberately **not** written into `panels.sidebar` on collapse. That field
/// keeps holding the width the user last dragged to, which is what makes
/// expanding restore *their* width instead of the default — the pre-collapse
/// width is persisted because it was never overwritten, not because a second
/// key shadows it. A collapsed panel has no splitter to change it either (the
/// handle is rendered disabled, §7.6), so the value cannot drift while it is
/// out of view.
export const SIDEBAR_RAIL_WIDTH = 32;

/// Which `PanelWidths` key each sidebar's width lives in. The widths predate
/// the dock model and are keyed by what the panel *is*, not by where it sits —
/// which is the point: moving a panel across the window must not lose the width
/// the user dragged it to.
export const SIDEBAR_PANEL: Record<SidebarId, PanelId> = {
  workspaces: "rail",
  explorer: "sidebar",
  terminals: "terminalsSidebar",
  git: "gitSidebar",
  agents: "agentsSidebar",
};

export interface UiPrefs {
  panels: PanelWidths;
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  /// The workspace rail's collapse, beside the other two sidebars' rather than
  /// inside `collapsedWorkspaces` — that list is which *workspaces* have their
  /// worktrees folded away, and this is whether the panel listing them is a
  /// `SIDEBAR_RAIL_WIDTH` icon rail.
  workspaceRailCollapsed: boolean;
  /// Which edge each sidebar is docked to. Replaces `sidebarsSwapped`; see
  /// `dock.ts` for the model and the migration.
  dockSide: Record<SidebarId, DockSide>;
  /// Every sidebar in screen order, left to right, across both edges.
  dockOrder: SidebarId[];
  /// Which edge the dock strip is pinned to under `environmentMode: "docked"`.
  ///
  /// One global preference and not one per workspace: the strip is where the
  /// user's hand goes, and a dock that jumped edges when you switched project
  /// would be a worse affordance than one on the wrong side.
  ///
  /// Persisted here rather than beside `environmentMode` in the settings blob
  /// for the same reason `dockOrder` is: it is *geometry*, it is written by
  /// exactly one window, and "Reset layout" should take it back to the default
  /// along with the panel widths and the arrangement it belongs to. It survives
  /// a round trip through another mode untouched — nothing outside docked mode
  /// reads or writes it, so switching to stacked and back returns the strip to
  /// the edge it was left on.
  dockStripSide: DockSide;
  /// The sidebars living in their own window right now. Persisted so a relaunch
  /// reopens them rather than silently pulling them back into the shell.
  detachedSidebars: SidebarId[];
  /// Workspace ids that have been handed off to a window of their own. Persisted
  /// for the same reason `detachedSidebars` is — a relaunch reopens the window
  /// rather than quietly pulling the workspace back — and unvalidated against the
  /// workspace list here for the same reason `collapsedWorkspaces` is: prefs are
  /// parsed before the workspaces are. Boot reconciliation in
  /// `commands/workspaceWindows.ts` is what drops an id that no longer names a
  /// workspace.
  detachedWorkspaces: string[];
  diffMode: DiffMode;
  /// Whether the hunk renderer prints old/new line numbers in its gutters.
  ///
  /// Global rather than per worktree for the same reason `diffMode` is: it is a
  /// statement about how you read diffs, and having it flip back when you
  /// switch worktree is the behaviour nobody wants.
  diffLineNumbers: boolean;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
  gitSections: GitSections;
  /// The order the git sidebar's sections render in. A user who never looks at
  /// worktrees should be able to put them at the bottom rather than scrolling
  /// past them forever.
  gitSectionOrder: GitSectionKey[];
  sidebarSections: SidebarSections;
  /// Workspace ids whose worktree list is collapsed in the rail.
  ///
  /// This lived in a `createSignal<Set<string>>` inside `WorkspaceRail`, which
  /// made it the one collapse in the shell that sprang back — on every reload,
  /// and in stacked mode on every switch away from the workbench and back. A
  /// user with six workspaces collapses five of them precisely so the sixth is
  /// readable, and re-doing that on each boot is the behaviour this file's
  /// header says nobody wants.
  ///
  /// An **array**, not a `Set`, because it is persisted: `JSON.stringify` of a
  /// `Set` is `{}`, which would have quietly written the collapse away every
  /// time while looking like it worked. The rail rebuilds the `Set` it queries.
  ///
  /// Keyed by workspace and global like the rest of this record — a workspace
  /// row is the same row whichever worktree is in front of it.
  collapsedWorkspaces: string[];
  /// Workspace ids whose name and worktree labels are blurred in the rail —
  /// the screencast-privacy toggle. Same shape as `collapsedWorkspaces` and for
  /// the same reason: an array, not a `Set`, because `JSON.stringify` of a
  /// `Set` is `{}` and would have silently dropped every blur on the next
  /// write while looking like it worked. The rail rebuilds the `Set` it
  /// queries.
  blurredWorkspaces: string[];
}

/// Today's spacing is the default (MASTER §5 and the workbench prompt's
/// assumption list). Kept here so Wave 5's density preference has a home that
/// is already persisted rather than needing a new key.
export const DEFAULT_PREFS: UiPrefs = {
  panels: {
    rail: PANEL_BOUNDS.rail.default,
    sidebar: PANEL_BOUNDS.sidebar.default,
    gitSidebar: PANEL_BOUNDS.gitSidebar.default,
    terminalsSidebar: PANEL_BOUNDS.terminalsSidebar.default,
    agentsSidebar: PANEL_BOUNDS.agentsSidebar.default,
    sidebarTerminalsHeight: PANEL_BOUNDS.sidebarTerminalsHeight.default,
    sidebarAgentsHeight: PANEL_BOUNDS.sidebarAgentsHeight.default,
  },
  gitSidebarCollapsed: false,
  leftSidebarCollapsed: false,
  workspaceRailCollapsed: false,
  dockSide: { ...DEFAULT_DOCK_SIDE },
  dockOrder: [...DEFAULT_DOCK_ORDER],
  dockStripSide: DEFAULT_DOCK_STRIP_SIDE,
  detachedSidebars: [],
  detachedWorkspaces: [],
  diffMode: "inline",
  diffLineNumbers: true,
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
  gitSectionOrder: [...GIT_SECTION_KEYS],
  sidebarSections: { files: true, terminals: true, agents: true },
  collapsedWorkspaces: [],
  blurredWorkspaces: [],
};

/// Repair a persisted section order: drop keys this build doesn't know, drop
/// duplicates, and append anything missing in its shipped position. Never
/// throws away the user's arrangement over an unknown key — a blob written by
/// a newer build that added a section must still order the ones it shares.
export function parseGitSectionOrder(raw: unknown): GitSectionKey[] {
  const known = new Set<string>(GIT_SECTION_KEYS);
  const seen = new Set<string>();
  const out: GitSectionKey[] = [];
  if (Array.isArray(raw)) {
    for (const key of raw) {
      if (typeof key !== "string" || !known.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(key as GitSectionKey);
    }
  }
  for (const key of GIT_SECTION_KEYS) if (!seen.has(key)) out.push(key);
  return out;
}

/// What a blob read back off disk may actually look like.
///
/// `Partial<UiPrefs>` was too strong, and in a way only a merge could expose:
/// `Partial` is shallow, so it says the *nested* records are absent-or-complete.
/// A build that adds a key to `SidebarSections` — as the Agent Dashboard's
/// `agents` did — instantly makes every blob written by every older build
/// ill-typed, which is precisely the case this function exists to absorb. The
/// nested records are restated as partials so the type says what the parser has
/// always done: every field is independently optional, at every level.
///
/// `gitSectionOrder` stays a whole array. A partial array is a different and
/// worse claim (`(GitSectionKey | undefined)[]`), and `parseGitSectionOrder`
/// already validates it element by element.
type PersistedPrefs = Omit<
  Partial<UiPrefs>,
  "panels" | "gitSections" | "sidebarSections" | "dockSide"
> & {
  panels?: Partial<PanelWidths>;
  gitSections?: Partial<GitSections>;
  sidebarSections?: Partial<SidebarSections>;
  dockSide?: Partial<Record<SidebarId, DockSide>>;
  /// Gone from `UiPrefs` since the dock model landed, and still declared here
  /// because every blob written before it has one. `parseDockSide` reads it as
  /// the fallback arrangement and nothing writes it again, so it ages out of a
  /// user's storage on their first layout change.
  sidebarsSwapped?: boolean;
};

/// Field-by-field so a blob written by an older (or newer) build cannot
/// introduce a value the UI has no branch for — `diffMode: "sidebyside"` would
/// render nothing at all.
///
/// A missing blob takes the same path rather than a `{ ...DEFAULT_PREFS }`
/// shortcut, because that spread was *shallow*: `panels`, `gitSections` and
/// `sidebarSections` came back as the very objects hanging off the module-level
/// `DEFAULT_PREFS`, and `createStore` mutates what it is given. A first run —
/// exactly the case the shortcut existed for — therefore wrote every panel
/// resize and every section toggle straight into the defaults, so "the default
/// layout" became whatever the last store to touch it had done. One window
/// hides it; two stores in one process (the render tests, and stacked mode's
/// second store) do not.
export function parsePrefs(parsed: PersistedPrefs | null): UiPrefs {
  if (!parsed || typeof parsed !== "object") parsed = {};
  const d = DEFAULT_PREFS;
  return {
    panels: parsePanelWidths(parsed.panels),
    gitSidebarCollapsed: parsed.gitSidebarCollapsed ?? d.gitSidebarCollapsed,
    leftSidebarCollapsed: parsed.leftSidebarCollapsed ?? d.leftSidebarCollapsed,
    workspaceRailCollapsed: parsed.workspaceRailCollapsed ?? d.workspaceRailCollapsed,
    // The one migration: `sidebarsSwapped` is consulted only when there is no
    // `dockSide` to read, so hydrating a blob this build wrote is a no-op no
    // matter how many times it happens.
    dockSide: parseDockSide(parsed.dockSide, parsed.sidebarsSwapped),
    dockOrder: parseDockOrder(parsed.dockOrder),
    dockStripSide: parseDockStripSide(parsed.dockStripSide),
    detachedSidebars: parseDetachedSidebars(parsed.detachedSidebars),
    // Deduplicated strings and nothing more. There is no allowlist to repair
    // against — a workspace id is user data, not one of five known names — so
    // the check that matters ("does this still name a workspace?") happens at
    // boot reconciliation, where the workspace list exists to check against.
    detachedWorkspaces: Array.isArray(parsed.detachedWorkspaces)
      ? [
          ...new Set(
            parsed.detachedWorkspaces.filter((id): id is string => typeof id === "string"),
          ),
        ]
      : [...d.detachedWorkspaces],
    diffMode: parsed.diffMode === "split" ? "split" : "inline",
    diffLineNumbers: parsed.diffLineNumbers ?? d.diffLineNumbers,
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
    gitSectionOrder: parseGitSectionOrder(parsed.gitSectionOrder),
    sidebarSections: {
      files: parsed.sidebarSections?.files ?? d.sidebarSections.files,
      terminals: parsed.sidebarSections?.terminals ?? d.sidebarSections.terminals,
      agents: parsed.sidebarSections?.agents ?? d.sidebarSections.agents,
    },
    // Filtered element by element like `gitSectionOrder`, and deliberately not
    // checked against the workspaces that exist: prefs are parsed before the
    // workspace list is, and an id for a workspace that has since been deleted
    // is inert — `isCollapsed` simply never asks about it. Dropping unknown ids
    // here would instead lose the collapse for a workspace that is only absent
    // because this window has not hydrated it yet.
    collapsedWorkspaces: Array.isArray(parsed.collapsedWorkspaces)
      ? [...new Set(parsed.collapsedWorkspaces.filter((id): id is string => typeof id === "string"))]
      : [...d.collapsedWorkspaces],
    // Same filter, same "unknown ids are inert rather than dropped" rule as
    // `collapsedWorkspaces` above.
    blurredWorkspaces: Array.isArray(parsed.blurredWorkspaces)
      ? [...new Set(parsed.blurredWorkspaces.filter((id): id is string => typeof id === "string"))]
      : [...d.blurredWorkspaces],
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
    terminalsSidebar: clampPanelWidth(
      "terminalsSidebar",
      raw?.terminalsSidebar ?? PANEL_BOUNDS.terminalsSidebar.default,
    ),
    agentsSidebar: clampPanelWidth(
      "agentsSidebar",
      raw?.agentsSidebar ?? PANEL_BOUNDS.agentsSidebar.default,
    ),
    sidebarTerminalsHeight: clampPanelWidth(
      "sidebarTerminalsHeight",
      raw?.sidebarTerminalsHeight ?? PANEL_BOUNDS.sidebarTerminalsHeight.default,
    ),
    sidebarAgentsHeight: clampPanelWidth(
      "sidebarAgentsHeight",
      raw?.sidebarAgentsHeight ?? PANEL_BOUNDS.sidebarAgentsHeight.default,
    ),
  };
}

// ── The editor window's own geometry ────────────────────────────────────────
//
// File-tree column width and split fraction are shaped exactly like
// `PanelWidths`/`PANEL_BOUNDS` — a `{min,max,default}` bound and the same
// clamp-on-the-way-in-and-out discipline — but kept out of that table on
// purpose. `panels`/`gitPrefs` is written by exactly one window: the
// workbench (see `CreateAppStoreOptions.persist`). Any unrelated pref change
// there re-serialises the *whole* `panels` object from whatever it holds in
// memory, which is the value it hydrated at boot and never touches again —
// sharing the blob with a second writer would mean whichever window wrote
// last silently reverted the other's resize the next time the first one
// persisted anything at all. The editor window is exactly that second
// writer (it opens as its own Tauri window, or is embedded in stacked mode
// with its own non-persisting store either way — see `EditorApp.tsx`), so its
// geometry gets a storage key of its own.

export interface EditorPanelWidths {
  /// Width of the file-tree column, in px. Replaces the `15rem` constant
  /// `EditorApp`'s `<aside>` used to be pinned at.
  tree: number;
}

export type EditorPanelId = keyof EditorPanelWidths;

export const EDITOR_PANEL_BOUNDS: Record<EditorPanelId, { min: number; max: number; default: number }> = {
  tree: { min: 180, max: 480, default: 240 }, // 240px = the old `15rem` (16px root).
};

export function clampEditorPanelWidth(panel: EditorPanelId, value: number): number {
  const { min, max, default: fallback } = EDITOR_PANEL_BOUNDS[panel];
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export interface EditorPrefs {
  panels: EditorPanelWidths;
  /// Size of the editor's first group as a fraction of the split container.
  /// Bounds and default live in `editorGroups.ts` (`clampFraction`,
  /// `DEFAULT_SPLIT_FRACTION`) rather than in a `{min,max,default}` entry
  /// here — that module is already the one place the component and this
  /// parser both call, and a second constant would be a second place for the
  /// two to disagree.
  splitFraction: number;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  panels: { tree: EDITOR_PANEL_BOUNDS.tree.default },
  splitFraction: DEFAULT_SPLIT_FRACTION,
};

export function parseEditorPrefs(raw: unknown): EditorPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<EditorPrefs> & {
    panels?: Partial<EditorPanelWidths>;
  };
  return {
    panels: {
      tree: clampEditorPanelWidth("tree", r.panels?.tree ?? EDITOR_PANEL_BOUNDS.tree.default),
    },
    splitFraction: clampFraction(r.splitFraction ?? DEFAULT_SPLIT_FRACTION),
  };
}

export function loadEditorPrefs(): EditorPrefs {
  return parseEditorPrefs(readJson<unknown>(STORAGE_KEYS.editorPrefs, null));
}

export function persistEditorPrefs(prefs: EditorPrefs): void {
  writeJson(STORAGE_KEYS.editorPrefs, prefs);
}

export function loadPrefs(): UiPrefs {
  return parsePrefs(readJson<Partial<UiPrefs> | null>(STORAGE_KEYS.gitPrefs, null));
}

export function persistPrefs(prefs: UiPrefs): void {
  writeJson(STORAGE_KEYS.gitPrefs, prefs);
}
