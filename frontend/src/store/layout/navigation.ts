/// Two per-worktree navigation structures, as pure reducers: the per-group tab
/// MRU that `Ctrl+Tab` cycles, and the back/forward history that
/// `ui.navigate-back` walks.
///
/// Both are deliberately DOM-free and store-free. The interesting cases —
/// "cycling twice and releasing lands on the second-most-recent tab", "going
/// back across a group boundary", "the history never grows without bound" — are
/// then testable without standing up a reactive root, which is the same bargain
/// `panes.ts` made for the split tree.
///
/// **Why MRU is per group and not per worktree.** A split is a statement that
/// two sets of tabs are being worked on side by side; a single MRU across both
/// would make `Ctrl+Tab` in the left pane jump to whatever you last touched in
/// the right one. The group is the unit the user is cycling within.
import type { ActiveItem } from "./tabs";

// ── Tab MRU ───────────────────────────────────────────────────────────────

/// Most-recently-used tab ids for one group, most recent first. Ids only — the
/// tabs themselves live in the registry's collections, and an entry naming a
/// tab that has since closed is filtered out on read rather than eagerly
/// deleted, so a close never has to touch every group's list.
export type MruList = string[];

/// A worktree's MRU lists, keyed by pane-group id.
export type GroupMru = Record<string, MruList>;

/// Move `tabId` to the front. Idempotent when it is already there, which is
/// what stops a re-render of the active tab from churning the list.
export function touchMru(list: MruList, tabId: string): MruList {
  if (list[0] === tabId) return list;
  return [tabId, ...list.filter((id) => id !== tabId)];
}

/// Forget a tab outright. Called when a tab closes for good; cycling itself
/// never removes anything.
export function removeFromMru(list: MruList, tabId: string): MruList {
  if (!list.includes(tabId)) return list;
  return list.filter((id) => id !== tabId);
}

/// Drop entries whose tabs no longer exist. Returns the same reference when
/// nothing changed so a Solid store write can be skipped.
export function pruneMru(list: MruList, liveIds: readonly string[]): MruList {
  const live = new Set(liveIds);
  if (list.every((id) => live.has(id))) return list;
  return list.filter((id) => live.has(id));
}

/// The candidate list the MRU overlay shows, for one group.
///
/// Recorded order first, then every tab in the group the user has not visited
/// yet, in strip order. A tab that has never been activated still has to be
/// reachable — otherwise a freshly-split group with two untouched tabs would
/// have an empty cycle.
export function mruOrder(list: MruList, groupTabIds: readonly string[]): string[] {
  const inGroup = new Set(groupTabIds);
  const ordered = list.filter((id) => inGroup.has(id));
  const seen = new Set(ordered);
  return [...ordered, ...groupTabIds.filter((id) => !seen.has(id))];
}

/// Where `steps` presses of `Ctrl+Tab` land, wrapping in both directions.
///
/// `steps` counts from the *current* tab, which sits at index 0 of a freshly
/// built order — so one press is the previously-used tab, the behaviour every
/// alt-tab-shaped switcher has.
export function mruIndexAfter(count: number, steps: number): number {
  if (count <= 0) return 0;
  return ((steps % count) + count) % count;
}

// ── Navigation history ────────────────────────────────────────────────────

/// One place the user has been. `groupId` is `null` for a target that does not
/// live in a pane group — an editor-window file, which the workbench opens but
/// never renders.
export interface NavEntry {
  groupId: string | null;
  item: ActiveItem;
  /// Line to reveal when the target is an editor tab. Absent for workbench
  /// tabs, which have no cursor to restore.
  line?: number;
}

/// A cursor into a list, not a stack: `index` is where the user currently is,
/// so going back and then activating something new truncates the forward tail
/// exactly the way a browser does.
export interface NavHistory {
  entries: NavEntry[];
  index: number;
}

/// Long enough that back is still useful after an afternoon, short enough that
/// the serialized blob stays small. Bounded from the *front*, so the oldest
/// entries are the ones that fall off.
export const NAV_HISTORY_LIMIT = 50;

export function emptyNavHistory(): NavHistory {
  return { entries: [], index: -1 };
}

export function sameNavEntry(a: NavEntry | undefined, b: NavEntry | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.groupId === b.groupId &&
    a.item.type === b.item.type &&
    a.item.id === b.item.id &&
    (a.line ?? null) === (b.line ?? null)
  );
}

/// Record a visit.
///
/// Deduping is against `entries[index]` — the entry the user is standing on —
/// rather than against the tail. That one choice is what makes back/forward
/// self-consistent without a suppression flag: navigating back sets the index
/// to N, the activation that follows re-reports `entries[N]`, and this returns
/// the history untouched instead of pushing a duplicate and stranding the
/// forward tail.
export function pushNav(history: NavHistory, entry: NavEntry): NavHistory {
  if (sameNavEntry(history.entries[history.index], entry)) return history;
  const kept = history.entries.slice(0, history.index + 1);
  kept.push(entry);
  const overflow = Math.max(0, kept.length - NAV_HISTORY_LIMIT);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, index: entries.length - 1 };
}

export function canNavigateBack(history: NavHistory): boolean {
  return history.index > 0;
}

export function canNavigateForward(history: NavHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/// Step the cursor. Returns the same history and a `null` entry when there is
/// nowhere to go, so the caller never has to check first.
export function stepNav(
  history: NavHistory,
  direction: -1 | 1,
): { history: NavHistory; entry: NavEntry | null } {
  const next = history.index + direction;
  if (next < 0 || next >= history.entries.length) return { history, entry: null };
  return { history: { ...history, index: next }, entry: history.entries[next] };
}

/// Forget entries pointing at tabs that are gone, keeping the cursor on the
/// nearest surviving entry. A history full of dead tabs is worse than a short
/// one: every press of back would be a silent no-op.
export function pruneNav(history: NavHistory, liveIds: readonly string[]): NavHistory {
  const live = new Set(liveIds);
  const keep = (e: NavEntry) => live.has(e.item.id);
  if (history.entries.every(keep)) return history;
  const entries: NavEntry[] = [];
  let index = -1;
  history.entries.forEach((entry, i) => {
    if (!keep(entry)) return;
    entries.push(entry);
    if (i <= history.index) index = entries.length - 1;
  });
  return { entries, index: entries.length === 0 ? -1 : Math.max(0, index) };
}

// ── Persistence ───────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const ITEM_TYPES = new Set([
  "terminal",
  "diff",
  "file",
  "compare",
  "stack",
  "conflict",
  "history",
  "preview",
  "brain",
  "browser",
]);

function parseItem(raw: unknown): ActiveItem | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.type !== "string" || !ITEM_TYPES.has(raw.type)) return null;
  if (typeof raw.id !== "string") return null;
  if ((raw.type === "file" || raw.type === "preview") && typeof raw.path !== "string") {
    return null;
  }
  return raw as unknown as ActiveItem;
}

function parseEntry(raw: unknown): NavEntry | null {
  if (!isRecord(raw)) return null;
  const item = parseItem(raw.item);
  if (!item) return null;
  return {
    groupId: typeof raw.groupId === "string" ? raw.groupId : null,
    item,
    ...(typeof raw.line === "number" && Number.isFinite(raw.line) ? { line: raw.line } : {}),
  };
}

/// Rebuild one worktree's history from disk. A malformed entry costs that entry
/// and nothing else — the same quarantine policy `persistence.ts` applies per
/// key, applied here per row.
export function parseNavHistory(raw: unknown): NavHistory {
  if (!isRecord(raw)) return emptyNavHistory();
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map(parseEntry).filter((e): e is NavEntry => e !== null)
    : [];
  if (entries.length === 0) return emptyNavHistory();
  const stored = typeof raw.index === "number" ? raw.index : entries.length - 1;
  return { entries, index: Math.max(0, Math.min(entries.length - 1, Math.trunc(stored))) };
}

export function parseNavHistories(
  raw: unknown,
  worktreeIds: readonly string[],
): Record<string, NavHistory> {
  const record = isRecord(raw) ? raw : {};
  const out: Record<string, NavHistory> = {};
  for (const wtId of worktreeIds) out[wtId] = parseNavHistory(record[wtId]);
  return out;
}

/// Rebuild one worktree's per-group MRU lists, dropping anything that is not a
/// list of strings.
export function parseGroupMru(raw: unknown): GroupMru {
  if (!isRecord(raw)) return {};
  const out: GroupMru = {};
  for (const [groupId, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    out[groupId] = list.filter((id): id is string => typeof id === "string");
  }
  return out;
}

export function parseGroupMrus(
  raw: unknown,
  worktreeIds: readonly string[],
): Record<string, GroupMru> {
  const record = isRecord(raw) ? raw : {};
  const out: Record<string, GroupMru> = {};
  for (const wtId of worktreeIds) out[wtId] = parseGroupMru(record[wtId]);
  return out;
}
