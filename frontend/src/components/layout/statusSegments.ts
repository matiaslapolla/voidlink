/// The status bar's segment model, and the two pure decisions it makes.
///
/// `StatusBar.tsx` used to be a hardcoded row of `<Show>`s. That worked while
/// four things wanted a chip and stopped working the moment escalation arrived
/// (§7.5.3): the status bar is the *last stop* for a signal from a pane the
/// user cannot see, so the one thing it must never do is push that signal off
/// the end of a narrow window. A hardcoded row has no way to know which of its
/// children matters most.
///
/// So features contribute `StatusSegment`s with a resting priority, and two
/// pure functions decide what happens:
///
///   • `orderSegments` — priority order, with any segment carrying a live
///     signal pulled to the front *for as long as the signal is live* and
///     dropped back to its resting place the moment it clears.
///   • `planOverflow` — what fits, collapsing lowest-priority-first into a `⋯`
///     popover. Never truncates text to unreadability, never wraps to a second
///     line; a segment either renders whole or moves into the popover.
///
/// Both are pure and take measured widths as data, so the ordering and the
/// overflow rule are testable without a layout engine.
import type { JSX } from "solid-js";
import type { ActivitySignal } from "@/components/layout/StatusLed";

/// Which end of the bar a segment sits at. Purely a rendering hint: the bar is
/// one row with a spacer in the middle, and `align` decides which side of the
/// spacer a segment lands on. Overflow is decided across the *whole* bar in one
/// priority order — collapsing per side would let a low-priority chip on the
/// right survive while a high-priority one on the left was pushed out.
export type StatusAlign = "start" | "end";

export interface StatusSegment {
  id: string;
  /// Resting priority. Higher survives longer when the bar overflows.
  /// Deliberately a plain number, not an enum: a feature that wants to sit
  /// between two existing chips should be able to say so without a design
  /// review.
  priority: number;
  align: StatusAlign;
  /// Plain text naming the segment. Used in the `⋯` popover, and as the
  /// screen-reader name when the rendered chip is icon-only (§10.10).
  label: string;
  /// The chip itself.
  render: () => JSX.Element;
  /// A live §7.5.3 signal. While set, this segment outranks every resting
  /// segment on its side — the escalation target must never be the thing that
  /// overflows.
  signal?: ActivitySignal;
  /// What clicking it does. Absent for a purely informational chip.
  onClick?: () => void;
  title?: string;
}

/// Resting priorities for the segments the workbench ships with. Named rather
/// than inline so the relative order is one readable list instead of nine
/// numbers scattered through a component.
///
/// The rule behind the numbers: the further from the user's current focus the
/// fact is, the more important it is that the bar keeps showing it. Background
/// activity outranks everything because it is the only channel that reports a
/// pane you cannot see; the focus-mode chip is next because it is the only
/// visible way out of zen; repo identity comes after that; ambient counters
/// last.
export const STATUS_PRIORITY = {
  backgroundActivity: 100,
  focusMode: 90,
  branch: 80,
  aiDraft: 70,
  aheadBehind: 60,
  dirty: 50,
  stack: 40,
  blame: 30,
  workspaces: 10,
} as const;

/// Priority order, with live signals pulled to the front.
///
/// Ties break on `id` rather than on input order so the bar cannot reshuffle
/// itself when an unrelated segment re-renders — muscle memory for "the branch
/// is on the left" is worth more than any ordering subtlety.
export function orderSegments<T extends Pick<StatusSegment, "id" | "priority" | "signal">>(
  segments: readonly T[],
): T[] {
  return [...segments].sort((a, b) => {
    const live = Number(!!b.signal) - Number(!!a.signal);
    if (live !== 0) return live;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface OverflowPlan {
  /// Ids that render in the bar, in order.
  visible: string[];
  /// Ids that moved into the `⋯` popover, highest priority first.
  collapsed: string[];
}

/// Decide what fits.
///
/// `order` is the output of `orderSegments`, already carrying each segment's
/// measured width. `available` is the space the row has for segments;
/// `overflowWidth` is what the `⋯` button itself costs, and is only charged
/// when something actually collapses — a bar that fits exactly must not lose a
/// segment to make room for a button it does not need.
export function planOverflow(
  order: readonly { id: string; width: number }[],
  available: number,
  overflowWidth: number,
): OverflowPlan {
  const total = order.reduce((sum, s) => sum + s.width, 0);
  if (total <= available) return { visible: order.map((s) => s.id), collapsed: [] };

  const budget = available - overflowWidth;
  const visible: string[] = [];
  const collapsed: string[] = [];
  let used = 0;
  for (const [i, seg] of order.entries()) {
    // The top-priority segment is kept unconditionally, even when it alone
    // exceeds the budget. On a window narrow enough for that to happen the
    // choice is between a bar that overflows by a few pixels and a bar that
    // shows nothing but a `⋯` — and the segment at the front of this order is,
    // by construction, the one carrying a live §7.5.3 signal. The escalation
    // target must never be the thing that overflows; that is the whole reason
    // the order exists.
    //
    // Otherwise: once one segment has been pushed out, everything below it
    // goes too. Skipping a wide chip to fit a narrow lower-priority one would
    // put the bar in priority order everywhere except the one place it
    // matters.
    if (i === 0 || (collapsed.length === 0 && used + seg.width <= budget)) {
      visible.push(seg.id);
      used += seg.width;
    } else {
      collapsed.push(seg.id);
    }
  }
  return { visible, collapsed };
}
