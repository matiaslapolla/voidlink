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
export const EDGE_ZONE = 0.2;

/// What a pointer at a given position inside a group body means.
///
/// `preview` is the *exact* geometry the new group would occupy, not a hint —
/// the whole point of the edge affordance is that the user sees the resulting
/// layout before releasing. It is expressed in the body's own coordinates so
/// the overlay can render it with no further arithmetic.
export type DropIntent =
  | { kind: "body" }
  | {
      kind: "edge";
      orientation: SplitOrientation;
      placement: "before" | "after";
      preview: Rect;
    }
  /// The four-group cap. Carries the sentence the drag ghost shows — §7.6
  /// forbids a control that refuses without saying why, and a toast would
  /// arrive after the gesture it is about.
  | { kind: "refused"; reason: string };

export const SPLIT_CAP_REASON = "4 panes is the maximum — close one to split again";

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
  opts: { canSplit: boolean },
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

  if (!opts.canSplit) return { kind: "refused", reason: SPLIT_CAP_REASON };

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
