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

/// The five dockable sidebars. Also the only ids a persisted arrangement may
/// contain: a blob written by a build that knows a sixth is repaired against
/// this list rather than rejected, exactly as `parseGitSectionOrder` does for
/// the git sidebar's sections.
///
/// `explorer` replaces `files` — see `LEGACY_SIDEBAR_ID_ALIASES` below for the
/// migration — and `terminals`/`agents` are new: they used to be two sections
/// stacked underneath the explorer inside one `TerminalSidebar`, with no edge,
/// width or collapse of their own. Splitting them out is the whole point of
/// this file growing from three ids to five; everything below already worked
/// against the *list*, not against three hardcoded names.
export type SidebarId = "workspaces" | "explorer" | "terminals" | "git" | "agents";

export type DockSide = "left" | "right";

export const SIDEBAR_IDS: SidebarId[] = [
  "workspaces",
  "explorer",
  "terminals",
  "git",
  "agents",
];

export function isSidebarId(value: unknown): value is SidebarId {
  return typeof value === "string" && (SIDEBAR_IDS as string[]).includes(value);
}

/// Ids a build before this one could have persisted, mapped to the id that
/// replaces them. `files` is the only one — `terminals` and `agents` did not
/// exist as independent sidebars, so there is nothing for them to alias.
const LEGACY_SIDEBAR_ID_ALIASES: Record<string, SidebarId> = {
  files: "explorer",
};

/// Resolve a raw persisted value to a `SidebarId` this build knows, following
/// the legacy alias when the raw value is one. Returns `null` for anything
/// else — an id from a newer build, or garbage — so every caller repairs
/// rather than rejects, per this file's header.
export function normalizeSidebarId(value: unknown): SidebarId | null {
  if (typeof value !== "string") return null;
  if (isSidebarId(value)) return value;
  return LEGACY_SIDEBAR_ID_ALIASES[value] ?? null;
}

/// Today's layout, and what a first run gets: the rail, the explorer, the
/// terminals list and the agent dashboard on the left (in that order — see
/// `DEFAULT_DOCK_ORDER`), the git panel on the right.
export const DEFAULT_DOCK_SIDE: Record<SidebarId, DockSide> = {
  workspaces: "left",
  explorer: "left",
  terminals: "left",
  git: "right",
  agents: "left",
};

/// What `sidebarsSwapped: true` produced, expressed in the new model.
///
/// It is not a mirror of the default. The old flag swapped the *two* sidebar
/// slots either side of the workbench and never touched the rail, which stayed
/// pinned to the far left — so a swapped layout was rail, git, workbench,
/// explorer. `terminals` and `agents` follow the explorer to the right: under
/// the pre-dock model they were sections stacked *inside* that same column, so
/// a legacy blob's swap carries them along with the panel they used to live in.
export const SWAPPED_DOCK_SIDE: Record<SidebarId, DockSide> = {
  workspaces: "left",
  explorer: "right",
  terminals: "right",
  git: "left",
  agents: "right",
};

export const DEFAULT_DOCK_ORDER: SidebarId[] = [
  "workspaces",
  "explorer",
  "terminals",
  "agents",
  "git",
];

/// Repair a persisted `dockSide` map.
///
/// `legacySwapped` is the pre-dock `sidebarsSwapped` boolean off the same blob.
/// It is consulted **only** when there is no `dockSide` at all, which is what
/// makes this idempotent: a blob already in the new shape is passed through
/// untouched even if a stale `sidebarsSwapped` is still sitting beside it.
///
/// Unknown sidebar ids and values that are not an edge are dropped rather than
/// thrown on — a blob from a newer build that docks a sixth panel must still
/// place the five this build has. A key of `files` is not unknown: it is the
/// pre-rename explorer, normalized to `explorer` before anything else is
/// checked, so a blob written by `main` hydrates with the explorer at the edge
/// it had.
export function parseDockSide(
  raw: unknown,
  legacySwapped?: unknown,
): Record<SidebarId, DockSide> {
  const base = legacySwapped === true ? SWAPPED_DOCK_SIDE : DEFAULT_DOCK_SIDE;
  const out: Record<SidebarId, DockSide> = { ...base };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = normalizeSidebarId(key);
    if (!id) continue;
    if (value !== "left" && value !== "right") continue;
    out[id] = value;
  }
  return out;
}

/// Repair a persisted order: drop unknown ids, drop duplicates, append anything
/// missing in its shipped position. Modelled on `parseGitSectionOrder` — and
/// like it, never throws the user's arrangement away over one bad entry. Each
/// entry is normalized first, so a legacy `files` lands at the *position*
/// `explorer` had rather than being dropped and re-appended at the end.
export function parseDockOrder(raw: unknown): SidebarId[] {
  const seen = new Set<SidebarId>();
  const out: SidebarId[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id = normalizeSidebarId(entry);
      if (!id || seen.has(id)) continue;
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
  for (const entry of raw) {
    const id = normalizeSidebarId(entry);
    if (id) seen.add(id);
  }
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

/// Which persisted flag takes each sidebar down to its icon rail.
///
/// The five collapses were never one flag — the explorer, the terminals list
/// and the agent board have a `sidebarSections` disclosure each, the git panel
/// and the workspace rail have booleans of their own. `SidebarDock`'s drag
/// preview carried the mapping as a private `switch`, and "come back collapsed"
/// needs the same answer, so it moves here: a sixth sidebar is then a compile
/// error in one file rather than a preview that silently draws at full width.
///
/// `TitleBar` deliberately does **not** use this. Its edge buttons ask a
/// different question — "is this panel on screen at all", which for the
/// explorer is `leftSidebarCollapsed` (what Mod+B means), not the icon rail.
///
/// `section` entries are *disclosures*: `true` means open, so railed is the
/// negation. `flag` entries are collapses: `true` means railed. That asymmetry
/// is in the persisted data already; naming it here is cheaper than migrating
/// two user-visible preferences to agree.
export type SidebarCollapse =
  | { kind: "section"; key: "files" | "terminals" | "agents" }
  | { kind: "flag"; key: "gitSidebarCollapsed" | "workspaceRailCollapsed" };

export const SIDEBAR_COLLAPSE: Record<SidebarId, SidebarCollapse> = {
  workspaces: { kind: "flag", key: "workspaceRailCollapsed" },
  explorer: { kind: "section", key: "files" },
  terminals: { kind: "section", key: "terminals" },
  git: { kind: "flag", key: "gitSidebarCollapsed" },
  agents: { kind: "section", key: "agents" },
};

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
