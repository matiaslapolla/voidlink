/// Hill charts: where a piece of work is, in the only dimension that matters.
///
/// Basecamp's idea, and the reason it is worth importing is that every other
/// progress indicator in this app is a *binary*: running or not, dirty or not,
/// ahead or behind. None of them can express the difference between "I have
/// been at this for two days and still do not know how it works" and "I know
/// exactly what to do and there are four hours of typing left." Those two
/// states look identical on a percentage bar and are opposite in every way that
/// affects a decision.
///
/// The curve is the whole model:
///
///   - **Uphill** (0 → 0.5) — *figuring it out*. Unknowns outnumber knowns.
///     Estimates here are worthless and everyone knows it.
///   - **The crest** (0.5) — nothing is left to discover. Everything remaining
///     is execution.
///   - **Downhill** (0.5 → 1) — *making it happen*. Estimates start to mean
///     something.
///
/// ## Why the dot is moved by hand
///
/// It is the one number in this app that cannot be derived. Commits, diffs and
/// turn counts measure activity, and activity is exactly what a hill chart
/// refuses to measure — a day spent reading code and moving nothing is often
/// the day that gets you over the crest. Inferring the position from the log
/// would rebuild the percentage bar the hill exists to replace.
///
/// Every move is still *recorded* to the log (`hill.position.moved`), so the
/// history is durable and a check-in can say "moved over the crest on Search".
/// Judgement is the input; the record is automatic.

/// A named piece of work with a position on the curve.
export interface HillScope {
  id: string;
  /// The workspace this belongs to. Scopes are per-project, not per-checkout:
  /// a scope routinely spans the main checkout and a worktree, and splitting it
  /// by checkout would produce two dots for one piece of work.
  workspaceId: string;
  name: string;
  /// 0 → 1, left to right along the curve.
  position: number;
  /// Unix millis of the last move, so a stalled scope can be shown as stalled.
  updatedAt: number;
  /// Finished scopes stay listed until they are removed — a scope that vanishes
  /// on completion takes the record of having finished with it.
  done: boolean;
}

export type Phase = "uphill" | "crest" | "downhill" | "done";

export const PHASE_LABELS: Record<Phase, string> = {
  uphill: "Figuring it out",
  crest: "Over the crest",
  downhill: "Making it happen",
  done: "Done",
};

/// How wide the crest is, in position units either side of 0.5.
///
/// A crest with no width would mean a scope is only ever "over the crest" at
/// exactly 0.5, which no hand-dragged dot lands on. This makes the most
/// important transition in the model actually observable.
const CREST = 0.04;

export function clampPosition(position: number): number {
  // `NaN` is the only value `Math.min`/`Math.max` cannot rescue — it propagates
  // through both and reaches the renderer as an SVG path of `NaN NaN`, which
  // draws nothing and reports nothing. Infinities clamp on their own.
  if (Number.isNaN(position)) return 0;
  return Math.min(1, Math.max(0, position));
}

export function phaseOf(scope: Pick<HillScope, "position" | "done">): Phase {
  if (scope.done) return "done";
  const p = clampPosition(scope.position);
  if (p < 0.5 - CREST) return "uphill";
  if (p <= 0.5 + CREST) return "crest";
  return "downhill";
}

/// Height of the curve at `position`, from 0 at either end to 1 at the crest.
///
/// A raised cosine rather than a Gaussian or a parabola: it is exactly 0 at
/// both ends and exactly 1 at the middle, with zero gradient at all three, so
/// the drawn hill meets the baseline flat instead of at a visible corner.
export function hillHeight(position: number): number {
  const p = clampPosition(position);
  return (1 - Math.cos(2 * Math.PI * p)) / 2;
}

export interface Point {
  x: number;
  y: number;
}

/// Where a dot sits, in SVG coordinates (y grows downward).
export function pointAt(position: number, width: number, height: number): Point {
  return {
    x: clampPosition(position) * width,
    y: height - hillHeight(position) * height,
  };
}

/// The hill itself as an SVG path.
///
/// Sampled rather than approximated with two cubic béziers: the dot is placed
/// with `pointAt`, and a path that only approximated the same function would
/// let the dot drift off its own curve — most visibly near the crest, which is
/// the one place a reader is looking closely.
export function hillPath(width: number, height: number, samples = 48): string {
  const steps = Math.max(2, Math.round(samples));
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const { x, y } = pointAt(i / steps, width, height);
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join(" ");
}

/// The summary written to the log when a scope moves.
///
/// Names the *transition* when there is one, because crossing the crest is the
/// event worth reading in a check-in six weeks later; otherwise it states the
/// direction. Never a percentage — "68%" is the false precision the hill
/// replaces.
export function describeMove(name: string, from: number, to: number): string {
  const before = phaseOf({ position: from, done: false });
  const after = phaseOf({ position: to, done: false });
  if (before !== after && after === "downhill") {
    return `${name} is over the hill — now making it happen`;
  }
  if (before !== after && after === "uphill") {
    return `${name} went back uphill — still figuring it out`;
  }
  if (before !== after && after === "crest") {
    return `${name} reached the crest`;
  }
  if (to > from) return `${name} moved forward, ${PHASE_LABELS[after].toLowerCase()}`;
  if (to < from) return `${name} moved back, ${PHASE_LABELS[after].toLowerCase()}`;
  return `${name} is unchanged`;
}

/// How long a scope has sat still, in days. `null` when it moved today.
///
/// A scope nobody has moved in a week is the signal a hill chart exists to
/// produce — it is how "we are stuck" becomes visible without anyone having to
/// say it out loud in a meeting.
export function stalledDays(scope: HillScope, now: number): number | null {
  const days = Math.floor((now - scope.updatedAt) / 86_400_000);
  return days >= 1 ? days : null;
}

/// Uphill first, then furthest along, then by name.
///
/// Deliberately *not* "most complete first". The scopes that need attention are
/// the ones still being figured out, and a list sorted by progress buries them
/// under work that is already safe.
export function compareScopes(a: HillScope, b: HillScope): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  const phaseRank = (s: HillScope) => (phaseOf(s) === "uphill" ? 0 : 1);
  const rank = phaseRank(a) - phaseRank(b);
  if (rank !== 0) return rank;
  if (a.position !== b.position) return b.position - a.position;
  return a.name.localeCompare(b.name);
}
