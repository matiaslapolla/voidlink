/// Which edge each sidebar is docked to, in which order, and which of them are
/// living in a window of their own.
///
/// This replaces `sidebarsSwapped: boolean`, which was one knob for a question
/// that has three answers. A single global flip is why the vertical-tabs layout
/// had to stack the file explorer *on top of* the git panel in one column:
/// there was no way to say "this panel goes on that edge", so the two panels
/// that wanted the right edge had to share a column.
///
/// Three values describe the arrangement and all three are persisted:
///
///   • `dockSide` — the edge each sidebar is on.
///   • `dockOrder` — one array in **screen order, left to right**, shared by
///     both edges. A left-edge stack renders the ids it owns in this order; so
///     does the right-edge stack. One array rather than two because a sidebar
///     that changes edge would otherwise have to be removed from one list and
///     inserted into another as two writes, and the intermediate state (in
///     neither list, or in both) is a sidebar that is briefly nowhere.
///   • `detachedSidebars` — the ones rendering in their own OS window. The
///     shell renders nothing for them and the slot collapses.
///
/// Everything here is pure. The store owns the writes (`store/layout/index.ts`),
/// `AppShell` composes the geometry, and the sidebar components know nothing
/// about the arrangement beyond the `dock` prop they are handed.

/// The three dockable sidebars. Also the only ids a persisted arrangement may
/// contain: a blob written by a build that knows a fourth is repaired against
/// this list rather than rejected, exactly as `parseGitSectionOrder` does for
/// the git sidebar's sections.
export type SidebarId = "workspaces" | "files" | "git";

export type DockSide = "left" | "right";

export const SIDEBAR_IDS: SidebarId[] = ["workspaces", "files", "git"];

export function isSidebarId(value: unknown): value is SidebarId {
  return typeof value === "string" && (SIDEBAR_IDS as string[]).includes(value);
}

/// Today's layout, and what a first run gets: the rail and the files/terminals
/// sidebar on the left, the git panel on the right.
export const DEFAULT_DOCK_SIDE: Record<SidebarId, DockSide> = {
  workspaces: "left",
  files: "left",
  git: "right",
};

/// What `sidebarsSwapped: true` produced, expressed in the new model.
///
/// It is not a mirror of the default. The old flag swapped the *two* sidebar
/// slots either side of the workbench and never touched the rail, which stayed
/// pinned to the far left — so a swapped layout was rail, git, workbench, files.
export const SWAPPED_DOCK_SIDE: Record<SidebarId, DockSide> = {
  workspaces: "left",
  files: "right",
  git: "left",
};

export const DEFAULT_DOCK_ORDER: SidebarId[] = ["workspaces", "files", "git"];

/// Repair a persisted `dockSide` map.
///
/// `legacySwapped` is the pre-dock `sidebarsSwapped` boolean off the same blob.
/// It is consulted **only** when there is no `dockSide` at all, which is what
/// makes this idempotent: a blob already in the new shape is passed through
/// untouched even if a stale `sidebarsSwapped` is still sitting beside it.
///
/// Unknown sidebar ids and values that are not an edge are dropped rather than
/// thrown on — a blob from a newer build that docks a fourth panel must still
/// place the three this build has.
export function parseDockSide(
  raw: unknown,
  legacySwapped?: unknown,
): Record<SidebarId, DockSide> {
  const base = legacySwapped === true ? SWAPPED_DOCK_SIDE : DEFAULT_DOCK_SIDE;
  const out: Record<SidebarId, DockSide> = { ...base };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSidebarId(key)) continue;
    if (value !== "left" && value !== "right") continue;
    out[key] = value;
  }
  return out;
}

/// Repair a persisted order: drop unknown ids, drop duplicates, append anything
/// missing in its shipped position. Modelled on `parseGitSectionOrder` — and
/// like it, never throws the user's arrangement away over one bad entry.
export function parseDockOrder(raw: unknown): SidebarId[] {
  const seen = new Set<SidebarId>();
  const out: SidebarId[] = [];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (!isSidebarId(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of DEFAULT_DOCK_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

/// Repair a persisted detached list. Same rules; the result is deduplicated and
/// contains only ids this build can actually render in a window.
export function parseDetachedSidebars(raw: unknown): SidebarId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<SidebarId>();
  for (const id of raw) if (isSidebarId(id)) seen.add(id);
  return DEFAULT_DOCK_ORDER.filter((id) => seen.has(id));
}

/// The ids docked to one edge, in screen order.
export function sidebarsOnSide(
  order: readonly SidebarId[],
  sides: Record<SidebarId, DockSide>,
  side: DockSide,
  detached: readonly SidebarId[] = [],
): SidebarId[] {
  return order.filter((id) => sides[id] === side && !detached.includes(id));
}

/// Move `id` so it renders immediately before `beforeId` (or last, for `null`).
///
/// Returns the input array when nothing would move, so a drop that lands a
/// sidebar back where it started writes no new value and the store's persistence
/// effect has nothing to do.
export function moveInDockOrder(
  order: readonly SidebarId[],
  id: SidebarId,
  beforeId: SidebarId | null,
): SidebarId[] {
  if (beforeId === id) return [...order];
  const rest = order.filter((x) => x !== id);
  const at = beforeId ? rest.indexOf(beforeId) : -1;
  if (at === -1) rest.push(id);
  else rest.splice(at, 0, id);
  return rest;
}

/// Flip the whole arrangement across the window's vertical axis.
///
/// This is what became of `toggleSidebarsSwapped`: the old flag was a two-state
/// toggle, and mirroring is the same *gesture* expressed in a model that has
/// more than two states — every panel changes edge, and the order reverses so a
/// panel that was outermost on the left is outermost on the right. Mirroring
/// twice is the identity, which is the property the old toggle actually had and
/// the one the ⌘\ chord's users are relying on.
export function mirrorArrangement(input: {
  sides: Record<SidebarId, DockSide>;
  order: readonly SidebarId[];
}): { sides: Record<SidebarId, DockSide>; order: SidebarId[] } {
  const sides = {} as Record<SidebarId, DockSide>;
  for (const id of SIDEBAR_IDS) sides[id] = input.sides[id] === "left" ? "right" : "left";
  return { sides, order: [...input.order].reverse() };
}

/// Flex `order` for a sidebar's slot.
///
/// The one number that moves a panel from one edge to the other. `AppShell`
/// renders every slot **once, in a fixed DOM position**, and a dock change
/// rewrites this property instead of moving an element between two lists —
/// which is what keeps the workbench (and the live PTYs hanging off it) from
/// being torn down and rebuilt by a layout preference. The main surface sits at
/// 0; left-edge panels are negative, right-edge panels positive.
export function slotOrder(side: DockSide, index: number): number {
  return side === "left" ? index - 100 : index + 100;
}
