import { describe, expect, it } from "vitest";
import { orderSegments, planOverflow } from "./statusSegments";

const seg = (id: string, priority: number, signal?: "failed" | "running") => ({
  id,
  priority,
  signal,
});

describe("orderSegments", () => {
  it("orders by resting priority, highest first", () => {
    const out = orderSegments([seg("low", 10), seg("high", 90), seg("mid", 50)]);
    expect(out.map((s) => s.id)).toEqual(["high", "mid", "low"]);
  });

  /// The rule that makes escalation safe: the segment carrying a live signal
  /// is at the front of the priority order, so it is the last thing that could
  /// ever be collapsed.
  it("pulls a segment carrying a live signal to the front", () => {
    const out = orderSegments([seg("high", 90), seg("noisy", 10, "failed")]);
    expect(out.map((s) => s.id)).toEqual(["noisy", "high"]);
  });

  it("returns it to its resting priority once the signal clears", () => {
    const live = orderSegments([seg("high", 90), seg("noisy", 10, "running")]);
    const rested = orderSegments([seg("high", 90), seg("noisy", 10)]);
    expect(live.map((s) => s.id)).toEqual(["noisy", "high"]);
    expect(rested.map((s) => s.id)).toEqual(["high", "noisy"]);
  });

  it("orders several live signals among themselves by priority", () => {
    const out = orderSegments([
      seg("a", 10, "running"),
      seg("b", 80, "failed"),
      seg("c", 95),
    ]);
    expect(out.map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  /// Ties break on id, not on input order, so an unrelated re-render cannot
  /// reshuffle the bar under the user's eyes.
  it("is stable across input order", () => {
    const a = orderSegments([seg("x", 50), seg("y", 50)]);
    const b = orderSegments([seg("y", 50), seg("x", 50)]);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it("does not mutate its input", () => {
    const input = [seg("low", 10), seg("high", 90)];
    orderSegments(input);
    expect(input.map((s) => s.id)).toEqual(["low", "high"]);
  });
});

describe("planOverflow", () => {
  const w = (id: string, width: number) => ({ id, width });

  it("keeps everything when it fits, and charges nothing for the ⋯ button", () => {
    const plan = planOverflow([w("a", 40), w("b", 40)], 80, 28);
    expect(plan.visible).toEqual(["a", "b"]);
    expect(plan.collapsed).toEqual([]);
  });

  it("collapses lowest-priority-first", () => {
    // Input is already in priority order; the tail is what goes.
    const plan = planOverflow([w("high", 40), w("mid", 40), w("low", 40)], 100, 28);
    expect(plan.visible).toEqual(["high"]);
    expect(plan.collapsed).toEqual(["mid", "low"]);
  });

  it("charges the ⋯ button once something collapses", () => {
    // 100px of segments in 90px: without the button's 28px there would be room
    // for two, with it there is room for one.
    const plan = planOverflow([w("a", 50), w("b", 50)], 90, 28);
    expect(plan.visible).toEqual(["a"]);
    expect(plan.collapsed).toEqual(["b"]);
  });

  /// Once one segment is out, everything below it goes too. Skipping a wide
  /// chip to squeeze in a narrower lower-priority one would put the bar in
  /// priority order everywhere except the one place it matters.
  it("does not skip past a segment that did not fit", () => {
    const plan = planOverflow([w("top", 10), w("wide", 200), w("narrow", 5)], 100, 28);
    expect(plan.visible).toEqual(["top"]);
    expect(plan.collapsed).toEqual(["wide", "narrow"]);
  });

  /// On a window too narrow for even the first chip, the bar overflows by a
  /// few pixels rather than showing nothing but a `⋯`.
  it("keeps the top-priority segment even when it alone exceeds the budget", () => {
    const plan = planOverflow([w("wide", 200), w("narrow", 5)], 100, 28);
    expect(plan.visible).toEqual(["wide"]);
    expect(plan.collapsed).toEqual(["narrow"]);
  });

  /// The whole point: the escalation target sorts first, so it is in `visible`
  /// even when the bar has room for exactly one segment.
  it("never collapses the segment a live signal put at the front", () => {
    const ordered = orderSegments([
      { id: "workspaces", priority: 10 },
      { id: "branch", priority: 80 },
      { id: "background-activity", priority: 100, signal: "failed" as const },
    ]);
    const plan = planOverflow(
      ordered.map((s) => w(s.id, 60)),
      70,
      28,
    );
    expect(plan.visible).toEqual(["background-activity"]);
    expect(plan.collapsed).toEqual(["branch", "workspaces"]);
  });

  it("handles an empty bar", () => {
    expect(planOverflow([], 100, 28)).toEqual({ visible: [], collapsed: [] });
  });

  /// Before the first measurement every width is 0, which must read as "it all
  /// fits" rather than "collapse everything" — otherwise the bar would flash
  /// empty on mount.
  it("treats unmeasured segments as fitting", () => {
    const plan = planOverflow([w("a", 0), w("b", 0)], 0, 28);
    expect(plan.collapsed).toEqual([]);
  });
});
