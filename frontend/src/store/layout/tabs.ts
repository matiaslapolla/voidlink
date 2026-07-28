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
///   1. **The ten `*ByWorktree` records are not collapsed into one
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
  | { type: "brain"; id: string }
  | { type: "browser"; id: string };

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
  | "brain"
  | "browser";

/// Maps a kind to the tab type it holds. Keeps `TAB_SPECS` honest without ten
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
  brain: BrainTab;
  browser: BrowserTab;
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
  | "brainTabsByWorktree"
  | "browserTabsByWorktree";

/// Where a kind's tabs live on disk.
///
/// `field` is set for the four kinds that share `voidlink-editor-tabs`: that
/// key holds one blob with a named collection per kind, because it is the
/// entire contents of another window and is written as a unit.
export interface TabStorage {
  key: string;
  field?: "files" | "diffs" | "conflicts" | "previews";
}

export interface TabKindSpec<K extends TabKind = TabKind> {
  kind: K;
  /// The `AppStoreState` field holding `Record<worktreeId, T[]>`.
  stateKey: TabCollectionKey;
  /// `null` for kinds that are memory-only today. Session restore (Wave 4)
  /// turns these on; the serializers below are already written for it, which
  /// is why `tabs.test.ts` round-trips all ten kinds and not just the seven
  /// that currently persist.
  storage: TabStorage | null;
  /// Projection to plain JSON. Never emits `undefined` fields as `null`.
  serialize(tab: TabTypes[K]): unknown;
  /// The inverse, defensively. Returns `null` for anything that fails
  /// validation — this is user-editable JSON on disk, and a malformed entry
  /// should cost one tab, not the boot.
  deserialize(raw: unknown): TabTypes[K] | null;
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

/// `{ id, path }` and `{ id, filePath }` cover six of the ten kinds; these two
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

function idOnlyTab<T extends { id: string }>(raw: unknown): T | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string") return null;
  return { id: raw.id } as T;
}

export const TAB_SPECS: { [K in TabKind]: TabKindSpec<K> } = {
  file: {
    kind: "file",
    stateKey: "openFilesByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "files" },
    serialize: (t) => ({ id: t.id, path: t.path }),
    deserialize: (raw) => pathTab<OpenFileTab>(raw),
    equals: (a, b) => a.path === b.path,
    label: (t) => basename(t.path),
    closedSnapshot: (t) => ({ type: "file", path: t.path }),
  },

  terminal: {
    kind: "terminal",
    stateKey: "terminalsByWorktree",
    // Memory-only today: a persisted PTY id names a process that died with the
    // app. Wave 4 restores the *session* (cwd + label) against a fresh PTY,
    // which is what `deserialize` below is already shaped for.
    storage: null,
    serialize: (t) => ({ id: t.id, ptyId: t.ptyId, label: t.label, cwd: t.cwd }),
    deserialize: (raw) => {
      if (!isRecord(raw)) return null;
      if (
        typeof raw.id !== "string" ||
        typeof raw.ptyId !== "string" ||
        typeof raw.label !== "string" ||
        typeof raw.cwd !== "string"
      ) {
        return null;
      }
      return { id: raw.id, ptyId: raw.ptyId, label: raw.label, cwd: raw.cwd };
    },
    equals: (a, b) => a.id === b.id,
    label: (t) => t.label,
    closedSnapshot: () => null,
  },

  diff: {
    kind: "diff",
    stateKey: "diffTabsByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "diffs" },
    serialize: (t) => ({ id: t.id, filePath: t.filePath }),
    deserialize: (raw) => filePathTab<DiffTab>(raw),
    equals: (a, b) => a.filePath === b.filePath,
    label: (t) => basename(t.filePath),
    closedSnapshot: (t) => ({ type: "diff", filePath: t.filePath }),
  },

  compare: {
    kind: "compare",
    stateKey: "compareTabsByWorktree",
    storage: { key: STORAGE_KEYS.compareTabs },
    serialize: (t) => ({ ...t }),
    deserialize: (raw) => {
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
        selectedFilePath:
          typeof raw.selectedFilePath === "string" ? raw.selectedFilePath : null,
        treeMode: raw.treeMode === "flat" ? "flat" : "tree",
        treeFilter: typeof raw.treeFilter === "string" ? raw.treeFilter : "",
      };
    },
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
    deserialize: (raw) => {
      if (!isRecord(raw)) return null;
      if (
        typeof raw.id !== "string" ||
        typeof raw.trunk !== "string" ||
        typeof raw.topBranch !== "string"
      ) {
        return null;
      }
      return { id: raw.id, trunk: raw.trunk, topBranch: raw.topBranch };
    },
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
    equals: (a, b) => a.filePath === b.filePath,
    label: (t) => basename(t.filePath),
    // A conflict tab is opened *by* the conflicted state of the repo, not by
    // the user; reopening one whose conflict is resolved would be a lie.
    closedSnapshot: () => null,
  },

  history: {
    kind: "history",
    stateKey: "historyTabsByWorktree",
    storage: null,
    serialize: (t) => ({ id: t.id }),
    deserialize: (raw) => idOnlyTab<HistoryTab>(raw),
    // Repo-wide, one per worktree: any two history tabs are the same tab.
    equals: () => true,
    label: () => "History",
    closedSnapshot: () => null,
  },

  preview: {
    kind: "preview",
    stateKey: "previewTabsByWorktree",
    storage: { key: STORAGE_KEYS.editorTabs, field: "previews" },
    serialize: (t) => ({ id: t.id, filePath: t.filePath }),
    deserialize: (raw) => filePathTab<PreviewTab>(raw),
    equals: (a, b) => a.filePath === b.filePath,
    label: (t) => basename(t.filePath),
    closedSnapshot: () => null,
  },

  brain: {
    kind: "brain",
    stateKey: "brainTabsByWorktree",
    storage: null,
    serialize: (t) => ({ id: t.id }),
    deserialize: (raw) => idOnlyTab<BrainTab>(raw),
    equals: () => true,
    label: () => "Brain",
    closedSnapshot: () => null,
  },

  browser: {
    kind: "browser",
    stateKey: "browserTabsByWorktree",
    storage: { key: STORAGE_KEYS.browserTabs },
    serialize: (t) => (t.title === undefined ? { id: t.id, url: t.url } : { ...t }),
    deserialize: (raw) => {
      if (!isRecord(raw)) return null;
      if (typeof raw.id !== "string" || typeof raw.url !== "string") return null;
      return {
        id: raw.id,
        url: raw.url,
        // Absent in state persisted before titles were tracked; the tab
        // label falls back to the host until the page reports one.
        title: typeof raw.title === "string" ? raw.title : undefined,
      };
    },
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
    closedSnapshot: () => null,
  },
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
  "brain",
  "browser",
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

/// The four kinds the editor window renders. The workbench renders the other
/// six, and each window has its own active-item pointer.
export const EDITOR_TAB_KINDS: TabKind[] = ["file", "diff", "conflict", "preview"];

export function isEditorKind(kind: string): boolean {
  return EDITOR_TAB_KINDS.includes(kind as TabKind);
}

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
