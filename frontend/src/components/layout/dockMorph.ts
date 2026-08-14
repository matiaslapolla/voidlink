/// The dock's opening gesture: a panel grows out of the button that opened it.
///
/// A panel appearing instantly beside the strip is correct but mute — it does
/// not say *which* of the five buttons produced it, which is the one question a
/// strip of five identical targets creates. The morph answers it with the only
/// property that can: the origin the panel scales from. §7.3.7 already specifies
/// this shape for the context menu ("`scale(0.97)` + opacity **from trigger
/// origin**"); the dock is the same statement at panel scale, so it uses the
/// same idiom rather than a second one.
///
/// **Why the geometry is here and the animation is a DOM call.** The origin
/// maths is pure and worth testing (a clamped point in a box); the playback is
/// one `Element.animate` and testing it would be testing the browser. The split
/// is `boardModel.ts`/`BoardSurface.tsx`'s, applied to motion.
///
/// **Why WAAPI and not a CSS class.** The slot the panel lives in is never
/// unmounted — that is the no-remount invariant `AppShell.test.tsx` guards — so
/// a CSS `animation` on it would run once and never re-trigger without the
/// class-removal-and-reflow dance. `Element.animate` restarts every call, and a
/// second open while the first is still playing replaces it rather than queueing
/// behind it, which is what makes drumming on the dock buttons feel attached to
/// the pointer instead of laggy.

/// A point in viewport coordinates.
export interface MorphPoint {
  x: number;
  y: number;
}

/// The box the panel occupies, in viewport coordinates. Structurally a `DOMRect`
/// minus everything the maths does not read, so tests can hand over a literal.
export interface MorphBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/// Which way the panel is going. Not a boolean, because the two directions do
/// not share a duration *or* a curve and a `reverse` flag would imply they do:
/// §7.1's out is 75% of its in (`--dur-short-out`), and leaving accelerates
/// away (`--ease-in`) where arriving decelerates into place (`--ease-out`).
export type MorphDirection = "in" | "out";

/// Read as authored values rather than retyped: §7.1's budget is a token, and a
/// number here that drifted from it would be a second opinion about how fast the
/// app moves.
///
/// The fallbacks are the authored values from `index.css`, for the same reason
/// `islandGapPx()` carries one — unit tests have no cascade to compute.
const FALLBACK: Record<MorphDirection, { duration: number; easing: string }> = {
  in: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  out: { duration: 135, easing: "cubic-bezier(0.7, 0, 0.84, 0)" },
};

const TOKENS: Record<MorphDirection, { duration: string; easing: string }> = {
  in: { duration: "--dur-short", easing: "--ease-out" },
  out: { duration: "--dur-short-out", easing: "--ease-in" },
};

function token(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw || fallback;
}

export function morphDurationMs(direction: MorphDirection): number {
  const fallback = FALLBACK[direction].duration;
  const n = Number.parseFloat(token(TOKENS[direction].duration, `${fallback}ms`));
  return Number.isFinite(n) ? n : fallback;
}

export function morphEasing(direction: MorphDirection): string {
  return token(TOKENS[direction].easing, FALLBACK[direction].easing);
}

/// The panel's `transform-origin`, in px relative to its own top-left.
///
/// Clamped into the panel's box, and the clamp is the whole reason this is a
/// function rather than a subtraction at the call site. The button is *outside*
/// the panel by construction — the strip sits in the lane the panel stops short
/// of (`AppShell`'s `room()`) — and an origin outside the box makes a scale
/// swing the panel through an arc instead of growing it. Clamping to the nearest
/// edge keeps the growth anchored to the side the button is actually on, which
/// is the part the eye reads.
export function morphOrigin(panel: MorphBox, from: MorphPoint): MorphPoint {
  const x = Math.min(Math.max(from.x - panel.left, 0), Math.max(panel.width, 0));
  const y = Math.min(Math.max(from.y - panel.top, 0), Math.max(panel.height, 0));
  return { x, y };
}

/// The centre of the element that was clicked, in viewport coordinates.
export function centreOf(el: Element): MorphPoint {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/// Whether this open earns motion.
///
/// Two ways it does not, and they are different rules that happen to agree here:
///
///   • **Keyboard.** §7.1 is absolute — a user who asked for a panel by chord or
///     by Enter on a focused button gets it at `--dur-instant`. A `click` from
///     the keyboard reports `detail === 0`, which is how the caller tells them
///     apart without a second code path per input device.
///   • **`prefers-reduced-motion`.** `index.css` already flattens every
///     *transition*, but a WAAPI animation is not a transition and that block
///     cannot reach it. Asked here instead, so the panel still appears — it
///     simply appears finished, which is the reduced-motion contract rather than
///     the "freeze on the most informative frame" one (there is no information
///     in a half-grown panel).
export function shouldMorph(input: { pointer: boolean; reducedMotion: boolean }): boolean {
  return input.pointer && !input.reducedMotion;
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/// The two ends of the gesture, as one keyframe pair read in either order.
///
/// Written once because the panel has to leave along the path it arrived on —
/// §7.3.11's "same path both ways". Two hand-written keyframe lists is how those
/// silently diverge into an entrance that grows from the button and an exit that
/// shrinks toward somewhere else.
///
/// `scale(0.92)`, never from zero (MOTION-PLAN F6: "never from `scale(0)`"). The
/// panel is already the right shape at the first frame; it is arriving, not
/// being constructed.
const SEATED = { opacity: 1, transform: "scale(1)" };
const AT_BUTTON = { opacity: 0, transform: "scale(0.92)" };

/// Grow `el` out of `from`, or collapse it back into `from`.
///
/// No-op when the element has no box (a panel that rendered nothing) or when the
/// platform has no WAAPI — in both cases the caller's `finished` promise never
/// arrives, which is why the caller must treat `null` as "already done" rather
/// than waiting on it.
///
/// `fill` differs by direction and the asymmetry is load-bearing. An entrance
/// ends on the element's own resting style, so holding the last frame would be
/// pinning it to a value it already has. An exit ends *invisible*, on an element
/// that has not unmounted yet — without `forwards` it flashes back to full
/// opacity for the frame between the animation finishing and the caller
/// dropping it.
export function runDockMorph(
  el: HTMLElement,
  from: MorphPoint,
  direction: MorphDirection = "in",
): Animation | null {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  if (typeof el.animate !== "function") return null;

  const origin = morphOrigin(rect, from);
  el.style.transformOrigin = `${origin.x}px ${origin.y}px`;

  return el.animate(direction === "in" ? [AT_BUTTON, SEATED] : [SEATED, AT_BUTTON], {
    duration: morphDurationMs(direction),
    easing: morphEasing(direction),
    fill: direction === "in" ? "none" : "forwards",
  });
}
