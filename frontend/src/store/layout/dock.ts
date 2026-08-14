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

/// Every edge of the workbench a docked thing can be pinned to.
///
/// `bottom` arrived with the dock strip (`environmentMode: "docked"`) and is
/// deliberately a member of *this* union rather than of a second one beside it.
/// There is one vocabulary for "which edge", and the moment there were two the
/// drag code, the preview arithmetic and the persisted values would each have
/// to say which enum they meant.
///
/// It is not, however, an edge a **sidebar** may occupy. A sidebar is a
/// full-height column and the shell arranges the five of them in one horizontal
/// flex row (see `slotOrder`); the bottom edge is a different axis and putting
/// a column there is a rework of the shell, not a value. So the narrowing is
/// stated once, in `SIDEBAR_DOCK_SIDES`, and the two places a raw value becomes
/// a sidebar's edge — `parseDockSide` and the drag hit-test `dockEdgeAt` — both
/// check against it. Everything else in this file is total over `DockSide`.
///
/// There is no `top`. The title bar, the tab strips and the workspace switcher
/// all live along the top of the window; a dock there would be the fourth
/// horizontal band in 80px of chrome.
export type DockSide = "left" | "right" | "bottom";

/// Every edge, in the order a picker should offer them.
export const DOCK_SIDES: DockSide[] = ["left", "right", "bottom"];

/// The edges a *sidebar* may be docked to — see `DockSide`'s header for why
/// this is a narrowing of one union rather than a union of its own.
export const SIDEBAR_DOCK_SIDES: DockSide[] = ["left", "right"];

export function isDockSide(value: unknown): value is DockSide {
  return typeof value === "string" && (DOCK_SIDES as string[]).includes(value);
}

export function isSidebarDockSide(value: unknown): value is DockSide {
  return typeof value === "string" && (SIDEBAR_DOCK_SIDES as string[]).includes(value);
}

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
    // `SIDEBAR_DOCK_SIDES`, not `DOCK_SIDES`: `bottom` is a real edge, but not
    // one a sidebar column can occupy (see `DockSide`). A blob that names it
    // for a sidebar — hand-edited, or written by a build that grew a bottom
    // sidebar rail — is repaired to that sidebar's default rather than
    // rendering a column the shell's flex row cannot place.
    if (!isSidebarDockSide(value)) continue;
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
/// The main surface is 0; left-edge panels are negative, right-edge panels
/// positive, and a `bottom` slot is banded past every right-edge one.
///
/// `bottom` is the dock strip's edge and never a sidebar's (`DockSide`), so no
/// slot the shell composes today can reach that band. It is defined anyway
/// because this function has to be *total*: a `Record<SidebarId, DockSide>`
/// that somehow held `bottom` — a hand-edited blob, a future build's — would
/// otherwise fall through the ternary onto the right-hand branch and render a
/// panel at an edge nothing asked for. Banded rather than folded into the right
/// edge so that when it does happen it is visible as "outermost, on its own"
/// rather than silently interleaved with real right-edge panels.
export const SLOT_ORDER_BAND = 100;

export function slotOrder(side: DockSide, index: number): number {
  if (side === "bottom") return index + 2 * SLOT_ORDER_BAND;
  return side === "left" ? index - SLOT_ORDER_BAND : index + SLOT_ORDER_BAND;
}

// ── The dock strip's placement ──────────────────────────────────────────────
//
// `environmentMode: "docked"` collapses the five sidebars into one floating
// strip pinned to an edge (`components/layout/DockStrip.tsx`). Which edge is a
// single global preference, persisted in `gitPrefs` beside `dockSide` — the
// arithmetic that resolves it lives here, with the rest of the pure placement
// logic and away from the DOM, for the reason `sidebarDrop.ts`'s header gives:
// a drag that resolves to the wrong edge is a bug a screenshot cannot see.

/// The strip's thickness across its own axis, in px.
///
/// Beside `SIDEBAR_RAIL_WIDTH` in spirit and for the same reason it is a
/// constant rather than a `PANEL_BOUNDS` entry: the strip is content-sized
/// along its length and fixed across it, so there is no min, no max and nothing
/// to drag. 40px is `SIDEBAR_RAIL_WIDTH` (32) plus the strip's own padding, so
/// the buttons inside it land at exactly the size the icon rails it replaces
/// had — a mode switch changes the arrangement, not the target size.
export const DOCK_STRIP_THICKNESS = 40;

/// Where a first run in docked mode puts the strip.
///
/// Left, because that is the edge four of the five sidebars already default to
/// (`DEFAULT_DOCK_SIDE`) — the strip appears where the panels it replaces were.
export const DEFAULT_DOCK_STRIP_SIDE: DockSide = "left";

/// Repair a persisted dock-strip edge. Anything that is not an edge this build
/// can place — a `top` from a build that grew one, garbage, `undefined` on the
/// first run in docked mode — comes back as the default rather than throwing,
/// which is this file's rule for every persisted value (`parseDockOrder`).
export function parseDockStripSide(raw: unknown): DockSide {
  return isDockSide(raw) ? raw : DEFAULT_DOCK_STRIP_SIDE;
}

/// Which axis the strip runs along at a given edge. The buttons stack down a
/// left/right strip and across a bottom one, and so does everything that
/// measures it — the extent below, the drag's insertion arithmetic.
export function dockStripAxis(side: DockSide): "vertical" | "horizontal" {
  return side === "bottom" ? "horizontal" : "vertical";
}

/// How much room the shell reserves along `side` for the strip: the strip's own
/// thickness plus one island gap, so the floating strip clears the islands
/// rather than overlapping them.
///
/// A number rather than a CSS string because it is arithmetic the tests can
/// check; `AppShell` turns it into padding. `thickness` and `gap` are handed in
/// so that this module keeps knowing nothing about `--island-gap` — geometry
/// tokens are `AppShell`'s to read (see its header), and a second reader of
/// them is the thing that file's "geometry lives here" rule exists to prevent.
export function dockStripReservation(
  side: DockSide,
  thickness: number,
  gap: number,
): { left: number; right: number; bottom: number } {
  const room = Math.max(0, thickness) + Math.max(0, gap);
  return {
    left: side === "left" ? room : 0,
    right: side === "right" ? room : 0,
    bottom: side === "bottom" ? room : 0,
  };
}

/// Which edge a pointer inside the workbench is asking the *strip* to move to,
/// or `null` for the middle — where a release does nothing, so "put it back" is
/// possible without a modifier key.
///
/// Deliberately not `dockEdgeAt` with a third branch. That function answers the
/// same question for a **sidebar**, which has only two legal edges, and its
/// own test asserts as much ("there is no top or bottom edge"); teaching it
/// `bottom` would make every sidebar dropped near the floor land somewhere the
/// shell cannot render it. Two questions, two functions, one `DockSide`.
///
/// The nearest qualifying edge wins, measured as a *fraction* of the axis it is
/// on rather than in pixels: the bands then stay proportionate in a window the
/// user has resized, which is the same reason `DOCK_EDGE_ZONE` is a fraction.
/// Ties resolve in `DOCK_SIDES` order, which only matters in the two corners.
///
/// A degenerate box has no edges to be near and refuses rather than picking
/// one, exactly as `dockEdgeAt` does.
export const DOCK_STRIP_EDGE_ZONE = 0.2;

export function dockStripEdgeAt(
  size: { width: number; height: number },
  point: { x: number; y: number },
): DockSide | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const distance: Record<DockSide, number> = {
    left: point.x / size.width,
    right: 1 - point.x / size.width,
    bottom: 1 - point.y / size.height,
  };
  let best: DockSide | null = null;
  for (const side of DOCK_SIDES) {
    if (distance[side] >= DOCK_STRIP_EDGE_ZONE) continue;
    if (best === null || distance[side] < distance[best]) best = side;
  }
  return best;
}

/// The rectangle the strip would occupy after the drop, in the workbench's own
/// coordinates — the real landing geometry, not a hint, for the reason
/// `dockPreviewRect` gives about sidebars.
///
/// `length` is how long the strip is along its own axis (it is content-sized,
/// so the caller measures it); it is clamped to the box, which is what keeps a
/// dock holding twenty terminals from previewing past the window.
export function dockStripPreviewRect(
  size: { width: number; height: number },
  side: DockSide,
  thickness: number,
  length: number,
): { x: number; y: number; width: number; height: number } {
  const t = Math.max(0, thickness);
  if (side === "bottom") {
    const w = Math.max(0, Math.min(length, size.width));
    return { x: (size.width - w) / 2, y: size.height - t, width: w, height: t };
  }
  const h = Math.max(0, Math.min(length, size.height));
  return {
    x: side === "left" ? 0 : size.width - t,
    y: (size.height - h) / 2,
    width: t,
    height: h,
  };
}
