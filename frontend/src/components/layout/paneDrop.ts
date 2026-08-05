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

/// The rectangle the pane being dropped on would *shrink to*.
///
/// The complement of `previewRect`, and it exists because a preview that only
/// draws the new pane shows half of what is about to happen. A user reading one
/// filled rectangle at an edge has to infer that the pane underneath gives up
/// exactly that much room; drawing both halves means there is nothing left to
/// infer. Same `NEW_GROUP_SHARE`, so the two rectangles tile the body exactly
/// and no seam or overlap can appear between them.
export function residualRect(
  size: { width: number; height: number },
  orientation: SplitOrientation,
  placement: "before" | "after",
): Rect {
  const preview = previewRect(size, orientation, placement);
  if (orientation === "row") {
    return {
      x: placement === "before" ? preview.width : 0,
      y: 0,
      width: size.width - preview.width,
      height: size.height,
    };
  }
  return {
    x: 0,
    y: placement === "before" ? preview.height : 0,
    width: size.width,
    height: size.height - preview.height,
  };
}

/// Half the thickness of the line drawn where the new splitter would sit, in px.
///
/// The line is centred on the boundary rather than laid inside either half, so
/// it reads as the seam *between* two panes instead of as a border belonging to
/// one of them — which is what a splitter is.
const SPLIT_LINE_HALF = 1;

/// The seam between the two halves: where the splitter this drop creates would
/// actually be draggable.
///
/// Drawn as its own rect rather than as a border on the preview because a
/// border belongs to a box and this line belongs to neither — it is the thing
/// the user will grab afterwards, and showing it during the drag is what makes
/// "this becomes two resizable panes" legible before release rather than after.
export function splitLineRect(
  size: { width: number; height: number },
  orientation: SplitOrientation,
  placement: "before" | "after",
): Rect {
  const preview = previewRect(size, orientation, placement);
  if (orientation === "row") {
    const x = placement === "before" ? preview.width : preview.x;
    return { x: x - SPLIT_LINE_HALF, y: 0, width: SPLIT_LINE_HALF * 2, height: size.height };
  }
  const y = placement === "before" ? preview.height : preview.y;
  return { x: 0, y: y - SPLIT_LINE_HALF, width: size.width, height: SPLIT_LINE_HALF * 2 };
}

/// Where the new pane lands, in the words a user would use.
///
/// `before`/`after` × `row`/`column` is the reducer's vocabulary and it is
/// exactly wrong on a drag ghost: nobody drags a tab to the "before edge of a
/// row split". Kept here rather than in the component so the four cases are
/// covered by a unit test instead of by looking at four screenshots.
export function edgeDirection(
  orientation: SplitOrientation,
  placement: "before" | "after",
): "left" | "right" | "up" | "down" {
  if (orientation === "row") return placement === "before" ? "left" : "right";
  return placement === "before" ? "up" : "down";
}

/// The sentence the drag ghost shows for what is under the pointer right now.
///
/// A ghost that only carries the dragged tab's name tells the user what they
/// picked up, which they already know. What they cannot know without releasing
/// is what the drop will *do* — and §7.6's rule that a control must say what it
/// does applies to a gesture at least as much as to a button.
///
/// `paneCount` is the count *before* the drop, so a split says what the layout
/// becomes rather than what it is. `null` means the pointer is over no pane at
/// all, and the caller shows the tab's name alone: an empty sentence would read
/// as a missing string rather than as "nothing will happen here".
export function describeDropIntent(
  intent: DropIntent | null,
  paneCount: number,
): string | null {
  if (!intent) return null;
  if (intent.kind === "body") return "Move into this pane";
  const next = paneCount + 1;
  return `Split ${edgeDirection(intent.orientation, intent.placement)} — ${next} panes`;
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
