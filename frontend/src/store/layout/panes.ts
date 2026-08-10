/// The pane tree: any number of tab groups in a recursive split, per worktree.
///
/// `MainSurface` renders exactly one pane at a time today. This module is the
/// state half of letting it render several — a pure, DOM-free reducer over a
/// binary-ish split tree, so the interesting cases (a group collapsing when its
/// last tab closes, ratios renormalising after a collapse) are testable without
/// standing up a component.
///
/// **There is no group cap.** There was one — eight — and it was the wrong
/// shape of limit: someone running a dozen agent terminals wants all of them on
/// screen, and the reducer is recursive and has never cared how many leaves it
/// holds. What actually bounds the count is *pixels*, not a constant here: a
/// pane below roughly 120px is unusable, so the window size decides how many
/// panes are worth having. That floor is enforced at render/drag time in
/// `MainSurface`/`paneDrop`, where pixels exist; this file stays fractions-only.
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
    // Unclaimed tabs fall to the first group, **after** its claims.
    //
    // They used to be stacked in *front* of them, and that quietly broke every
    // drop into the first pane: a tab dropped there becomes claimed, so it
    // sorted behind every unclaimed tab no matter where the user aimed.
    // "Drop it second" and "drop it last" were the same gesture, and
    // `moveTabToGroup`'s careful `beforeTabId` arithmetic was discarded one
    // line later.
    //
    // Appending works because ordering the first group is what *makes* its
    // tabs claimed: `moveTabToGroup` materialises the whole resolved list
    // before inserting, so by the time a claim exists here, everything the
    // user has placed is in it. What is left unclaimed is what has been opened
    // since — and a newly opened tab belongs at the end, which is where opening
    // one has always put it.
    const unclaimed = allTabIds.filter((id) => !claimed.has(id));
    out.set(first.id, [...(out.get(first.id) ?? []), ...unclaimed]);
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

/// Normalise to exactly `count` entries summing to 1, none of them zero or
/// negative. Called on the way out of every mutation, so no consumer ever has
/// to defend against a tree whose ratios don't add up.
///
/// **It deliberately enforces no minimum share.** It used to water-fill each
/// entry up to a `MIN_RATIO` of 0.1, which is a rule that cannot survive an
/// unbounded group count: eleven panes cannot all have a tenth of the window,
/// and the old code detected that and silently fell back to even ratios —
/// throwing away a layout the user had arranged by hand. "Usable width" is a
/// question about pixels, and this file has none. The floor now lives where the
/// pixels are (`MIN_PANE_PX` in `paneDrop`, applied by the splitter's clamps),
/// which is also the only place it can degrade gracefully when the window is
/// too small for the number of panes in it.
///
/// A non-finite or non-positive entry is still replaced — with the even share,
/// not with zero — because a ratio of 0 is a pane that exists in the tree and
/// nowhere on screen, which is worse than a wrong-but-visible width.
export function normalizeRatios(ratios: number[], count: number): number[] {
  const n = Math.max(1, count);
  const even = 1 / n;
  const raw = Array.from({ length: n }, (_, i) => {
    const v = ratios[i];
    return Number.isFinite(v) && v > 0 ? v : even;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  // `raw` is all finite and positive, so `total` is too — no divide-by-zero.
  return raw.map((v) => v / total);
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
/// Returns the new group's id alongside the tree so the caller can move a tab
/// into it in the same gesture. The only refusal left is a `groupId` that is
/// not in the tree — there is no count at which a split stops being allowed.
///
/// `allTabIds` **materialises every group's claims first**, and a split is
/// exactly the moment that stops being optional. "Unclaimed tabs fall to the
/// first group" is a *positional* rule, and a split with `placement: "before"`
/// changes which group is first: the fresh, empty group lands at the head of
/// the tree and inherits every tab nobody had claimed, while the group the user
/// actually split resolves to nothing. The visible result was every tab jumping
/// into the new pane and the old one collapsing as empty — a split that ate the
/// pane it was splitting. Writing the claims down before restructuring means no
/// group depends on its position any more.
export function splitGroup(
  node: PaneNode,
  groupId: string,
  orientation: SplitOrientation,
  placement: "before" | "after",
  allTabIds: readonly string[] = [],
): { layout: PaneNode; newGroupId: string | null } {
  if (!findGroup(node, groupId)) return { layout: node, newGroupId: null };

  const base = allTabIds.length > 0 ? materializeClaims(node, allTabIds) : node;
  const fresh = makeGroup();
  const layout = mapTree(base, (n) => {
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

/// Write every group's *resolved* tab list into its claims.
///
/// Turns the implicit "unclaimed falls to the first group" rule into explicit
/// membership, so nothing downstream depends on which group happens to be
/// first. Idempotent, and a no-op for a tree that is already explicit.
function materializeClaims(node: PaneNode, allTabIds: readonly string[]): PaneNode {
  const resolved = resolveGroupTabs(node, [...allTabIds]);
  return mapTree(node, (n) => {
    if (n.kind !== "group") return n;
    const tabIds = resolved.get(n.group.id) ?? n.group.tabIds;
    if (
      tabIds.length === n.group.tabIds.length &&
      tabIds.every((id, i) => id === n.group.tabIds[i])
    ) {
      return n;
    }
    return { ...n, group: { ...n.group, tabIds: [...tabIds] } };
  });
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
///
/// `allTabIds` is what makes a *position* meaningful in the first group.
/// Without it the target's order is only its explicit claims, and the first
/// group's unclaimed tabs — which is most of them until somebody splits — are
/// not in that list at all, so `beforeTabId` names a tab the insertion cannot
/// see and every drop appends. Passing the registry lets the target
/// materialise its resolved order first, so a drop lands where the user
/// pointed and everything that was implicit about the order becomes explicit
/// at the moment the user first cares about it.
export function moveTabToGroup(
  node: PaneNode,
  tabId: string,
  toGroupId: string,
  beforeTabId: string | null,
  allTabIds: readonly string[] = [],
): PaneNode {
  if (!findGroup(node, toGroupId)) return node;
  // Only when a registry was actually passed. `resolveGroupTabs` filters by
  // what is live, so handing it an empty registry answers "no group holds
  // anything" — and using *that* as the base order would erase every claim the
  // tree has, which is a far worse failure than ignoring a drop position.
  const resolved = allTabIds.length > 0 ? resolveGroupTabs(node, [...allTabIds]) : null;
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
    // The group's *resolved* order, not just its explicit claims — see the
    // header. Falls back to the claims when the caller passed no registry,
    // which is what every test that does not care about position does.
    const base = resolved?.get(n.group.id) ?? n.group.tabIds;
    const without = base.filter((id) => id !== tabId);
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
/// that keeps a split from rotting into dead rectangles.
///
/// "Empty" is judged by the group's *resolved* tabs, not its raw `tabIds` —
/// the two disagree for whichever group is currently catching unclaimed tabs,
/// whose explicit claim list is `[]` even while it is showing several. Using
/// the raw list (as this used to) meant exempting `groups[0]` by id, on the
/// assumption that array position and "the catch-all" are the same group.
/// They stop being the same the moment a `before` split puts a genuinely new,
/// empty group at position 0 and materialises every other group's claims —
/// see `splitGroup`'s header. That group is no longer catching anything, but
/// the id-based exemption still protected it, so closing the one tab someone
/// then dropped into it left an empty pane with no way to collapse short of a
/// reload. Resolving first is what makes the check mean "is this group
/// showing anything" regardless of where it sits in the tree; the *last*
/// group is still protected, but by `removeGroup`'s own count guard below, not
/// by a position it may no longer deserve.
///
/// `collapsible` narrows *which* empty groups may go. Without it, "empty"
/// alone decides — and a group is at its emptiest one instant after it is
/// created. A split makes a fresh group and the caller fills it; anything that
/// ran the prune in between deleted the pane before its tab arrived, so the
/// drop landed in a group that no longer existed and the tab never moved. The
/// store passes the set of groups that *had* tabs and now have none, which is
/// the actual condition the behaviour above describes.
export function pruneClosedTabs(
  node: PaneNode,
  allTabIds: string[],
  collapsible?: ReadonlySet<string>,
): PaneNode {
  const live = new Set(allTabIds);
  const groups = groupList(node);
  const resolved = resolveGroupTabs(node, allTabIds);
  // Nothing to prune is the overwhelmingly common case — this runs on every
  // change to the tree, which during a splitter drag means every frame. An
  // O(groups) scan with no allocation lets the caller compare the result by
  // *reference*, where it used to `JSON.stringify` the whole tree twice a frame
  // to find out that nothing had happened.
  const canCollapse = (g: PaneGroup) =>
    (resolved.get(g.id)?.length ?? 0) === 0 &&
    (collapsible === undefined || collapsible.has(g.id));
  const stale = groups.some(
    (g) =>
      g.tabIds.some((id) => !live.has(id)) ||
      (g.activeTabId !== null && !live.has(g.activeTabId)) ||
      canCollapse(g),
  );
  if (!stale) return node;

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

  let out = cleaned;
  for (const g of groupList(cleaned)) {
    if (canCollapse(g)) out = removeGroup(out, g.id);
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
///
/// "Too many groups" is not malformed and never was — a tree saved by a build
/// with a higher cap, or a hand-edited blob, loads as written. The only counts
/// rejected are the impossible ones.
export function parsePaneLayout(raw: unknown): PaneNode | null {
  const node = parseNode(raw);
  if (!node) return null;
  if (groupCount(node) === 0) return null;
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
