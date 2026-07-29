/// The pane tree: 1–4 tab groups in a recursive split, per worktree.
///
/// `MainSurface` renders exactly one pane at a time today. This module is the
/// state half of letting it render several — a pure, DOM-free reducer over a
/// binary-ish split tree, so the interesting cases (a group collapsing when its
/// last tab closes, ratios renormalising after a collapse, the four-group cap)
/// are testable without standing up a component.
///
/// **The default is load-bearing.** A worktree with no saved layout gets one
/// group whose `tabIds` is empty, and an empty `tabIds` on the *first* group
/// means "every tab nobody else claimed". So the default layout renders exactly
/// today's workbench — one strip, every tab, in registry order — with no
/// special-casing at the render site and nothing to migrate. Splitting is what
/// starts assigning ids; until then the structure is inert.
///
/// Geometry is per worktree and lives in localStorage next to the rest of the
/// layout state. It is not per window and is not synced across windows.

/// `row` lays children out left-to-right (a vertical splitter between them);
/// `column` lays them top-to-bottom.
export type SplitOrientation = "row" | "column";

export interface PaneGroup {
  id: string;
  /// Tabs this group has claimed, in strip order. Empty on the first group
  /// means "everything unclaimed" — see the module comment.
  tabIds: string[];
  /// Which of its tabs is in front. `null` falls back to the worktree's global
  /// active item, which is what keeps the single-group case identical to today.
  activeTabId: string | null;
}

export type PaneNode =
  | { kind: "group"; id: string; group: PaneGroup }
  | {
      kind: "split";
      id: string;
      orientation: SplitOrientation;
      /// One per child, summing to 1. Always normalised on the way out of
      /// every operation in this file.
      ratios: number[];
      children: PaneNode[];
    };

/// Four covers terminal-beside-graph-beside-browser, which is the case the
/// split exists for. A free-form grid is a different feature.
export const MAX_GROUPS = 4;

/// Below this a group is unusable — no room for a tab label, let alone a pane.
/// The reducer refuses splits that would push any sibling under it. Exported
/// because the splitter between two groups has to clamp to the same number the
/// reducer would renormalise to; two different minimums would mean a drag that
/// silently snaps back.
export const MIN_RATIO = 0.1;

let idCounter = 0;
/// Ids only have to be unique within one worktree's tree and stable across a
/// reload. `crypto.randomUUID` is available everywhere this runs, but a
/// counter-suffixed id is far easier to read in a persisted blob and in a
/// failing test's diff.
export function newPaneId(prefix = "pane"): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function makeGroup(id = newPaneId("group")): PaneGroup {
  return { id, tabIds: [], activeTabId: null };
}

/// The layout every worktree starts with: one group, claiming nothing.
export function singleGroupLayout(groupId?: string): PaneNode {
  const group = makeGroup(groupId);
  return { kind: "group", id: group.id, group };
}

// ── Reading ───────────────────────────────────────────────────────────────

/// Every group, in visual order (left-to-right, then top-to-bottom).
export function groupList(node: PaneNode): PaneGroup[] {
  if (node.kind === "group") return [node.group];
  return node.children.flatMap(groupList);
}

export function groupCount(node: PaneNode): number {
  return groupList(node).length;
}

export function findGroup(node: PaneNode, groupId: string): PaneGroup | null {
  return groupList(node).find((g) => g.id === groupId) ?? null;
}

/// Whether another split is allowed. Exposed so the drop target can refuse with
/// `no-drop` and a stated reason instead of silently doing nothing.
export function canSplit(node: PaneNode): boolean {
  return groupCount(node) < MAX_GROUPS;
}

/// Resolve which tabs each group shows, given every tab the worktree has open
/// in registry order.
///
/// Claims win, and anything unclaimed falls to the first group — the rule that
/// makes the default layout render today's workbench. A claimed id that no
/// longer exists is ignored rather than rendered as a ghost tab.
export function resolveGroupTabs(
  node: PaneNode,
  allTabIds: string[],
): Map<string, string[]> {
  const groups = groupList(node);
  const live = new Set(allTabIds);
  const claimed = new Set<string>();
  for (const g of groups) {
    for (const id of g.tabIds) if (live.has(id)) claimed.add(id);
  }
  const out = new Map<string, string[]>();
  for (const g of groups) {
    out.set(
      g.id,
      g.tabIds.filter((id) => live.has(id)),
    );
  }
  const first = groups[0];
  if (first) {
    // Registry order, not claim order: an unclaimed tab has never been placed,
    // so the only order it has is the one the strip already used.
    const unclaimed = allTabIds.filter((id) => !claimed.has(id));
    out.set(first.id, [...unclaimed, ...(out.get(first.id) ?? [])]);
  }
  return out;
}

/// Which group currently owns `tabId`, honouring the unclaimed-falls-to-first
/// rule. `null` only when the id is not open at all.
export function groupOwning(
  node: PaneNode,
  tabId: string,
  allTabIds: string[],
): string | null {
  for (const [groupId, ids] of resolveGroupTabs(node, allTabIds)) {
    if (ids.includes(tabId)) return groupId;
  }
  return null;
}

// ── Ratios ────────────────────────────────────────────────────────────────

/// Normalise to sum 1 with every entry at or above `MIN_RATIO`. Called on the
/// way out of every mutation, so no consumer ever has to defend against a
/// tree whose ratios don't add up.
export function normalizeRatios(ratios: number[], count: number): number[] {
  const even = 1 / Math.max(1, count);
  const raw = Array.from({ length: count }, (_, i) => {
    const v = ratios[i];
    return Number.isFinite(v) && v > 0 ? v : even;
  });
  const clamped = raw.map((v) => Math.max(MIN_RATIO, v));
  const total = clamped.reduce((a, b) => a + b, 0);
  return clamped.map((v) => v / total);
}

/// Resize one split. `ratios` is taken as a proposal and normalised.
export function setSplitRatios(
  node: PaneNode,
  splitId: string,
  ratios: number[],
): PaneNode {
  return mapTree(node, (n) =>
    n.kind === "split" && n.id === splitId
      ? { ...n, ratios: normalizeRatios(ratios, n.children.length) }
      : n,
  );
}

/// Structural map, bottom-up. Every mutation below is expressed through it so
/// none of them mutate the input — the tree goes into a Solid store, where an
/// in-place edit would not be seen.
function mapTree(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (node.kind === "group") return fn(node);
  const children = node.children.map((c) => mapTree(c, fn));
  return fn({ ...node, children });
}

// ── Splitting ─────────────────────────────────────────────────────────────

/// Split `groupId`, putting a fresh empty group on `placement`'s side of it.
/// Returns the tree unchanged at the four-group cap, and the new group's id
/// alongside so the caller can move a tab into it in the same gesture.
export function splitGroup(
  node: PaneNode,
  groupId: string,
  orientation: SplitOrientation,
  placement: "before" | "after",
): { layout: PaneNode; newGroupId: string | null } {
  if (!canSplit(node)) return { layout: node, newGroupId: null };
  if (!findGroup(node, groupId)) return { layout: node, newGroupId: null };

  const fresh = makeGroup();
  const layout = mapTree(node, (n) => {
    if (n.kind !== "group" || n.group.id !== groupId) return n;
    const leaf: PaneNode = { kind: "group", id: fresh.id, group: fresh };
    const children = placement === "before" ? [leaf, n] : [n, leaf];
    return {
      kind: "split",
      id: newPaneId("split"),
      orientation,
      ratios: normalizeRatios([], 2),
      children,
    };
  });
  return { layout: collapse(layout), newGroupId: fresh.id };
}

// ── Removing ──────────────────────────────────────────────────────────────

/// Drop a group and collapse the split that held it. The last group is never
/// removable — a worktree always has somewhere to put a tab.
export function removeGroup(node: PaneNode, groupId: string): PaneNode {
  if (groupCount(node) <= 1) return node;
  const pruned = prune(node, groupId);
  return pruned ? collapse(pruned) : node;
}

function prune(node: PaneNode, groupId: string): PaneNode | null {
  if (node.kind === "group") return node.group.id === groupId ? null : node;
  const kept: PaneNode[] = [];
  const ratios: number[] = [];
  node.children.forEach((child, i) => {
    const next = prune(child, groupId);
    if (next === null) return;
    kept.push(next);
    ratios.push(node.ratios[i] ?? 0);
  });
  if (kept.length === 0) return null;
  return { ...node, children: kept, ratios: normalizeRatios(ratios, kept.length) };
}

/// Replace any split with a single child by that child, recursively. Runs after
/// every structural change so the tree never accumulates one-child splits.
function collapse(node: PaneNode): PaneNode {
  if (node.kind === "group") return node;
  const children = node.children.map(collapse);
  if (children.length === 1) return children[0];
  return { ...node, children, ratios: normalizeRatios(node.ratios, children.length) };
}

// ── Moving tabs ───────────────────────────────────────────────────────────

/// Move `tabId` into `toGroupId`, landing before `beforeTabId` (or at the end).
///
/// Every group the tab is not landing in gives up its claim, and the *source*
/// group's claim on it goes too — including the implicit claim the first group
/// has on unclaimed tabs, which is why the target's claim is written
/// explicitly rather than left to the fallback.
export function moveTabToGroup(
  node: PaneNode,
  tabId: string,
  toGroupId: string,
  beforeTabId: string | null,
): PaneNode {
  if (!findGroup(node, toGroupId)) return node;
  return mapTree(node, (n) => {
    if (n.kind !== "group") return n;
    if (n.group.id !== toGroupId) {
      if (!n.group.tabIds.includes(tabId)) return n;
      const tabIds = n.group.tabIds.filter((id) => id !== tabId);
      return {
        ...n,
        group: {
          ...n.group,
          tabIds,
          // The group just lost the tab it was showing.
          activeTabId:
            n.group.activeTabId === tabId ? (tabIds[tabIds.length - 1] ?? null) : n.group.activeTabId,
        },
      };
    }
    const without = n.group.tabIds.filter((id) => id !== tabId);
    const at = beforeTabId === null ? without.length : without.indexOf(beforeTabId);
    const tabIds = [...without];
    tabIds.splice(at === -1 ? without.length : at, 0, tabId);
    // A tab dropped into a group is the tab the user wants to look at.
    return { ...n, group: { ...n.group, tabIds, activeTabId: tabId } };
  });
}

/// Focus a tab inside its group without moving it.
export function setGroupActiveTab(
  node: PaneNode,
  groupId: string,
  tabId: string | null,
): PaneNode {
  return mapTree(node, (n) =>
    n.kind === "group" && n.group.id === groupId
      ? { ...n, group: { ...n.group, activeTabId: tabId } }
      : n,
  );
}

/// Forget tabs that are no longer open, then collapse any group left empty.
///
/// "Close the last tab in a group and the group goes away" is the behaviour
/// that keeps a split from rotting into dead rectangles. The first group is
/// exempt: it holds unclaimed tabs, so an empty claim list means "everything",
/// not "nothing".
export function pruneClosedTabs(node: PaneNode, allTabIds: string[]): PaneNode {
  const live = new Set(allTabIds);
  const cleaned = mapTree(node, (n) => {
    if (n.kind !== "group") return n;
    const tabIds = n.group.tabIds.filter((id) => live.has(id));
    const activeTabId =
      n.group.activeTabId && live.has(n.group.activeTabId) ? n.group.activeTabId : null;
    if (tabIds.length === n.group.tabIds.length && activeTabId === n.group.activeTabId) {
      return n;
    }
    return { ...n, group: { ...n.group, tabIds, activeTabId } };
  });

  const groups = groupList(cleaned);
  const firstId = groups[0]?.id;
  let out = cleaned;
  for (const g of groups) {
    if (g.id === firstId) continue;
    if (g.tabIds.length === 0) out = removeGroup(out, g.id);
  }
  return out;
}

// ── Persistence ───────────────────────────────────────────────────────────

/// `PaneNode` is already plain JSON, so serialising is identity. The function
/// exists so the read side has a named counterpart and so a future field that
/// should *not* be persisted has one obvious place to be dropped.
export function serializePaneLayout(node: PaneNode): unknown {
  return node;
}

/// Rewrite every tab reference in the tree through `map`, dropping the ones it
/// cannot translate (`null`).
///
/// This is what lets a snapshot carry pane geometry at all. A snapshot is
/// addressed by *content* — `file:/repo/main.ts`, not a uuid — so saving one
/// maps claims from tab ids to content keys and restoring one maps them back
/// to the freshly minted ids. Group ids and ratios are untouched: they name
/// panes, not tabs.
export function mapPaneTabIds(
  node: PaneNode,
  map: (tabId: string) => string | null,
): PaneNode {
  if (node.kind === "group") {
    const tabIds = node.group.tabIds
      .map(map)
      .filter((id): id is string => id !== null && id.length > 0);
    const active = node.group.activeTabId === null ? null : map(node.group.activeTabId);
    return {
      kind: "group",
      id: node.id,
      group: {
        id: node.group.id,
        tabIds,
        activeTabId: active && tabIds.includes(active) ? active : null,
      },
    };
  }
  return {
    kind: "split",
    id: node.id,
    orientation: node.orientation,
    ratios: [...node.ratios],
    children: node.children.map((child) => mapPaneTabIds(child, map)),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/// Rebuild a tree from disk, rejecting anything malformed outright rather than
/// half-honouring it. A partially-valid layout is worse than the default: the
/// default is a workbench that works.
export function parsePaneLayout(raw: unknown): PaneNode | null {
  const node = parseNode(raw);
  if (!node) return null;
  const count = groupCount(node);
  if (count === 0 || count > MAX_GROUPS) return null;
  const ids = groupList(node).map((g) => g.id);
  if (new Set(ids).size !== ids.length) return null;
  return collapse(node);
}

function parseNode(raw: unknown): PaneNode | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "group") {
    const group = raw.group;
    if (!isRecord(group) || typeof group.id !== "string") return null;
    const tabIds = Array.isArray(group.tabIds)
      ? group.tabIds.filter((id): id is string => typeof id === "string")
      : [];
    return {
      kind: "group",
      id: group.id,
      group: {
        id: group.id,
        tabIds,
        activeTabId: typeof group.activeTabId === "string" ? group.activeTabId : null,
      },
    };
  }
  if (raw.kind === "split") {
    if (raw.orientation !== "row" && raw.orientation !== "column") return null;
    if (!Array.isArray(raw.children)) return null;
    const children = raw.children.map(parseNode);
    if (children.some((c) => c === null) || children.length < 2) return null;
    const kids = children as PaneNode[];
    const ratios = Array.isArray(raw.ratios)
      ? raw.ratios.map((r) => (typeof r === "number" ? r : Number.NaN))
      : [];
    return {
      kind: "split",
      id: typeof raw.id === "string" ? raw.id : newPaneId("split"),
      orientation: raw.orientation,
      ratios: normalizeRatios(ratios, kids.length),
      children: kids,
    };
  }
  return null;
}

/// Read a whole `Record<worktreeId, PaneNode>` off disk, seeding the default
/// for every worktree the blob doesn't cover or covers badly.
export function parsePaneLayouts(
  raw: unknown,
  worktreeIds: string[],
): Record<string, PaneNode> {
  const out: Record<string, PaneNode> = {};
  const record = isRecord(raw) ? raw : {};
  for (const wtId of worktreeIds) {
    out[wtId] = parsePaneLayout(record[wtId]) ?? singleGroupLayout();
  }
  return out;
}
