/// The editor view's split layout, as data.
///
/// Two groups maximum, side by side or stacked. That cap is not a placeholder
/// for an N-way grid: the case that motivates splitting at all is "this file
/// beside that one", and every editor that grew a general grid grew a
/// window-management UI to go with it. If a third group is ever wanted, it is a
/// new design question, not a bigger array.
///
/// Pure and Solid-free on purpose. `EditorSurface` holds one of these in a
/// signal, `editorController` keys its live editors by `GroupId`, and neither
/// has to agree with the other about anything except the ids — which is what
/// makes the transitions here testable without a DOM or a Monaco.

/// Stable keys for the two groups. `primary` is the one a single-group layout
/// uses, so the unsplit case has exactly the identity it always had.
export type GroupId = "primary" | "secondary";

/// How the two groups sit relative to each other. `horizontal` puts them side
/// by side (a vertical seam), matching the "split right" wording users know.
export type SplitOrientation = "horizontal" | "vertical";

export interface SplitLayout {
  /// One or two ids, in visual order (left→right, or top→bottom).
  groups: GroupId[];
  orientation: SplitOrientation;
  /// Which group takes new files, the cursor, and the save command.
  focused: GroupId;
}

/// The layout every editor view starts in, and the one the whole feature has to
/// be indistinguishable from when nobody has split anything.
export const SINGLE_GROUP: SplitLayout = {
  groups: ["primary"],
  orientation: "horizontal",
  focused: "primary",
};

const OTHER: Record<GroupId, GroupId> = { primary: "secondary", secondary: "primary" };

export function isSplit(layout: SplitLayout): boolean {
  return layout.groups.length > 1;
}

/// Add the second group, or — when already split — just change the seam's
/// direction. "Split right" while already split right is a no-op rather than an
/// error, because the command it backs is one a user will hold down.
///
/// The new group takes focus: the point of splitting is to work in the new one.
export function splitEditor(layout: SplitLayout, orientation: SplitOrientation): SplitLayout {
  if (isSplit(layout)) {
    if (layout.orientation === orientation) return layout;
    return { ...layout, orientation };
  }
  const existing = layout.groups[0];
  const added = OTHER[existing];
  return { groups: [existing, added], orientation, focused: added };
}

/// Drop a group. Never goes below one — closing the last group would leave the
/// view with nowhere to render, and "close" on a single group should do nothing
/// rather than blank the editor.
///
/// Focus moves to the survivor, which is the only sensible target.
export function closeGroup(layout: SplitLayout, id: GroupId): SplitLayout {
  if (!isSplit(layout) || !layout.groups.includes(id)) return layout;
  const rest = layout.groups.filter((g) => g !== id);
  return { groups: rest, orientation: layout.orientation, focused: rest[0] };
}

/// Close whichever group is *not* focused, keeping the user where they are.
export function unsplit(layout: SplitLayout): SplitLayout {
  if (!isSplit(layout)) return layout;
  return closeGroup(layout, OTHER[layout.focused]);
}

export function focusGroup(layout: SplitLayout, id: GroupId): SplitLayout {
  if (!layout.groups.includes(id) || layout.focused === id) return layout;
  return { ...layout, focused: id };
}

/// Move focus to the next group in visual order, wrapping. A no-op when there
/// is only one group, so the command is safe to bind unconditionally.
export function cycleFocus(layout: SplitLayout): SplitLayout {
  if (!isSplit(layout)) return layout;
  const i = layout.groups.indexOf(layout.focused);
  return { ...layout, focused: layout.groups[(i + 1) % layout.groups.length] };
}

/// Flex basis for the first group, as a fraction of the container.
///
/// Clamped so a drag can never collapse either side to nothing: a group with
/// zero width is a group the user cannot get back to without knowing the reset
/// gesture, which is exactly the trap MASTER §7.6's double-click-to-reset rule
/// exists to avoid needing.
export const MIN_SPLIT_FRACTION = 0.15;
export const DEFAULT_SPLIT_FRACTION = 0.5;

export function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT_FRACTION;
  return Math.min(1 - MIN_SPLIT_FRACTION, Math.max(MIN_SPLIT_FRACTION, fraction));
}
