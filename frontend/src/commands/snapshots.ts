/// Named, restorable captures of a worktree's whole open state.
///
/// Two properties are load-bearing and neither is negotiable:
///
///   1. **Everything is addressed by content, never by tab id** — a key is
///      `"kind:identifier"` (`file:/repo/src/main.ts`, `compare:main..HEAD`).
///      A restore mints fresh ids for everything it opens, so an id captured
///      today names nothing tomorrow; a path or a pair of refs still does.
///      The pane geometry is stored with its group claims rewritten into the
///      same keys for exactly this reason.
///   2. **The format is versioned and migrated on read.** v1 held five of the
///      ten tab kinds in five parallel top-level arrays and had no `version`
///      field at all. v2 holds all ten under `tabs` plus the pane tree.
///      `migrateSnapshot` upgrades a v1 blob in memory on the way in, so a
///      user's saved snapshots survive the upgrade without a write.
import { createSignal } from "solid-js";
import type {
  CompareTreeMode,
  DiffMode,
  DockSide,
  GitTab,
  SidebarId,
  SidebarTab,
} from "@/store/layout";
import { parseDockSide } from "@/store/layout";
import { STORAGE_KEYS, readJson, writeJson } from "@/store/layout/persistence";

export const SNAPSHOT_VERSION = 2;

export interface SnapshotTerminal {
  label: string;
  cwd: string;
}

export interface SnapshotCompare {
  baseRef: string;
  headRef: string;
  useMergeBase: boolean;
  selectedFilePath: string | null;
  treeMode: CompareTreeMode;
  treeFilter: string;
}

export interface SnapshotStack {
  trunk: string;
  topBranch: string;
}

export interface SnapshotBrowser {
  url: string;
  title?: string;
}

/// An agent thread, as a snapshot records it: which roster entry it talks to and
/// what the tab was called. Not the transcript — a snapshot is a named
/// *arrangement*, and restoring one into a conversation from another day would be
/// stranger than restoring an empty thread on the right agent.
export interface SnapshotAgent {
  agentId: string;
  title?: string;
}

/// All eleven kinds. The repo-wide singletons (commit graph, timeline, Mission
/// Control) are booleans rather than arrays because there is never more than one
/// of each.
///
/// A snapshot saved before the 2026-07-29 audit's cut C2 also carries
/// `brain: true`. `parseSnapshot` no longer reads it, so such a snapshot
/// restores without a brain tab and is otherwise untouched — which is the
/// intended outcome, since the surface is now an overlay that no arrangement
/// needs to describe.
export interface SnapshotTabs {
  files: string[];
  terminals: SnapshotTerminal[];
  diffs: string[];
  compares: SnapshotCompare[];
  stacks: SnapshotStack[];
  conflicts: string[];
  previews: string[];
  browsers: SnapshotBrowser[];
  history: boolean;
  timeline: boolean;
  /// The one-scroll "all changes" tab. Absent from every snapshot saved before
  /// it existed, so it parses as `false` rather than rejecting the blob.
  combined: boolean;
  mission: boolean;
  agents: SnapshotAgent[];
}

export interface SnapshotUi {
  gitSidebarCollapsed: boolean;
  leftSidebarCollapsed: boolean;
  /// Which edge each sidebar sat on. A snapshot saved before the dock model
  /// carries `sidebarsSwapped` instead, and `migrateUi` hands both to the one
  /// migration in `store/layout/dock.ts` rather than keeping a second copy of
  /// the rule here.
  dockSide: Record<SidebarId, DockSide>;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
  sidebarTab: SidebarTab;
}

export interface WorkspaceSnapshot {
  version: number;
  name: string;
  savedAt: number;
  tabs: SnapshotTabs;
  /// The serialized pane tree, with every group claim and `activeTabId`
  /// rewritten from a tab id to a content key. `null` means the default single
  /// group — which is also what a v1 snapshot restores into, since v1 predates
  /// pane groups entirely.
  panes: unknown | null;
  /// Content key of the active item, `"kind:identifier"`. Identifiers: file →
  /// absolute path, terminal → index, diff/conflict/preview → filePath,
  /// compare → `baseRef..headRef`, stack → topBranch, browser/agent → index,
  /// history/timeline/mission → empty (there is only one).
  active: string | null;
  /// Content keys of pinned tabs (same format as `active`).
  pinned: string[];
  ui: SnapshotUi;
}

export function emptySnapshotTabs(): SnapshotTabs {
  return {
    files: [],
    terminals: [],
    diffs: [],
    compares: [],
    stacks: [],
    conflicts: [],
    previews: [],
    browsers: [],
    history: false,
    timeline: false,
    combined: false,
    mission: false,
    agents: [],
  };
}

type AllSnapshots = Record<string, WorkspaceSnapshot[]>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/// Upgrade one stored snapshot to the current version, or reject it.
///
/// Pure, so the migration is testable without localStorage, and idempotent —
/// a v2 blob passes through it unchanged. A blob too broken to name (no
/// `name`) is dropped rather than resurrected as `"undefined"`.
export function migrateSnapshot(raw: unknown): WorkspaceSnapshot | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.name !== "string" || raw.name.length === 0) return null;
  const savedAt = typeof raw.savedAt === "number" ? raw.savedAt : 0;
  const ui = migrateUi(raw.ui);
  const active = typeof raw.active === "string" ? raw.active : null;
  const pinned = strings(raw.pinned);

  const version = typeof raw.version === "number" ? raw.version : 1;
  if (version >= SNAPSHOT_VERSION && isRecord(raw.tabs)) {
    return {
      version: SNAPSHOT_VERSION,
      name: raw.name,
      savedAt,
      tabs: migrateTabs(raw.tabs),
      panes: raw.panes ?? null,
      active,
      pinned,
      ui,
    };
  }

  // v1: five parallel top-level arrays, no pane geometry, no singletons.
  return {
    version: SNAPSHOT_VERSION,
    name: raw.name,
    savedAt,
    tabs: {
      ...emptySnapshotTabs(),
      files: strings(raw.files),
      terminals: migrateTerminals(raw.terminals),
      diffs: strings(raw.diffs),
      compares: migrateCompares(raw.compares),
      stacks: migrateStacks(raw.stacks),
    },
    panes: null,
    active,
    pinned,
    ui,
  };
}

function migrateTabs(raw: Record<string, unknown>): SnapshotTabs {
  return {
    files: strings(raw.files),
    terminals: migrateTerminals(raw.terminals),
    diffs: strings(raw.diffs),
    compares: migrateCompares(raw.compares),
    stacks: migrateStacks(raw.stacks),
    conflicts: strings(raw.conflicts),
    previews: strings(raw.previews),
    browsers: migrateBrowsers(raw.browsers),
    history: raw.history === true,
    timeline: raw.timeline === true,
    combined: raw.combined === true,
    mission: raw.mission === true,
    // Absent from every snapshot saved before agent tabs existed, which is why a
    // missing list defaults to empty rather than rejecting the whole blob.
    agents: migrateAgents(raw.agents),
  };
}

function migrateTerminals(raw: unknown): SnapshotTerminal[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.label === "string" && typeof entry.cwd === "string"
      ? [{ label: entry.label, cwd: entry.cwd }]
      : [],
  );
}

function migrateCompares(raw: unknown): SnapshotCompare[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (typeof entry.baseRef !== "string" || typeof entry.headRef !== "string") return [];
    return [
      {
        baseRef: entry.baseRef,
        headRef: entry.headRef,
        useMergeBase: typeof entry.useMergeBase === "boolean" ? entry.useMergeBase : true,
        selectedFilePath:
          typeof entry.selectedFilePath === "string" ? entry.selectedFilePath : null,
        treeMode: (entry.treeMode === "flat" ? "flat" : "tree") as CompareTreeMode,
        treeFilter: typeof entry.treeFilter === "string" ? entry.treeFilter : "",
      },
    ];
  });
}

function migrateStacks(raw: unknown): SnapshotStack[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.trunk === "string" && typeof entry.topBranch === "string"
      ? [{ trunk: entry.trunk, topBranch: entry.topBranch }]
      : [],
  );
}

function migrateBrowsers(raw: unknown): SnapshotBrowser[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.url === "string"
      ? [{ url: entry.url, title: typeof entry.title === "string" ? entry.title : undefined }]
      : [],
  );
}

function migrateAgents(raw: unknown): SnapshotAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.agentId === "string"
      ? [
          {
            agentId: entry.agentId,
            title: typeof entry.title === "string" ? entry.title : undefined,
          },
        ]
      : [],
  );
}

/// UI prefs, defaulted field by field. A snapshot saved by a build that did not
/// have one of these settles on today's default rather than on `undefined`,
/// which would render as an unstyled sidebar.
function migrateUi(raw: unknown): SnapshotUi {
  const r = isRecord(raw) ? raw : {};
  return {
    gitSidebarCollapsed: r.gitSidebarCollapsed === true,
    leftSidebarCollapsed: r.leftSidebarCollapsed === true,
    dockSide: parseDockSide(r.dockSide, r.sidebarsSwapped),
    diffMode: (r.diffMode === "split" ? "split" : "unified") as DiffMode,
    gitTab: (typeof r.gitTab === "string" ? r.gitTab : "changes") as GitTab,
    ignoreWhitespace: r.ignoreWhitespace === true,
    sidebarTab: (typeof r.sidebarTab === "string" ? r.sidebarTab : "files") as SidebarTab,
  };
}

function load(): AllSnapshots {
  const parsed = readJson<Record<string, unknown> | null>(STORAGE_KEYS.snapshots, null);
  if (!parsed || typeof parsed !== "object") return {};
  const out: AllSnapshots = {};
  for (const [wsId, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) continue;
    const migrated = list
      .map((entry) => migrateSnapshot(entry))
      .filter((s): s is WorkspaceSnapshot => s !== null);
    if (migrated.length > 0) out[wsId] = migrated;
  }
  return out;
}

const [all, setAll] = createSignal<AllSnapshots>(load());

function persist() {
  writeJson(STORAGE_KEYS.snapshots, all());
}

export function allSnapshots() {
  return all();
}

export function snapshotsFor(wsId: string): WorkspaceSnapshot[] {
  return all()[wsId] ?? [];
}

/// Upsert by `name` so re-saving with the same name overwrites cleanly
/// (matches the principle of least surprise — users expect re-save to
/// update, not duplicate).
export function upsertSnapshot(wsId: string, snap: WorkspaceSnapshot) {
  setAll((cur) => {
    const list = (cur[wsId] ?? []).filter((s) => s.name !== snap.name);
    list.push(snap);
    list.sort((a, b) => b.savedAt - a.savedAt);
    return { ...cur, [wsId]: list };
  });
  persist();
}

export function removeSnapshot(wsId: string, name: string) {
  setAll((cur) => {
    const list = (cur[wsId] ?? []).filter((s) => s.name !== name);
    return { ...cur, [wsId]: list };
  });
  persist();
}

/// Rename in place, keeping `savedAt` — the snapshot is the same capture, so
/// re-dating it would reshuffle the list under the user's cursor. Refuses a
/// blank name and refuses to collide with an existing one; the caller reports
/// which, so returning a boolean here would lose the distinction.
export type RenameResult = "ok" | "not-found" | "empty-name" | "duplicate";

export function renameSnapshot(wsId: string, from: string, to: string): RenameResult {
  const trimmed = to.trim();
  if (!trimmed) return "empty-name";
  const list = all()[wsId] ?? [];
  if (!list.some((s) => s.name === from)) return "not-found";
  if (trimmed !== from && list.some((s) => s.name === trimmed)) return "duplicate";
  setAll((cur) => ({
    ...cur,
    [wsId]: (cur[wsId] ?? []).map((s) => (s.name === from ? { ...s, name: trimmed } : s)),
  }));
  persist();
  return "ok";
}

/// How many tabs a snapshot holds, for the manager's summary line.
export function snapshotTabCount(snap: WorkspaceSnapshot): number {
  const t = snap.tabs;
  return (
    t.files.length +
    t.terminals.length +
    t.diffs.length +
    t.compares.length +
    t.stacks.length +
    t.conflicts.length +
    t.previews.length +
    t.browsers.length +
    t.agents.length +
    (t.history ? 1 : 0) +
    (t.timeline ? 1 : 0) +
    (t.combined ? 1 : 0) +
    (t.mission ? 1 : 0)
  );
}
