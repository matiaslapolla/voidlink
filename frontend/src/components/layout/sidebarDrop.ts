/// The arithmetic behind dragging a sidebar to an edge.
///
/// Kept DOM-free and separate from the overlay that draws it, for the reason
/// `paneDrop.ts` gives about pane drops: every interesting part of the gesture
/// is a decision about *rectangles* — which fifth of the workbench the pointer
/// is in, what rectangle the panel would occupy when released — and none of it
/// needs a browser to be wrong in a way a user would notice.
import type { DockSide, SidebarId } from "@/store/layout";
import type { Rect } from "./paneDrop";

/// How much of each side of the workbench is a dock zone.
///
/// The same 20% `paneDrop.EDGE_ZONE` uses, and the same reasoning: the shell
/// has one edge-proximity idiom rather than two that feel different under the
/// hand. The middle 60% is not a target — releasing there does nothing, which
/// is what makes "put it back" possible without a modifier key.
export const DOCK_EDGE_ZONE = 0.2;

/// Which edge a pointer inside the workbench is asking for, or `null` for the
/// middle band. `point` is relative to the workbench's top-left.
///
/// Left and right only, and it stays that way now that `DockSide` has a third
/// member: `bottom` is the dock strip's edge, not a sidebar's, because a
/// sidebar is a full-height column the shell places in one horizontal flex row
/// (`SIDEBAR_DOCK_SIDES` in `store/layout/dock.ts` states the narrowing). The
/// strip's own hit-test is `dockStripEdgeAt`, beside that narrowing.
///
/// A degenerate box (zero width, which is what a hidden view measures at) has
/// no edges to be near, so it refuses rather than picking one.
export function dockEdgeAt(
  size: { width: number; height: number },
  point: { x: number; y: number },
): DockSide | null {
  if (size.width <= 0 || size.height <= 0) return null;
  const fx = point.x / size.width;
  if (fx < DOCK_EDGE_ZONE) return "left";
  if (fx > 1 - DOCK_EDGE_ZONE) return "right";
  return null;
}

/// The rectangle the panel would occupy after the drop, in the workbench's own
/// coordinates.
///
/// It is the *real* landing geometry, not a hint, for the reason `previewRect`
/// gives: the whole point of an edge affordance is that the user sees the
/// resulting layout before releasing. Clamped to half the workbench so a panel
/// whose persisted width is wider than the window still previews as something
/// the window can hold.
///
/// `side` is a sidebar's edge, so it is left or right by construction (see
/// `dockEdgeAt`); a `bottom` that reached here would preview at the right edge,
/// which is the same total-function stance `slotOrder` takes and for the same
/// reason.
export function dockPreviewRect(
  size: { width: number; height: number },
  side: DockSide,
  widthPx: number,
): Rect {
  const width = Math.max(0, Math.min(widthPx, size.width / 2));
  return {
    x: side === "left" ? 0 : size.width - width,
    y: 0,
    width,
    height: size.height,
  };
}

/// The sentence the drag ghost shows, or `null` when releasing here does
/// nothing — the same contract `describeDropIntent` has, and for the same
/// reason: a ghost that only names what you picked up tells you what you
/// already know (§7.6).
///
/// `unchanged` is the case that would otherwise promise a move that will not
/// happen: dropping a panel back on the edge it already occupies, in the
/// position it already had.
export function describeDockDrop(
  side: DockSide | null,
  label: string,
  unchanged: boolean,
): string | null {
  if (!side) return null;
  if (unchanged) return null;
  return `Dock ${label} ${side}`;
}

/// Where a drop lands among the panels already on that edge: the id it would
/// render *in front of*, or `null` for the end of the stack.
///
/// `rects` are the slots currently on the target edge, in screen order, with
/// the dragged panel already excluded — a panel cannot land before itself, and
/// leaving it in would make every drop on its own edge a no-op.
export function dockInsertionBefore(
  ids: readonly SidebarId[],
  index: number,
): SidebarId | null {
  return ids[index] ?? null;
}
