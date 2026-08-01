/// The tab registry: one `TabKindSpec` per tab kind, and nothing else.
///
/// Before this module, adding a tab kind meant eleven edits — a type, a
/// `*ByWorktree` field, a seed line, a drop line, an `active*` memo, an
/// open/close/select trio, a loader, a persist effect and a place in the
/// snapshot writer — spread over 2000 lines. Everything a kind can say about
/// itself now says it here: where it is persisted, how it survives a JSON
/// round trip, when two of them are "the same tab", what it is called, and what
/// has to be kept to reopen it after a close.
///
/// Two deliberate non-goals, both of which the workbench prompt assumed away:
///
///   1. **The eleven `*ByWorktree` records are not collapsed into one
///      `Record<TabKind, …>`.** `state.openFilesByWorktree[wtId]` is read
///      directly by ~40 components and by `layout.test.ts`, which the
///      decomposition is required to leave untouched. The registry names the
///      state field instead (`stateKey`), which buys the same "one spec entry
///      per kind" property without a state-shape change that would have to
///      ripple through every consumer.
///   2. **The storage keys are unchanged.** `voidlink-editor-tabs` and friends
///      keep their exact on-disk shape; the registry describes them rather than
///      replacing them. Consolidating them into one new blob would silently
///      orphan every existing user's tabs on the boot after the upgrade, and
///      `layout.test.ts` hydrates a store from `voidlink-editor-tabs` by name.
import type { TerminalSession } from "@/types/workspace";
import { STORAGE_KEYS } from "./persistence";

// ── Tab shapes ────────────────────────────────────────────────────────────

export interface DiffTab {
  id: string;
  filePath: string;
  /// Which side of the index this tab shows: `true` is `git diff --cached`,
  /// `false` is `git diff`.
  ///
  /// Part of the identity, not a view option — see `equals` below. A file that
  /// is both staged and modified has two rows in the sidebar and two genuinely
  /// different diffs behind them; keying tabs on the path alone made the second
  /// row focus the first row's tab, so one of the two was unreachable.
  staged: boolean;
}

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

/// A Timeline (event log) tab. Like `HistoryTab` it carries no
/// per-tab state — the filters live in the component and are not worth
/// persisting — so one per worktree is all there ever needs to be.
export interface TimelineTab {
  id: string;
}

/// A Mission Control tab. Singleton and stateless like the three above: which
/// section is showing is view state, and the lineup, check-in and hills all
/// read from Rust rather than from anything worth persisting.
///
/// Held per worktree like every other collection here, but note that what it
/// *renders* is not worktree-scoped — Mission Control deliberately spans every
/// workspace. The per-worktree keying is about where the tab lives, not about
/// what it shows.
export interface MissionTab {
  id: string;
}

export interface OpenFileTab {
  id: string;
  path: string;
}

/// An embedded browser tab. The page itself lives in a real Tauri child
/// webview keyed by `id` — the store only owns the address, so a reload
/// restores the tab pointing at the same URL.
///
/// `title` is whatever the page last reported. It is optional because tabs
/// persisted before titles existed have none, and because a freshly opened tab
/// has nothing to show until its first load settles.
export interface BrowserTab {
  id: string;
  url: string;
  title?: string;
  /// Page scale, applied to the webview itself. Per tab rather than global: a
  /// dashboard that needs 150% and a docs page that does not are the normal
  /// pair, and `undefined` means 1 so nothing persisted before zoom existed
  /// comes back scaled.
  zoom?: number;
}

/// An AI agent thread. A peer of a diff or a terminal rather than a slide-over,
/// so a thread gets splits, drag-between-groups, the activity LED, tab-group
/// colouring, the switcher, the MRU, reopen-closed and session restore for free
/// — none of which a bespoke panel would have had without reimplementing all of
/// it.
///
/// Modelled on `BrowserTab`, not on `HistoryTab`: several threads per worktree is
/// the normal case (one asking about the diff, one refactoring), so this carries
/// per-tab payload and is never deduped.
export interface AgentTab {
  id: string;
  /// Which roster entry (`settings.ai.agents[]`) this thread talks to.
  agentId: string;
  /// The agent's display name, snapshotted at open time. The registry cannot
  /// reach settings, so the label reads this; a roster rename shows up on the
  /// next tab opened rather than retroactively.
  title?: string;
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

/// Which tab is in front. `ActiveItem` is a pointer, not a tab: the workbench
/// and the editor window each hold one, independently.
export type ActiveItem =
  | { type: "terminal"; id: string }
  | { type: "diff"; id: string }
  | { type: "file"; id: string; path: string }
  | { type: "compare"; id: string }
  | { type: "stack"; id: string }
  | { type: "conflict"; id: string }
  | { type: "history"; id: string }
  | { type: "preview"; id: string; path: string }
  | { type: "timeline"; id: string }
  | { type: "mission"; id: string }
  | { type: "browser"; id: string }
  | { type: "agent"; id: string };

/// Snapshot of a closed tab kept so `reopenLastClosedTab` can recreate
/// it. We capture *enough state* to reconstruct, not the original id —
/// reopening always produces a fresh id so we don't collide with any
/// future tab.
///
/// All eleven kinds are here, not the four this union started with. A terminal's
/// PTY really is gone, but its cwd and label are exactly what a *new* terminal
/// in the same place needs — the same trade session restore already makes —
/// and "close a terminal by accident, lose the pane" was the single most
/// common thing the four-kind union could not undo.
export type ClosedTab =
  | { type: "file"; path: string }
  | { type: "terminal"; label: string; cwd: string }
  // `staged` optional: closed-tab history persisted before the field existed
  // still deserializes, and absent means the unstaged side.
  | { type: "diff"; filePath: string; staged?: boolean }
  | {
      type: "compare";
      baseRef: string;
      headRef: string;
      useMergeBase: boolean;
      selectedFilePath: string | null;
      treeMode: CompareTreeMode;
      treeFilter: string;
    }
  | { type: "stack"; trunk: string; topBranch: string }
  | { type: "conflict"; filePath: string }
  | { type: "history" }
  | { type: "preview"; filePath: string }
  | { type: "timeline" }
  | { type: "mission" }
  | { type: "browser"; url: string; title?: string }
  /// The thread's transcript is not in here. What a reopen brings back is a tab
  /// pointed at the same roster entry; the conversation itself lives under
  /// `STORAGE_KEYS.agentThreads`, keyed by the tab id that is gone by now.
  | { type: "agent"; agentId: string; title?: string };

// ── The registry ──────────────────────────────────────────────────────────

export type TabKind =
  | "file"
  | "terminal"
  | "diff"
  | "compare"
  | "stack"
  | "conflict"
  | "history"
  | "preview"
  | "timeline"
  | "mission"
  | "browser"
  | "agent";

/// Maps a kind to the tab type it holds. Keeps `TAB_SPECS` honest without eleven
/// separate generic parameters at every call site.
export interface TabTypes {
  file: OpenFileTab;
  terminal: TerminalSession;
  diff: DiffTab;
  compare: CompareTab;
  stack: StackTab;
  conflict: ConflictTab;
  history: HistoryTab;
  preview: PreviewTab;
  timeline: TimelineTab;
  mission: MissionTab;
  browser: BrowserTab;
  agent: AgentTab;
}

/// The `AppStoreState` fields that hold per-worktree tab collections. Declared
/// here so the registry can name one, and asserted against `AppStoreState` in
/// `index.ts` so the two can never drift.
export type TabCollectionKey =
  | "openFilesByWorktree"
  | "terminalsByWorktree"
  | "diffTabsByWorktree"
  | "compareTabsByWorktree"
  | "stackTabsByWorktree"
  | "conflictTabsByWorktree"
  | "historyTabsByWorktree"
  | "previewTabsByWorktree"
  | "timelineTabsByWorktree"
  | "missionTabsByWorktree"
  | "browserTabsByWorktree"
  | "agentTabsByWorktree";

/// Where a kind's tabs live on disk.
///
/// `field` is set for the four kinds that share `voidlink-editor-tabs`: that
/// key holds one blob with a named collection per kind, because it is the
/// entire contents of another window and is written as a unit.
export interface TabStorage {
  key: string;
  field?: "files" | "diffs" | "conflicts" | "previews";
}

/// What a `restore()` is allowed to reach for. Deliberately tiny: restoring a
/// tab is a pure projection of its payload for ten of the eleven kinds, and the
/// eleventh needs one process spawned.
export interface TabRestoreContext {
  /// The restoring worktree's directory. A terminal's fresh PTY is rooted here
  /// and not at the persisted `cwd`: the saved path may not exist any more,
  /// and a worktree's shells belong in that worktree.
  worktreePath: string;
  /// Spawn a PTY and return its id, or throw. Absent in a window that hydrates
  /// the same state but owns none of the processes (the git window), in which
  /// case terminal tabs simply do not restore there.
  spawnPty?: (cwd: string) => Promise<string>;
}

export interface TabKindSpec<K extends TabKind = TabKind> {
  kind: K;
  /// The `AppStoreState` field holding `Record<worktreeId, T[]>`.
  stateKey: TabCollectionKey;
  /// `null` for kinds that are memory-only today. Session restore (Wave 4)
  /// turns these on; the serializers below are already written for it, which
  /// is why `tabs.test.ts` round-trips all eleven kinds and not just the seven
  /// that currently persist.
  storage: TabStorage | null;
  /// Projection to plain JSON. Never emits `undefined` fields as `null`.
  serialize(tab: TabTypes[K]): unknown;
  /// The inverse, defensively. Returns `null` for anything that fails
  /// validation — this is user-editable JSON on disk, and a malformed entry
  /// should cost one tab, not the boot.
  deserialize(raw: unknown): TabTypes[K] | null;
  /// Bring a persisted tab back on boot. Ten kinds are `deserialize` with a
  /// promise around it; the terminal is why the promise is there at all.
  ///
  /// A restored tab keeps its **persisted id**. Pins, pane-tree claims, the
  /// MRU, the nav history and the saved active-tab pointer are all id-keyed,
  /// so minting a fresh id here would restore the tabs and lose everything
  /// that pointed at them. `null` means "this one could not come back" and
  /// costs exactly that tab.
  restore(raw: unknown, ctx: TabRestoreContext): Promise<TabTypes[K] | null>;
  /// "Is this the same tab?" for dedupe on open. Deliberately *not* id
  /// equality: opening the same file twice must find the existing tab.
  equals(a: TabTypes[K], b: TabTypes[K]): boolean;
  /// What the tab strip calls it.
  label(tab: TabTypes[K]): string;
  /// What has to be kept to reopen it, or `null` for kinds that cannot be
  /// reopened. A terminal's PTY is gone by the time we get here.
  closedSnapshot(tab: TabTypes[K]): ClosedTab | null;
}

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/// `{ id, path }` and `{ id, filePath }` cover six of the eleven kinds; these two
/// helpers are why the specs below read as declarations rather than as code.
function pathTab<T extends { id: string; path: string }>(raw: unknown): T | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.path !== "string") return null;
  return { id: raw.id, path: raw.path } as T;
}

function filePathTab<T extends { id: string; filePath: string }>(raw: unknown): T | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.filePath !== "string") return null;
  return { id: raw.id, filePath: raw.filePath } as T;
}

/// `filePathTab` plus the index side.
///
/// `staged` defaults to `false` rather than rejecting the row: tabs persisted
/// before the field existed are all unstaged views, which is what the single
/// diff the app could produce back then actually showed.
function diffTab(raw: unknown): DiffTab | null {
  const base = filePathTab<{ id: string; filePath: string }>(raw);
  if (!base) return null;
  const staged = isRecord(raw) && raw.staged === true;
  return { ...base, staged };
}

function idOnlyTab<T extends { id: string }>(raw: unknown): T | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string") return null;
  return { id: raw.id } as T;
}

/// The three deserializers that are more than a field check, named so
/// `deserialize` and `restore` can share one definition apiece rather than
/// drifting into two readings of the same blob.
function deserializeTerminal(raw: unknown): TerminalSession | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.cwd !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    // A persisted PTY id names a process that died with the app. It is kept
    // in the blob for shape stability and defaulted when absent; nothing
    // downstream may use it without spawning first.
    ptyId: typeof raw.ptyId === "string" ? raw.ptyId : "",
    label: raw.label,
    cwd: raw.cwd,
  };
}

function deserializeCompare(raw: unknown): CompareTab | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.baseRef !== "string" ||
    typeof raw.headRef !== "string"
  ) {
    return null;
  }
  return {
    id: raw.id,
    baseRef: raw.baseRef,
    headRef: raw.headRef,
    useMergeBase: typeof raw.useMergeBase === "boolean" ? raw.useMergeBase : true,
    selectedFilePath: typeof raw.selectedFilePath === "string" ? raw.selectedFilePath : null,
    treeMode: raw.treeMode === "flat" ? "flat" : "tree",
    treeFilter: typeof raw.treeFilter === "string" ? raw.treeFilter : "",
  };
}

function deserializeStack(raw: unknown): StackTab | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.id !== "string" ||
    typeof raw.trunk !== "string" ||
    typeof raw.topBranch !== "string"
  ) {
    return null;
  }
  return { id: raw.id, trunk: raw.trunk, topBranch: raw.topBranch };
}

function deserializeBrowser(raw: unknown): BrowserTab | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.url !== "string") return null;
  return {
    id: raw.id,
    url: raw.url,
    // Absent in state persisted before titles were tracked; the tab label
    // falls back to the host until the page reports one.
    title: typeof raw.title === "string" ? raw.title : undefined,
    // Finite and positive or nothing: a persisted `null`, `0` or `NaN` would
    // reach `set_zoom` and render the page at a size nobody can read their way
    // out of. Rust clamps too — this stops the bad value being remembered.
    zoom:
      typeof raw.zoom === "number" && Number.isFinite(raw.zoom) && raw.zoom > 0
        ? raw.zoom
        : undefined,
  };
}

function deserializeAgent(raw: unknown): AgentTab | null {
  if (!isRecord(raw)) return null;
  // `agentId` is required and not defaulted: a thread whose roster entry we
  // cannot name would render a panel with no model behind it, which is a worse
  // outcome than the tab not coming back.
  if (typeof raw.id !== "string" || typeof raw.agentId !== "string") return null;
  return {
    id: raw.id,
    agentId: raw.agentId,
    // Absent when the roster entry was unnamed at open time; the label falls
    // back to "Agent".
    title: typeof raw.title === "string" ? raw.title : undefined,
  };
}

export const TAB_SPECS: { [K in TabKind]: TabKindSpec<K> } = {
  file: {
    kind: "file",
    stateKey: "openFilesByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "files" },
    serialize: (t) => ({ id: t.id, path: t.path }),
    deserialize: (raw) => pathTab<OpenFileTab>(raw),
    restore: async (raw) => pathTab<OpenFileTab>(raw),
    equals: (a, b) => a.path === b.path,
    label: (t) => basename(t.path),
    closedSnapshot: (t) => ({ type: "file", path: t.path }),
  },

  terminal: {
    kind: "terminal",
    stateKey: "terminalsByWorktree",
    /// The session, not the process. What comes back on boot is a tab with the
    /// same id, label and cwd, in front of a PTY spawned seconds ago.
    storage: { key: STORAGE_KEYS.terminalTabs },
    serialize: (t) => ({ id: t.id, label: t.label, cwd: t.cwd }),
    deserialize: (raw) => deserializeTerminal(raw),
    restore: async (raw, ctx) => {
      const saved = deserializeTerminal(raw);
      if (!saved) return null;
      // No spawner (a non-owning window) means no terminal. Restoring the row
      // without a process behind it would render a pane wired to nothing.
      if (!ctx.spawnPty) return null;
      const cwd = ctx.worktreePath || saved.cwd;
      const ptyId = await ctx.spawnPty(cwd);
      return { id: saved.id, ptyId, label: saved.label, cwd, restored: true };
    },
    equals: (a, b) => a.id === b.id,
    label: (t) => t.label,
    closedSnapshot: (t) => ({ type: "terminal", label: t.label, cwd: t.cwd }),
  },

  diff: {
    kind: "diff",
    stateKey: "diffTabsByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "diffs" },
    serialize: (t) => ({ id: t.id, filePath: t.filePath, staged: t.staged }),
    deserialize: (raw) => diffTab(raw),
    restore: async (raw) => diffTab(raw),
    equals: (a, b) => a.filePath === b.filePath && a.staged === b.staged,
    label: (t) => (t.staged ? `${basename(t.filePath)} (staged)` : basename(t.filePath)),
    closedSnapshot: (t) => ({ type: "diff", filePath: t.filePath, staged: t.staged }),
  },

  compare: {
    kind: "compare",
    stateKey: "compareTabsByWorktree",
    storage: { key: STORAGE_KEYS.compareTabs },
    serialize: (t) => ({ ...t }),
    deserialize: (raw) => deserializeCompare(raw),
    restore: async (raw) => deserializeCompare(raw),
    // Refs identify a comparison; the tree filter and selection are view state.
    equals: (a, b) => a.baseRef === b.baseRef && a.headRef === b.headRef,
    label: (t) => `${t.baseRef || "?"}..${t.headRef || "?"}`,
    closedSnapshot: (t) => ({
      type: "compare",
      baseRef: t.baseRef,
      headRef: t.headRef,
      useMergeBase: t.useMergeBase,
      selectedFilePath: t.selectedFilePath,
      treeMode: t.treeMode,
      treeFilter: t.treeFilter,
    }),
  },

  stack: {
    kind: "stack",
    stateKey: "stackTabsByWorktree",
    storage: { key: STORAGE_KEYS.stackTabs },
    serialize: (t) => ({ id: t.id, trunk: t.trunk, topBranch: t.topBranch }),
    deserialize: (raw) => deserializeStack(raw),
    restore: async (raw) => deserializeStack(raw),
    equals: (a, b) => a.trunk === b.trunk && a.topBranch === b.topBranch,
    label: (t) => t.topBranch,
    closedSnapshot: (t) => ({ type: "stack", trunk: t.trunk, topBranch: t.topBranch }),
  },

  conflict: {
    kind: "conflict",
    stateKey: "conflictTabsByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "conflicts" },
    serialize: (t) => ({ id: t.id, filePath: t.filePath }),
    deserialize: (raw) => filePathTab<ConflictTab>(raw),
    restore: async (raw) => filePathTab<ConflictTab>(raw),
    equals: (a, b) => a.filePath === b.filePath,
    label: (t) => basename(t.filePath),
    // A conflict tab is opened *by* the conflicted state of the repo, so
    // reopening one whose conflict is resolved shows a merge view with nothing
    // to merge. That is a worse tab than the one the user asked for and a
    // better outcome than "reopen-closed silently does nothing for this kind",
    // which is what the four-kind union gave them.
    closedSnapshot: (t) => ({ type: "conflict", filePath: t.filePath }),
  },

  history: {
    kind: "history",
    stateKey: "historyTabsByWorktree",
    storage: { key: STORAGE_KEYS.historyTabs },
    serialize: (t) => ({ id: t.id }),
    deserialize: (raw) => idOnlyTab<HistoryTab>(raw),
    restore: async (raw) => idOnlyTab<HistoryTab>(raw),
    // Repo-wide, one per worktree: any two history tabs are the same tab.
    equals: () => true,
    label: () => "History",
    closedSnapshot: () => ({ type: "history" }),
  },

  preview: {
    kind: "preview",
    stateKey: "previewTabsByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "previews" },
    serialize: (t) => ({ id: t.id, filePath: t.filePath }),
    deserialize: (raw) => filePathTab<PreviewTab>(raw),
    restore: async (raw) => filePathTab<PreviewTab>(raw),
    equals: (a, b) => a.filePath === b.filePath,
    label: (t) => basename(t.filePath),
    closedSnapshot: (t) => ({ type: "preview", filePath: t.filePath }),
  },

  timeline: {
    kind: "timeline",
    stateKey: "timelineTabsByWorktree",
    storage: { key: STORAGE_KEYS.timelineTabs },
    serialize: (t) => ({ id: t.id }),
    deserialize: (raw) => idOnlyTab<TimelineTab>(raw),
    restore: async (raw) => idOnlyTab<TimelineTab>(raw),
    equals: () => true,
    label: () => "Timeline",
    closedSnapshot: () => ({ type: "timeline" }),
  },

  mission: {
    kind: "mission",
    stateKey: "missionTabsByWorktree",
    storage: { key: STORAGE_KEYS.missionTabs },
    serialize: (t) => ({ id: t.id }),
    deserialize: (raw) => idOnlyTab<MissionTab>(raw),
    restore: async (raw) => idOnlyTab<MissionTab>(raw),
    equals: () => true,
    label: () => "Mission Control",
    closedSnapshot: () => ({ type: "mission" }),
  },

  browser: {
    kind: "browser",
    stateKey: "browserTabsByWorktree",
    storage: { key: STORAGE_KEYS.browserTabs },
    // The narrow form is for the common tab — no title yet, never zoomed — so
    // the stored blob stays small. Both optional fields have to be checked, or
    // a zoomed tab whose page never reported a title loses its scale on reload.
    serialize: (t) =>
      t.title === undefined && t.zoom === undefined ? { id: t.id, url: t.url } : { ...t },
    deserialize: (raw) => deserializeBrowser(raw),
    restore: async (raw) => deserializeBrowser(raw),
    // Two tabs on the same site is a normal thing to want, and each owns its
    // own webview — so browser tabs are never deduped by address.
    equals: (a, b) => a.id === b.id,
    label: (t) => {
      if (t.title) return t.title;
      try {
        return new URL(t.url).host || t.url;
      } catch {
        return t.url;
      }
    },
    closedSnapshot: (t) => ({ type: "browser", url: t.url, title: t.title }),
  },

  agent: {
    kind: "agent",
    stateKey: "agentTabsByWorktree",
    /// The tab, not the conversation. The transcript is a much larger blob with
    /// a different write rhythm (every streamed message, not every tab open), so
    /// it gets its own key — see `STORAGE_KEYS.agentThreads`.
    storage: { key: STORAGE_KEYS.agentTabs },
    serialize: (t) =>
      t.title === undefined ? { id: t.id, agentId: t.agentId } : { ...t },
    deserialize: (raw) => deserializeAgent(raw),
    restore: async (raw) => deserializeAgent(raw),
    // Two threads with the same agent is a normal thing to want — one asking
    // about the diff, one refactoring — so agent tabs are never deduped by
    // roster entry, exactly as browser tabs are not deduped by URL.
    equals: (a, b) => a.id === b.id,
    label: (t) => t.title?.trim() || "Agent",
    closedSnapshot: (t) => ({ type: "agent", agentId: t.agentId, title: t.title }),
  },
};

/// What an auto-derived tab group of one kind is called (Wave 4's `kind` mode).
///
/// A `Record<TabKind, string>` rather than a list, so adding a kind is a
/// compile error here rather than a group chip labelled `undefined`. The
/// derivation reads this instead of carrying its own copy of the kind set.
export const TAB_KIND_GROUP_LABELS: Record<TabKind, string> = {
  file: "Files",
  terminal: "Terminals",
  diff: "Diffs",
  compare: "Compares",
  stack: "Stacks",
  conflict: "Conflicts",
  history: "Commit graph",
  preview: "Previews",
  timeline: "Timeline",
  mission: "Mission Control",
  browser: "Browser",
  agent: "Agents",
};

/// Render/iteration order. Also the order the tab strip lays kinds out in, so
/// it is not merely `Object.keys`.
export const TAB_KINDS: TabKind[] = [
  "file",
  "terminal",
  "diff",
  "compare",
  "stack",
  "conflict",
  "history",
  "preview",
  "timeline",
  "mission",
  "browser",
  "agent",
];

/// Deserialize one kind's `Record<worktreeId, T[]>`, seeding an empty list for
/// every known worktree so no lookup downstream has to invent a default.
export function deserializeTabRecord<K extends TabKind>(
  kind: K,
  raw: unknown,
  worktreeIds: string[],
): Record<string, TabTypes[K][]> {
  const spec = TAB_SPECS[kind];
  const out: Record<string, TabTypes[K][]> = Object.fromEntries(
    worktreeIds.map((id) => [id, [] as TabTypes[K][]]),
  );
  if (!isRecord(raw)) return out;
  for (const wtId of worktreeIds) {
    const list = raw[wtId];
    if (!Array.isArray(list)) continue;
    out[wtId] = list
      .map((entry) => spec.deserialize(entry))
      .filter((t): t is TabTypes[K] => t !== null);
  }
  return out;
}

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

/// Whether two closed-tab snapshots describe the same thing, so closing the
/// same diff twice doesn't bury other recent closes.
export function closedTabsEqual(a: ClosedTab, b: ClosedTab): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "file":
      return b.type === "file" && a.path === b.path;
    case "terminal":
      return b.type === "terminal" && a.label === b.label && a.cwd === b.cwd;
    case "diff":
      // Same file, opposite side of the index: two different diffs, so two
      // separate entries in the reopen history.
      return (
        b.type === "diff" && a.filePath === b.filePath && !!a.staged === !!b.staged
      );
    case "compare":
      return (
        b.type === "compare" && a.baseRef === b.baseRef && a.headRef === b.headRef
      );
    case "stack":
      return b.type === "stack" && a.trunk === b.trunk && a.topBranch === b.topBranch;
    case "conflict":
      return b.type === "conflict" && a.filePath === b.filePath;
    case "preview":
      return b.type === "preview" && a.filePath === b.filePath;
    case "browser":
      return b.type === "browser" && a.url === b.url;
    // The roster entry, not the title: closing two threads on the same agent is
    // one entry in the LIFO, because reopening either produces the same tab.
    case "agent":
      return b.type === "agent" && a.agentId === b.agentId;
    // Singletons: same type is same tab.
    case "history":
    case "timeline":
    case "mission":
      return true;
  }
}

/// Validate one persisted closed-tab entry. The reopen history survives
/// reloads now, which means it is user-editable JSON on disk like everything
/// else and gets the same treatment: a malformed entry costs that entry.
export function deserializeClosedTab(raw: unknown): ClosedTab | null {
  if (!isRecord(raw)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  switch (raw.type) {
    case "file": {
      const path = str(raw.path);
      return path === null ? null : { type: "file", path };
    }
    case "terminal": {
      const label = str(raw.label);
      const cwd = str(raw.cwd);
      return label === null || cwd === null ? null : { type: "terminal", label, cwd };
    }
    case "diff": {
      const filePath = str(raw.filePath);
      return filePath === null
        ? null
        : { type: "diff", filePath, staged: raw.staged === true };
    }
    case "conflict": {
      const filePath = str(raw.filePath);
      return filePath === null ? null : { type: "conflict", filePath };
    }
    case "preview": {
      const filePath = str(raw.filePath);
      return filePath === null ? null : { type: "preview", filePath };
    }
    case "compare": {
      const baseRef = str(raw.baseRef);
      const headRef = str(raw.headRef);
      if (baseRef === null || headRef === null) return null;
      return {
        type: "compare",
        baseRef,
        headRef,
        useMergeBase: typeof raw.useMergeBase === "boolean" ? raw.useMergeBase : true,
        selectedFilePath: str(raw.selectedFilePath),
        treeMode: raw.treeMode === "flat" ? "flat" : "tree",
        treeFilter: str(raw.treeFilter) ?? "",
      };
    }
    case "stack": {
      const trunk = str(raw.trunk);
      const topBranch = str(raw.topBranch);
      return trunk === null || topBranch === null
        ? null
        : { type: "stack", trunk, topBranch };
    }
    case "browser": {
      const url = str(raw.url);
      return url === null ? null : { type: "browser", url, title: str(raw.title) ?? undefined };
    }
    case "agent": {
      const agentId = str(raw.agentId);
      return agentId === null
        ? null
        : { type: "agent", agentId, title: str(raw.title) ?? undefined };
    }
    case "history":
      return { type: "history" };
    case "timeline":
      return { type: "timeline" };
    case "mission":
      return { type: "mission" };
    default:
      return null;
  }
}

/// The four kinds the editor window renders. The workbench renders the other
/// eight, and each window has its own active-item pointer.
export const EDITOR_TAB_KINDS: TabKind[] = ["file", "diff", "conflict", "preview"];

export function isEditorKind(kind: string): boolean {
  return EDITOR_TAB_KINDS.includes(kind as TabKind);
}

/// The kinds the workbench renders, in registry order — the complement of
/// `EDITOR_TAB_KINDS`, derived rather than spelled out so a new kind lands in
/// the pane tree by being registered. Mission Control spent its first release
/// missing from a hand-written copy of this list, which made its tab
/// unclaimable by any pane group and so invisible: opening it did nothing.
export const WORKBENCH_TAB_KINDS: TabKind[] = TAB_KINDS.filter((k) => !isEditorKind(k));

// ── The editor window's shared blob ───────────────────────────────────────

/// Shape persisted under `voidlink-editor-tabs`. Every collection is validated
/// field by field on the way in: this is user-editable JSON on disk, and a
/// malformed entry should cost one tab, not the boot.
///
/// The four editor kinds share one key rather than taking one each because
/// they are the entire contents of another window and are written as a unit —
/// a partial write would open the editor with three of its four collections.
export interface PersistedEditorTabs {
  files: Record<string, OpenFileTab[]>;
  diffs: Record<string, DiffTab[]>;
  conflicts: Record<string, ConflictTab[]>;
  previews: Record<string, PreviewTab[]>;
  active: Record<string, ActiveItem | null>;
}

/// Project the live store down to what the editor-tabs key holds.
///
/// Pulled out of the persist effect so the write side is a pure function the
/// tests can exercise: `parseEditorTabs(serializeEditorTabs(state))` is the
/// round-trip a workbench reload performs, and it is worth knowing that it
/// holds without standing up a reactive root.
export function serializeEditorTabs(source: {
  openFilesByWorktree: Record<string, OpenFileTab[]>;
  diffTabsByWorktree: Record<string, DiffTab[]>;
  conflictTabsByWorktree: Record<string, ConflictTab[]>;
  previewTabsByWorktree: Record<string, PreviewTab[]>;
  editorActiveItemByWorktree: Record<string, ActiveItem | null>;
}): PersistedEditorTabs {
  return {
    files: source.openFilesByWorktree,
    diffs: source.diffTabsByWorktree,
    conflicts: source.conflictTabsByWorktree,
    previews: source.previewTabsByWorktree,
    active: source.editorActiveItemByWorktree,
  };
}

/// Read back what `serializeEditorTabs` wrote, defensively. Anything that fails
/// validation costs one tab, never the boot.
export function parseEditorTabs(
  raw: string | null,
  worktreeIds: string[],
): PersistedEditorTabs {
  const empty = (): PersistedEditorTabs => ({
    files: Object.fromEntries(worktreeIds.map((id) => [id, [] as OpenFileTab[]])),
    diffs: Object.fromEntries(worktreeIds.map((id) => [id, [] as DiffTab[]])),
    conflicts: Object.fromEntries(worktreeIds.map((id) => [id, [] as ConflictTab[]])),
    previews: Object.fromEntries(worktreeIds.map((id) => [id, [] as PreviewTab[]])),
    active: Object.fromEntries(worktreeIds.map((id) => [id, null])),
  });
  try {
    if (!raw) return empty();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return empty();
    const out = empty();
    for (const wtId of worktreeIds) {
      // Registry-driven: each of the four kinds validates its own entries, so
      // the rules here and the rules a tab is opened under cannot drift.
      out.files[wtId] = deserializeTabRecord("file", parsed.files, [wtId])[wtId];
      out.diffs[wtId] = deserializeTabRecord("diff", parsed.diffs, [wtId])[wtId];
      out.conflicts[wtId] = deserializeTabRecord("conflict", parsed.conflicts, [wtId])[wtId];
      out.previews[wtId] = deserializeTabRecord("preview", parsed.previews, [wtId])[wtId];
      const activeRecord = isRecord(parsed.active) ? parsed.active : {};
      const active = activeRecord[wtId];
      // Only the four editor kinds may sit in this pointer; anything else is
      // stale state from an older build and is safer dropped than honoured.
      out.active[wtId] =
        isRecord(active) && typeof active.id === "string" && isEditorKind(String(active.type))
          ? (active as unknown as ActiveItem)
          : null;
    }
    return out;
  } catch {
    return empty();
  }
}
