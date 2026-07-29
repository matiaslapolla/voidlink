/// Tab groups: a named, coloured, collapsible set of tabs *inside* one pane
/// group.
///
/// ## The orthogonal-axis rule
///
/// `panes.ts` answers one question — **which rectangle is a tab in**. Its claim
/// model is load-bearing: an empty `tabIds` on the *first* `PaneGroup` means
/// "every tab nobody else claimed", which is what makes the unsplit default
/// identical to the workbench before splits existed.
///
/// This module answers a different question — **how are the tabs a pane group
/// already resolved to arranged within its strip**. It is a second axis, not a
/// second claim model:
///
///   • A tab in no tab group renders exactly as it does now.
///   • A tab group never spans two pane groups; a group whose members were
///     split across two strips would have no strip to render in.
///   • Moving a whole tab group to another pane group goes through
///     `moveTabToGroup` for each member (`moveTabGroupToPane` below), never by
///     writing `PaneGroup.tabIds` directly, so the two models cannot disagree
///     about who claims what.
///
/// ## Strip order
///
/// Groups render first, in their pane's array order, then ungrouped tabs in the
/// order the strip already had. Deriving a group's position from its first
/// member instead would make `reorderTabGroups` a no-op — the array order would
/// never be visible — and reordering groups within a strip is one of the four
/// things this module exists for.
///
/// ## Derived groups (auto-grouping)
///
/// A worktree can be in one of three modes. `off` is manual assignment. `kind`
/// and `worktree` *derive* the groups from tab metadata instead, and derived
/// groups are read-only: the first hand-edit materialises the derivation as
/// manual groups and drops the worktree back to `off`, so the user is never
/// fighting a rule that keeps undoing them.
///
/// Everything here is pure and DOM-free. `persistence.ts` is the only module
/// that touches storage; the store composes the two.
import { moveTabToGroup, newPaneId, type PaneNode } from "./panes";

/// Group colours come from the existing chart tokens rather than a new palette
/// — five distinguishable hues that every theme already defines.
export const TAB_GROUP_COLORS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const;

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

export const DEFAULT_TAB_GROUP_COLOR: TabGroupColor = "chart-1";

export interface TabGroup {
  id: string;
  label: string;
  color: TabGroupColor;
  /// Collapsed groups occupy one chip and render none of their members. A
  /// signal on a hidden member escalates to the chip (`store/activity.ts`) —
  /// a collapsed group must never be a place where activity goes to die.
  collapsed: boolean;
  /// Members, in the order they render inside the group.
  tabIds: string[];
  /// Produced by a derivation rather than by the user. Read-only; see the
  /// module comment.
  derived?: boolean;
}

/// How a worktree's tab groups are decided.
export type AutoGroupMode = "off" | "kind" | "worktree";

export const AUTO_GROUP_MODES: AutoGroupMode[] = ["off", "kind", "worktree"];

/// One worktree's tab groups, keyed by the id of the pane group they live in.
export interface TabGroupState {
  mode: AutoGroupMode;
  byPane: Record<string, TabGroup[]>;
}

export function emptyTabGroupState(): TabGroupState {
  return { mode: "off", byPane: {} };
}

export function newTabGroupId(): string {
  return newPaneId("tabgroup");
}

// ── Reading ───────────────────────────────────────────────────────────────

export function tabGroupsOfPane(state: TabGroupState, paneId: string): TabGroup[] {
  return state.byPane[paneId] ?? [];
}

/// Every group in the worktree, in pane order then array order.
export function allTabGroups(state: TabGroupState): TabGroup[] {
  return Object.values(state.byPane).flat();
}

export function findTabGroup(state: TabGroupState, groupId: string): TabGroup | null {
  for (const list of Object.values(state.byPane)) {
    const hit = list.find((g) => g.id === groupId);
    if (hit) return hit;
  }
  return null;
}

/// Which pane group holds `groupId`, or `null`.
export function paneOfTabGroup(state: TabGroupState, groupId: string): string | null {
  for (const [paneId, list] of Object.entries(state.byPane)) {
    if (list.some((g) => g.id === groupId)) return paneId;
  }
  return null;
}

/// The tab group holding `tabId`, or `null`. A tab is in at most one.
export function tabGroupOf(state: TabGroupState, tabId: string): TabGroup | null {
  for (const list of Object.values(state.byPane)) {
    const hit = list.find((g) => g.tabIds.includes(tabId));
    if (hit) return hit;
  }
  return null;
}

/// The colour least used in `paneId`, so a third group in a strip is not the
/// same hue as the first.
export function nextTabGroupColor(state: TabGroupState, paneId: string): TabGroupColor {
  const used = new Map<TabGroupColor, number>();
  for (const color of TAB_GROUP_COLORS) used.set(color, 0);
  for (const g of tabGroupsOfPane(state, paneId)) {
    used.set(g.color, (used.get(g.color) ?? 0) + 1);
  }
  let best: TabGroupColor = TAB_GROUP_COLORS[0];
  for (const color of TAB_GROUP_COLORS) {
    if ((used.get(color) ?? 0) < (used.get(best) ?? 0)) best = color;
  }
  return best;
}

// ── Strip entries ─────────────────────────────────────────────────────────

/// What one slot of a strip holds. The strip maps ids back to descriptors; the
/// arrangement decision is made here so it is checkable without a shell.
export type StripEntry =
  | { kind: "tab"; tabId: string }
  | { kind: "group"; group: TabGroup; tabIds: string[] };

/// Arrange one pane group's resolved tabs into strip slots.
///
/// `tabIds` is what `resolveGroupTabs` gave this pane, in strip order. A group
/// whose members have all been closed emits nothing — a group referencing a
/// closed tab id must render no ghost.
export function stripEntries(
  tabIds: readonly string[],
  groups: readonly TabGroup[],
): StripEntry[] {
  const live = new Set(tabIds);
  const out: StripEntry[] = [];
  const claimed = new Set<string>();
  for (const group of groups) {
    const members = group.tabIds.filter((id) => live.has(id));
    if (members.length === 0) continue;
    for (const id of members) claimed.add(id);
    out.push({ kind: "group", group, tabIds: members });
  }
  for (const id of tabIds) {
    if (!claimed.has(id)) out.push({ kind: "tab", tabId: id });
  }
  return out;
}

/// The tabs a strip actually renders a row for: everything except the members
/// of a collapsed group. `MainSurface` needs this to decide what is on screen.
export function visibleStripTabIds(entries: readonly StripEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "tab") out.push(entry.tabId);
    else if (!entry.group.collapsed) out.push(...entry.tabIds);
  }
  return out;
}

// ── Mutating ──────────────────────────────────────────────────────────────

function mapPane(
  state: TabGroupState,
  paneId: string,
  fn: (list: TabGroup[]) => TabGroup[],
): TabGroupState {
  const next = fn([...(state.byPane[paneId] ?? [])]);
  const byPane = { ...state.byPane };
  if (next.length === 0) delete byPane[paneId];
  else byPane[paneId] = next;
  return { ...state, byPane };
}

/// Map every group in the worktree, dropping the ones `fn` returns `null` for.
function mapGroups(
  state: TabGroupState,
  fn: (group: TabGroup, paneId: string) => TabGroup | null,
): TabGroupState {
  const byPane: Record<string, TabGroup[]> = {};
  for (const [paneId, list] of Object.entries(state.byPane)) {
    const next = list
      .map((g) => fn(g, paneId))
      .filter((g): g is TabGroup => g !== null);
    if (next.length > 0) byPane[paneId] = next;
  }
  return { ...state, byPane };
}

export interface CreateTabGroupOptions {
  label?: string;
  color?: TabGroupColor;
  tabIds?: readonly string[];
  id?: string;
}

/// Create a group in `paneId`. Its members leave whatever group they were in —
/// a tab belongs to at most one group.
export function createTabGroup(
  state: TabGroupState,
  paneId: string,
  opts: CreateTabGroupOptions = {},
): { state: TabGroupState; groupId: string } {
  const id = opts.id ?? newTabGroupId();
  const tabIds = [...(opts.tabIds ?? [])];
  // Strip the members out of their previous groups first, so the same tab is
  // never in two.
  let next = tabIds.length > 0 ? detachTabs(state, tabIds) : state;
  const group: TabGroup = {
    id,
    label: opts.label?.trim() || "Group",
    color: opts.color ?? nextTabGroupColor(next, paneId),
    collapsed: false,
    tabIds,
  };
  next = mapPane(next, paneId, (list) => [...list, group]);
  return { state: next, groupId: id };
}

export function renameTabGroup(
  state: TabGroupState,
  groupId: string,
  label: string,
): TabGroupState {
  const trimmed = label.trim();
  if (!trimmed) return state;
  return mapGroups(state, (g) => (g.id === groupId ? { ...g, label: trimmed } : g));
}

export function recolorTabGroup(
  state: TabGroupState,
  groupId: string,
  color: TabGroupColor,
): TabGroupState {
  return mapGroups(state, (g) => (g.id === groupId ? { ...g, color } : g));
}

export function setTabGroupCollapsed(
  state: TabGroupState,
  groupId: string,
  collapsed: boolean,
): TabGroupState {
  return mapGroups(state, (g) => (g.id === groupId ? { ...g, collapsed } : g));
}

export function toggleTabGroupCollapsed(
  state: TabGroupState,
  groupId: string,
): TabGroupState {
  return mapGroups(state, (g) => (g.id === groupId ? { ...g, collapsed: !g.collapsed } : g));
}

/// Remove `tabIds` from every group, dropping any group that empties.
function detachTabs(state: TabGroupState, tabIds: readonly string[]): TabGroupState {
  const drop = new Set(tabIds);
  return mapGroups(state, (g) => {
    if (!g.tabIds.some((id) => drop.has(id))) return g;
    const next = g.tabIds.filter((id) => !drop.has(id));
    return next.length === 0 ? null : { ...g, tabIds: next };
  });
}

/// Put `tabId` in `groupId`, landing before `beforeTabId` (or at the end). The
/// tab leaves whatever group it was in.
export function addTabToGroup(
  state: TabGroupState,
  groupId: string,
  tabId: string,
  beforeTabId: string | null = null,
): TabGroupState {
  if (!findTabGroup(state, groupId)) return state;
  // Detaching first can delete the target group when the tab was its only
  // member; re-check rather than resurrect it.
  const detached = detachTabs(state, [tabId]);
  if (!findTabGroup(detached, groupId)) {
    return mapGroups(state, (g) =>
      g.id === groupId ? { ...g, tabIds: insertBefore(g.tabIds, tabId, beforeTabId) } : g,
    );
  }
  return mapGroups(detached, (g) =>
    g.id === groupId ? { ...g, tabIds: insertBefore(g.tabIds, tabId, beforeTabId) } : g,
  );
}

function insertBefore(
  ids: readonly string[],
  tabId: string,
  beforeTabId: string | null,
): string[] {
  const without = ids.filter((id) => id !== tabId);
  const at = beforeTabId === null ? -1 : without.indexOf(beforeTabId);
  const out = [...without];
  out.splice(at === -1 ? without.length : at, 0, tabId);
  return out;
}

/// Take `tabId` out of whatever group holds it. The group goes with its last
/// member.
export function removeTabFromGroup(state: TabGroupState, tabId: string): TabGroupState {
  return detachTabs(state, [tabId]);
}

/// Drop the group, leaving its tabs in the strip ungrouped.
export function dissolveTabGroup(state: TabGroupState, groupId: string): TabGroupState {
  return mapGroups(state, (g) => (g.id === groupId ? null : g));
}

/// Move `groupId` before `beforeGroupId` within its own strip (or to the end).
export function reorderTabGroups(
  state: TabGroupState,
  groupId: string,
  beforeGroupId: string | null,
): TabGroupState {
  const paneId = paneOfTabGroup(state, groupId);
  if (!paneId) return state;
  return mapPane(state, paneId, (list) => {
    const from = list.findIndex((g) => g.id === groupId);
    if (from === -1) return list;
    const [moved] = list.splice(from, 1);
    const at = beforeGroupId === null ? -1 : list.findIndex((g) => g.id === beforeGroupId);
    list.splice(at === -1 ? list.length : at, 0, moved);
    return list;
  });
}

/// Move a whole tab group into another pane group.
///
/// The load-bearing line is the loop: every member is re-claimed through
/// `moveTabToGroup`, so `panes.ts` stays the single authority on which pane
/// owns which tab. Writing `PaneGroup.tabIds` here would let the two models
/// disagree, and the disagreement would show up as a tab that renders in one
/// strip and is claimed by another.
export function moveTabGroupToPane(
  state: TabGroupState,
  layout: PaneNode,
  groupId: string,
  toPaneId: string,
): { state: TabGroupState; layout: PaneNode } {
  const from = paneOfTabGroup(state, groupId);
  const group = findTabGroup(state, groupId);
  if (!group || !from || from === toPaneId) return { state, layout };

  let nextLayout = layout;
  for (const tabId of group.tabIds) {
    nextLayout = moveTabToGroup(nextLayout, tabId, toPaneId, null);
  }
  // The pane tree refused the move (no such pane): leave both halves alone
  // rather than stranding the group where nothing claims its tabs.
  if (nextLayout === layout) return { state, layout };

  let nextState = mapPane(state, from, (list) => list.filter((g) => g.id !== groupId));
  nextState = mapPane(nextState, toPaneId, (list) => [...list, group]);
  return { state: nextState, layout: nextLayout };
}

/// Forget tabs that are no longer open or that a pane no longer resolves to,
/// then drop any group left empty and any pane that no longer exists.
///
/// `paneTabIds` is `resolveGroupTabs`' output: pane group id → the tabs it
/// shows. Filtering against it is what stops a tab dragged into another pane
/// from carrying its old strip's grouping with it.
export function pruneTabGroups(
  state: TabGroupState,
  paneTabIds: ReadonlyMap<string, readonly string[]>,
): TabGroupState {
  const byPane: Record<string, TabGroup[]> = {};
  let changed = false;
  for (const [paneId, list] of Object.entries(state.byPane)) {
    const live = paneTabIds.get(paneId);
    if (!live) {
      changed = true;
      continue;
    }
    const liveSet = new Set(live);
    const next: TabGroup[] = [];
    for (const group of list) {
      const tabIds = group.tabIds.filter((id) => liveSet.has(id));
      if (tabIds.length === 0) {
        changed = true;
        continue;
      }
      if (tabIds.length !== group.tabIds.length) {
        changed = true;
        next.push({ ...group, tabIds });
      } else {
        next.push(group);
      }
    }
    if (next.length === 0) {
      if (list.length > 0) changed = true;
      continue;
    }
    byPane[paneId] = next;
  }
  return changed ? { ...state, byPane } : state;
}

// ── Derivation (auto-grouping) ────────────────────────────────────────────

/// How a derivation buckets tabs. `key` returns the bucket a tab belongs to
/// (`null` leaves it ungrouped) and `label` names the bucket.
///
/// A function rather than a hardcoded kind list: `TAB_SPECS` is the source of
/// kind metadata, and a mode that had its own copy of it would drift the first
/// time a kind was added.
export interface TabGroupDerivation {
  key: (tabId: string) => string | null;
  label: (key: string) => string;
}

/// Bucket every pane's tabs, producing one read-only group per bucket. Buckets
/// with a single member are not worth a chip — a group of one is more chrome
/// than the tab it wraps — so they are left ungrouped.
export function deriveTabGroups(
  paneTabIds: ReadonlyMap<string, readonly string[]>,
  derivation: TabGroupDerivation,
): Record<string, TabGroup[]> {
  const byPane: Record<string, TabGroup[]> = {};
  for (const [paneId, tabIds] of paneTabIds) {
    const buckets = new Map<string, string[]>();
    for (const tabId of tabIds) {
      const key = derivation.key(tabId);
      if (key === null) continue;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(tabId);
      else buckets.set(key, [tabId]);
    }
    const groups: TabGroup[] = [];
    let i = 0;
    for (const [key, members] of buckets) {
      if (members.length < 2) continue;
      groups.push({
        id: `auto:${paneId}:${key}`,
        label: derivation.label(key),
        color: TAB_GROUP_COLORS[i % TAB_GROUP_COLORS.length],
        collapsed: false,
        tabIds: members,
        derived: true,
      });
      i += 1;
    }
    if (groups.length > 0) byPane[paneId] = groups;
  }
  return byPane;
}

/// The groups a strip should render right now: the manual ones under `off`,
/// the derivation otherwise.
export function effectiveTabGroups(
  state: TabGroupState,
  paneTabIds: ReadonlyMap<string, readonly string[]>,
  derivation: TabGroupDerivation | null,
): Record<string, TabGroup[]> {
  if (state.mode === "off" || !derivation) return pruneTabGroups(state, paneTabIds).byPane;
  return deriveTabGroups(paneTabIds, derivation);
}

export function setAutoGroupMode(state: TabGroupState, mode: AutoGroupMode): TabGroupState {
  if (state.mode === mode) return state;
  // Switching *into* a derived mode discards the manual arrangement rather
  // than keeping a shadow copy that would reappear unannounced later.
  return mode === "off" ? { ...state, mode } : { mode, byPane: {} };
}

/// Freeze the current derivation as manual groups and drop back to `off`.
///
/// Every hand-edit of a derived group runs this first. That is the whole
/// contract of "derived groups are read-only": the edit lands, and the rule
/// that would have undone it stops applying.
export function materializeAutoGroups(
  state: TabGroupState,
  paneTabIds: ReadonlyMap<string, readonly string[]>,
  derivation: TabGroupDerivation | null,
): TabGroupState {
  if (state.mode === "off") return state;
  const derived = derivation ? deriveTabGroups(paneTabIds, derivation) : {};
  const byPane: Record<string, TabGroup[]> = {};
  for (const [paneId, list] of Object.entries(derived)) {
    byPane[paneId] = list.map((g) => ({
      id: g.id,
      label: g.label,
      color: g.color,
      collapsed: g.collapsed,
      tabIds: [...g.tabIds],
    }));
  }
  return { mode: "off", byPane };
}

// ── Persistence ───────────────────────────────────────────────────────────

/// Plain JSON already; the function exists so the read side has a named
/// counterpart and a future non-persisted field has one obvious place to be
/// dropped. Derived groups are deliberately *not* persisted — they are a
/// function of the mode and the open tabs, and a stale copy on disk would
/// resurrect groups for tabs that have since moved.
export function serializeTabGroupState(state: TabGroupState): unknown {
  return { mode: state.mode, byPane: state.mode === "off" ? state.byPane : {} };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const isColor = (v: unknown): v is TabGroupColor =>
  typeof v === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(v);

function parseTabGroup(raw: unknown): TabGroup | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (typeof raw.label !== "string") return null;
  if (!Array.isArray(raw.tabIds)) return null;
  const tabIds = raw.tabIds.filter((id): id is string => typeof id === "string");
  if (tabIds.length !== raw.tabIds.length) return null;
  return {
    id: raw.id,
    label: raw.label,
    color: isColor(raw.color) ? raw.color : DEFAULT_TAB_GROUP_COLOR,
    collapsed: raw.collapsed === true,
    tabIds,
  };
}

/// Rebuild one worktree's groups, rejecting anything malformed outright rather
/// than half-applying it. A partially-honoured arrangement is worse than none:
/// none is the strip the user already knows.
export function parseTabGroupState(raw: unknown): TabGroupState | null {
  if (!isRecord(raw)) return null;
  const mode: AutoGroupMode = AUTO_GROUP_MODES.includes(raw.mode as AutoGroupMode)
    ? (raw.mode as AutoGroupMode)
    : "off";
  if (!isRecord(raw.byPane)) return null;
  const byPane: Record<string, TabGroup[]> = {};
  const seenIds = new Set<string>();
  const seenTabs = new Set<string>();
  for (const [paneId, list] of Object.entries(raw.byPane)) {
    if (!Array.isArray(list)) return null;
    const groups: TabGroup[] = [];
    for (const entry of list) {
      const group = parseTabGroup(entry);
      if (!group) return null;
      // Duplicate ids would make every lookup ambiguous, and a tab in two
      // groups would render twice.
      if (seenIds.has(group.id)) return null;
      seenIds.add(group.id);
      for (const tabId of group.tabIds) {
        if (seenTabs.has(tabId)) return null;
        seenTabs.add(tabId);
      }
      groups.push(group);
    }
    if (groups.length > 0) byPane[paneId] = groups;
  }
  return { mode, byPane };
}

/// Read a whole `Record<worktreeId, TabGroupState>` off disk, seeding the empty
/// default for every worktree the blob doesn't cover or covers badly.
export function parseTabGroupStates(
  raw: unknown,
  worktreeIds: string[],
): Record<string, TabGroupState> {
  const out: Record<string, TabGroupState> = {};
  const record = isRecord(raw) ? raw : {};
  for (const wtId of worktreeIds) {
    out[wtId] = parseTabGroupState(record[wtId]) ?? emptyTabGroupState();
  }
  return out;
}
