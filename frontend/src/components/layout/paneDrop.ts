/// The arithmetic behind pane drops and splitter drags.
///
/// Kept DOM-free and separate from `MainSurface`/`TabStrip` for one reason: the
/// interesting parts of a drop are all decisions about *rectangles* — which
/// twentieth of the pane the pointer is in, what the resulting split would look
/// like, what a splitter drag does to a ratio list — and none of them need a
/// browser to be wrong in a way a user would notice.
import type { SplitOrientation } from "@/store/layout";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/// How much of each edge is a split zone. 20% per the workbench prompt's
/// `<design>`; the centre 60% × 60% is "drop into this group".
///
/// It stays a fraction rather than becoming a pixel floor. The narrowest pane
/// the splitter will let you make is `MIN_PANE_PX`, and 20% of that is 24px,
/// which is a comfortable target. A pixel floor would only start eating the
/// centre zone, and "drop into this group" is the common gesture.
export const EDGE_ZONE = 0.2;

/// The narrowest a pane may be dragged to, in px along the split axis.
///
/// **This is the only thing bounding how many panes a worktree can have.** The
/// reducer has no group cap: it is recursive, and a hard number there would be
/// arbitrary the moment a window changed size. What is not arbitrary is that a
/// pane under ~120px has no room for a tab label, let alone content — so the
/// window's own width is the ceiling, and it moves when the user resizes the
/// window instead of being frozen into a constant.
///
/// It is a *drag* floor, not a *layout* floor. Nothing stops n panes from
/// sharing a window too narrow to give each 120px; when that happens the
/// splitter degrades to half the pair it sits between (see `MainSurface`)
/// rather than refusing to move, because a control that will not respond to a
/// drag reads as broken.
export const MIN_PANE_PX = 120;

/// What a pointer at a given position inside a group body means.
///
/// `preview` is the *exact* geometry the new group would occupy, not a hint —
/// the whole point of the edge affordance is that the user sees the resulting
/// layout before releasing. It is expressed in the body's own coordinates so
/// the overlay can render it with no further arithmetic.
///
/// There used to be a third case, `refused`, carrying the sentence the drag
/// ghost showed at the group cap. The cap is gone, so nothing can refuse a
/// split any more and the variant went with it — a union member no producer
/// emits is a branch every consumer still has to write.
export type DropIntent =
  | { kind: "body" }
  | {
      kind: "edge";
      orientation: SplitOrientation;
      placement: "before" | "after";
      preview: Rect;
    };

/// `splitGroup` always creates a two-child split with even ratios, so the new
/// group takes exactly half of the group being split. That constant is what
/// makes the preview honest.
const NEW_GROUP_SHARE = 0.5;

/// Classify a point inside a group body.
///
/// `point` is relative to the body's top-left. A degenerate box (zero width or
/// height, which is what a hidden pane measures at) is treated as body-only:
/// there is no meaningful edge in a rectangle with no interior.
export function dropIntentAt(
  size: { width: number; height: number },
  point: { x: number; y: number },
): DropIntent {
  if (size.width <= 0 || size.height <= 0) return { kind: "body" };

  const fx = point.x / size.width;
  const fy = point.y / size.height;

  // Distance into the pane from each edge, normalised. The smallest one wins,
  // so the corners resolve to whichever edge the pointer is genuinely nearer
  // rather than to a fixed axis preference.
  const candidates = [
    { d: fx, orientation: "row" as const, placement: "before" as const },
    { d: 1 - fx, orientation: "row" as const, placement: "after" as const },
    { d: fy, orientation: "column" as const, placement: "before" as const },
    { d: 1 - fy, orientation: "column" as const, placement: "after" as const },
  ];
  const nearest = candidates.reduce((a, b) => (b.d < a.d ? b : a));
  if (nearest.d >= EDGE_ZONE) return { kind: "body" };

  return {
    kind: "edge",
    orientation: nearest.orientation,
    placement: nearest.placement,
    preview: previewRect(size, nearest.orientation, nearest.placement),
  };
}

/// The rectangle the new group would occupy inside `size`.
export function previewRect(
  size: { width: number; height: number },
  orientation: SplitOrientation,
  placement: "before" | "after",
): Rect {
  if (orientation === "row") {
    const width = size.width * NEW_GROUP_SHARE;
    return {
      x: placement === "before" ? 0 : size.width - width,
      y: 0,
      width,
      height: size.height,
    };
  }
  const height = size.height * NEW_GROUP_SHARE;
  return {
    x: 0,
    y: placement === "before" ? 0 : size.height - height,
    width: size.width,
    height,
  };
}

/// Which tab a group shows.
///
/// The worktree-wide active item wins whenever it lives in this group, which is
/// what keeps the default single-group layout identical to today: one group
/// owns every tab, so the group's front tab *is* `activeItem`. A group that
/// does not hold the active item falls back to the tab it last showed.
///
/// `activeItemElsewhere` is the third case and the reason this is a function
/// rather than two `??`s: a group that has never been clicked has no remembered
/// tab, and once the active item moves to a *different* group that group would
/// otherwise render blank while its tab strip shows a row of tabs. It falls
/// back to its first tab — but only then. With no active item anywhere, showing
/// nothing is what the un-split workbench has always done, and changing that
/// would be a behaviour change smuggled in under a layout feature.
export function resolveActiveTabId(
  tabIds: readonly string[],
  groupActiveTabId: string | null,
  activeItemId: string | null,
  activeItemElsewhere = false,
): string | null {
  if (activeItemId && tabIds.includes(activeItemId)) return activeItemId;
  if (groupActiveTabId && tabIds.includes(groupActiveTabId)) return groupActiveTabId;
  return activeItemElsewhere ? (tabIds[0] ?? null) : null;
}

/// A splitter drag between children `index` and `index + 1`.
///
/// Only the two children either side of the handle move; everything else in the
/// split keeps its share, so dragging one handle in a three-way split does not
/// silently reflow the third pane. The result is a *proposal* —
/// `normalizeRatios` in the store clamps and renormalises it.
export function ratiosAfterDrag(
  ratios: readonly number[],
  index: number,
  sizePx: number,
  totalPx: number,
): number[] {
  const out = [...ratios];
  if (totalPx <= 0 || index < 0 || index + 1 >= out.length) return out;
  const pair = (out[index] ?? 0) + (out[index + 1] ?? 0);
  const next = Math.max(0, Math.min(pair, sizePx / totalPx));
  out[index] = next;
  out[index + 1] = pair - next;
  return out;
}
