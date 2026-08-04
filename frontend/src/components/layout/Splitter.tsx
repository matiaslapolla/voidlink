/// The one resize handle in the app.
///
/// `WorkspaceRail`, `TerminalSidebar` and `GitSidebar` each grew their own
/// `startResize` — three copies of the same `mousemove`/`mouseup` pair, none of
/// them focusable, none of them announcing anything, all of them clamping by
/// hand. This is that control, once, with the properties MASTER.md §7.6 asks a
/// splitter for:
///
///   • **Hit area ≥ 8px, visual width 1px.** The handle is an 8px transparent
///     strip; the rule inside it is `w-px`. The visual size never changes on
///     hover, so nothing reflows (§7.6 no-layout-shift).
///   • **1:1 pointer tracking** via `setPointerCapture`, respecting the grab
///     offset. The pane follows every frame and the drag is reversible
///     mid-motion (§7.3.10). No fixed-duration animation for something the
///     user is holding.
///   • **Clamping that does not hard-stop the pointer.** We derive the value
///     from the pointer's *total* delta rather than accumulating per-frame, so
///     dragging past the bound and coming back tracks the pointer exactly and
///     releasing outside the range settles at the clamp without a jump.
///   • **Keyboard resize.** `role="separator"` + `aria-valuenow/min/max`,
///     arrows step 8px, `Shift`+arrow steps 32px, `Home`/`End` go to the
///     bounds. Instant — a keyboard-initiated geometry change never animates
///     (§7.1).
///   • **Double-click resets** to the pane's default width, and the `title`
///     says so; an affordance nobody knows about is not an affordance.
///   • **Disabled** (a collapsed pane) is three channels — `opacity-40`,
///     `cursor-not-allowed`, `aria-disabled` — plus a `title` giving the
///     reason (§7.6).
///
/// The only transition here is the rule's `background-color` on hover, which
/// `index.css` pins to 60ms — pointer-initiated, so §7.1 allows it.
import { createSignal, onCleanup, type JSX } from "solid-js";

/// Arrow-key step, and the `Shift` multiplier. Both in px, both deliberately
/// coarse enough that a keyboard resize converges in a few presses.
const STEP = 8;
const BIG_STEP = 32;

/// The island gap in px, read from the `--island-gap` token.
///
/// Under Direction D1 a splitter no longer sits on a seam — it sits in the
/// canvas gap between two islands, and the ratio arithmetic that positions
/// panes has to subtract that gap. There is exactly one constant and it lives
/// with the token; this is the only place JavaScript asks the cascade for it.
/// Cached because it is read on every splitter drag frame and the token is not
/// theme-dependent (no theme redefines it — see `index.css`).
let cachedGap: number | null = null;
export function islandGapPx(): number {
  if (cachedGap !== null) return cachedGap;
  // `node` has no cascade to compute; unit tests that reach here want the
  // authored value, which the token also carries.
  if (typeof document === "undefined") return 6;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--island-gap")
    .trim();
  const n = Number.parseFloat(raw);
  cachedGap = Number.isFinite(n) ? n : 6;
  return cachedGap;
}

export interface SplitterProps {
  /// Which axis the *pane* is resized along. `"x"` is a vertical rule that
  /// changes width; `"y"` is a horizontal rule that changes height.
  axis?: "x" | "y";
  /// Which edge of the pane the handle sits on. Decides both where it is
  /// positioned and the sign of the pointer delta: dragging right grows a pane
  /// whose handle is on its `end` edge and shrinks one whose handle is on its
  /// `start` edge.
  side: "start" | "end";
  /// Current size of the pane, in px.
  value: number;
  min: number;
  max: number;
  /// Where double-click puts it back to.
  defaultValue: number;
  /// Called on every frame of a drag and on every keyboard step, already
  /// clamped to `[min, max]`.
  onResize: (value: number) => void;
  /// Accessible name — "Workspace rail width", not "separator".
  label: string;
  /// A splitter whose pane is collapsed has nothing to resize. Pass the reason
  /// so the `title` can state it (§7.6 forbids a silent disabled control).
  disabledReason?: string;
  /// Fires `true` when a pointer drag starts and `false` when it ends.
  ///
  /// For hosts that animate their own width. A collapse animates because it
  /// carries information — where the panel went — but the same transition on a
  /// pane the user is *holding* would make it trail the pointer, which §7.3.10
  /// forbids. The host suppresses its transition for the duration rather than
  /// guessing from the value, because a width change tells you nothing about
  /// which gesture produced it.
  onDragStateChange?: (dragging: boolean) => void;
  /// The handle sits in the canvas gap *between* two islands rather than
  /// inside one of them (Direction D1). Shifts the 8px strip outward by half
  /// the gap so it straddles the seam the user actually sees, and centres the
  /// visible rule inside the strip instead of pinning it to a pane edge that
  /// no longer exists. The hit area is unchanged at 8px — only where it sits
  /// moves — so §7.6's floor still holds.
  ///
  /// Only hosts that are *not* inside a clipping island may pass this: a
  /// splitter that pokes outside an `overflow: hidden` island would be cut in
  /// half. The pane-group splitters in `MainSurface` qualify (they are
  /// siblings of the island, not children); the three sidebar splitters do
  /// not, and keep the handle inside their own edge.
  inGap?: boolean;
  /// Extra z-index / positioning classes for the rare host that needs them.
  class?: string;
}

export function Splitter(props: SplitterProps) {
  const [dragging, setDragging] = createSignal(false);
  const axis = () => props.axis ?? "x";
  const disabled = () => !!props.disabledReason;
  const clamp = (v: number) => Math.max(props.min, Math.min(props.max, v));
  /// `end`-edge handles grow the pane as the pointer moves in the positive
  /// direction; `start`-edge handles (the git sidebar, which is on the right of
  /// the window) grow it as the pointer moves back.
  const sign = () => (props.side === "end" ? 1 : -1);

  /// One place the drag flag is written, so the host can never be told the drag
  /// started and not that it ended.
  function setDrag(value: boolean) {
    setDragging(value);
    props.onDragStateChange?.(value);
  }

  function onPointerDown(e: PointerEvent) {
    if (disabled() || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    // The grab offset is respected implicitly: every frame is measured against
    // where the pointer went down, not against the handle's centre.
    const origin = axis() === "x" ? e.clientX : e.clientY;
    const startValue = props.value;
    setDrag(true);
    // Hold the resize cursor for the whole drag, not just while the pointer
    // happens to be over the 8px strip.
    const priorCursor = document.body.style.cursor;
    document.body.style.cursor = axis() === "x" ? "col-resize" : "row-resize";
    // Stop the pointer from selecting text in the panes it sweeps across.
    const priorSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const onMove = (mv: PointerEvent) => {
      const now = axis() === "x" ? mv.clientX : mv.clientY;
      props.onResize(clamp(startValue + sign() * (now - origin)));
    };
    const onUp = () => {
      setDrag(false);
      document.body.style.cursor = priorCursor;
      document.body.style.userSelect = priorSelect;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    onCleanup(onUp);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled()) return;
    const step = e.shiftKey ? BIG_STEP : STEP;
    const grow = axis() === "x" ? "ArrowRight" : "ArrowDown";
    const shrink = axis() === "x" ? "ArrowLeft" : "ArrowUp";
    let next: number | null = null;
    if (e.key === grow) next = props.value + sign() * step;
    else if (e.key === shrink) next = props.value - sign() * step;
    else if (e.key === "Home") next = props.min;
    else if (e.key === "End") next = props.max;
    else if (e.key === "Enter") next = props.defaultValue;
    if (next === null) return;
    e.preventDefault();
    props.onResize(clamp(next));
  }

  /// The strip's extent along the *cross* axis. Which end of the resize axis
  /// it hugs is `offset()`'s job below, not a class's, because it is the one
  /// value that has to become a `calc()` when the handle moves into a gap.
  const edge = () => (axis() === "x" ? "top-0 h-full w-2" : "left-0 w-full h-2");

  /// Where the 8px strip sits along the resize axis.
  ///
  /// Flush (`inGap` unset) it hugs the pane's own edge, as it did when panes
  /// shared a 1px seam. In a gap it is pushed outward by half the gap so its
  /// centre lands on the middle of the canvas channel: the strip spans
  /// `[-gap/2 - 4px, -gap/2 + 4px]` from the pane edge, which is an offset of
  /// `gap/2 - 4px` — negative for a 6px gap, i.e. outward.
  const offset = (): JSX.CSSProperties => {
    const v = props.inGap ? "calc(var(--island-gap) / 2 - 4px)" : "0px";
    if (axis() === "x") return props.side === "end" ? { right: v } : { left: v };
    return props.side === "end" ? { bottom: v } : { top: v };
  };

  /// The 1px rule. Flush, it is pinned to the outer edge of the strip so it
  /// lines up with the pane border it replaced. In a gap there is no border to
  /// line up with, so it is centred in the strip — and therefore in the gap.
  const rule = () =>
    axis() === "x"
      ? props.inGap
        ? "top-0 h-full w-px left-1/2 -translate-x-1/2"
        : `top-0 h-full w-px ${props.side === "end" ? "right-0" : "left-0"}`
      : props.inGap
        ? "left-0 w-full h-px top-1/2 -translate-y-1/2"
        : `left-0 w-full h-px ${props.side === "end" ? "bottom-0" : "top-0"}`;

  return (
    <div
      role="separator"
      tabIndex={disabled() ? -1 : 0}
      aria-orientation={axis() === "x" ? "vertical" : "horizontal"}
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-disabled={disabled() ? "true" : undefined}
      title={
        props.disabledReason ??
        `${props.label} — drag or use arrow keys (Shift for larger steps); double-click to reset`
      }
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDblClick={() => {
        if (!disabled()) props.onResize(clamp(props.defaultValue));
      }}
      style={offset()}
      class={[
        "group/splitter absolute z-20 select-none focus-visible:outline-none",
        edge(),
        disabled()
          ? "opacity-40 cursor-not-allowed"
          : axis() === "x"
            ? "cursor-col-resize"
            : "cursor-row-resize",
        props.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* The visible rule. Width is constant across every state — hover,
          focus and drag change colour only. */}
      <div
        class={[
          "absolute transition-colors",
          rule(),
          dragging()
            ? "bg-primary"
            : "bg-border group-hover/splitter:bg-primary group-focus-visible/splitter:bg-primary",
        ].join(" ")}
      />
      {/* Focus ring lives on a 2px inset overlay rather than the strip itself,
          so it reads at 8px without widening anything. */}
      <div
        class={[
          "absolute inset-0 ring-inset ring-ring opacity-0",
          "group-focus-visible/splitter:opacity-100 group-focus-visible/splitter:ring-2",
        ].join(" ")}
      />
    </div>
  );
}
