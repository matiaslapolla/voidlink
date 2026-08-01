/// The interruption budget.
///
/// `foldToast` and `enforceCeiling` are pure, so the two rules that actually
/// matter — what counts as the same news, and what gets sacrificed when the
/// stack is full — are testable without a DOM or a clock. The stateful wrapper
/// gets a handful of tests on top for the parts that only exist there: TTL
/// refresh on coalesce, and timer cleanup on eviction.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VISIBLE,
  dismissToast,
  dismissToastSource,
  enforceCeiling,
  foldToast,
  pushToast,
  resetToasts,
  useToasts,
  type Toast,
  type ToastKind,
} from "@/commands/toast";

let nextId = 1;

function toast(partial: Partial<Toast> = {}): Toast {
  return {
    id: nextId++,
    message: "something happened",
    kind: "info",
    ttlMs: 3500,
    count: 1,
    ...partial,
  };
}

beforeEach(() => {
  nextId = 1;
  resetToasts();
});

describe("foldToast", () => {
  it("appends a toast with no source", () => {
    const first = toast({ message: "one" });
    const second = toast({ message: "two" });
    const { list, id } = foldToast([first], second);
    expect(list).toHaveLength(2);
    expect(id).toBe(second.id);
  });

  /// The default has to be "these are different things". Coalescing is a claim
  /// only the call site can make.
  it("does not coalesce two sourceless toasts with identical text", () => {
    const { list } = foldToast([toast({ message: "same" })], toast({ message: "same" }));
    expect(list).toHaveLength(2);
  });

  it("collapses a repeat from the same source into a count", () => {
    const first = toast({ source: "run:7", kind: "error", message: "leg 1 failed" });
    const { list, id } = foldToast(
      [first],
      toast({ source: "run:7", kind: "error", message: "leg 2 failed" }),
    );
    expect(list).toHaveLength(1);
    expect(id).toBe(first.id);
    expect(list[0].count).toBe(2);
  });

  /// The latest failure is the one whose detail is still relevant, and a Retry
  /// captured three failures ago may close over state that has moved on.
  it("keeps the newest message and action when it coalesces", () => {
    const stale = { label: "Retry", run: vi.fn() };
    const fresh = { label: "Retry", run: vi.fn() };
    const { list } = foldToast(
      [toast({ source: "run:7", kind: "error", message: "old", action: stale })],
      toast({ source: "run:7", kind: "error", message: "new", action: fresh }),
    );
    expect(list[0].message).toBe("new");
    expect(list[0].action).toBe(fresh);
  });

  /// A run that warns and then fails is telling you two different things, and
  /// merging them would let the more severe news inherit the milder icon.
  it("does not merge across kinds from one source", () => {
    const { list } = foldToast(
      [toast({ source: "run:7", kind: "warning", message: "slow" })],
      toast({ source: "run:7", kind: "error", message: "dead" }),
    );
    expect(list).toHaveLength(2);
  });

  it("keeps two different sources apart", () => {
    const { list } = foldToast(
      [toast({ source: "run:7", kind: "error" })],
      toast({ source: "run:8", kind: "error" }),
    );
    expect(list).toHaveLength(2);
  });
});

describe("enforceCeiling", () => {
  const fill = (kinds: ToastKind[]) => kinds.map((kind) => toast({ kind }));

  it("leaves a list at the ceiling alone", () => {
    const list = fill(Array<ToastKind>(MAX_VISIBLE).fill("info"));
    expect(enforceCeiling(list)).toHaveLength(MAX_VISIBLE);
  });

  it("evicts the least severe first", () => {
    // One over the ceiling, with a single info among errors.
    const list = fill(["error", "info", "error", "error", "error"]);
    const kept = enforceCeiling(list);
    expect(kept).toHaveLength(MAX_VISIBLE);
    expect(kept.some((t) => t.kind === "info")).toBe(false);
  });

  /// The load-bearing one: a burst of successes must never be able to push a
  /// failure off the stack, which is the exact scenario a fan-out produces —
  /// four legs succeed, one fails, and the failure is the only one that matters.
  it("never evicts a failure in favour of a success", () => {
    const list = fill(["error", "success", "success", "success", "success", "success"]);
    const kept = enforceCeiling(list);
    expect(kept.some((t) => t.kind === "error")).toBe(true);
  });

  it("breaks severity ties on age", () => {
    const list = fill(["info", "info", "info", "info", "info"]);
    const kept = enforceCeiling(list);
    expect(kept.map((t) => t.id)).toEqual([2, 3, 4, 5]);
  });

  /// A notice that appears and is instantly evicted is indistinguishable from
  /// one that was never raised, and the call site cannot find out.
  it("keeps the newest even when it is the least severe thing on screen", () => {
    const list = [...fill(["error", "error", "error", "error"]), toast({ kind: "info" })];
    const kept = enforceCeiling(list);
    expect(kept.at(-1)?.kind).toBe("info");
    expect(kept).toHaveLength(MAX_VISIBLE);
  });
});

describe("pushToast", () => {
  const { toasts } = useToasts();

  afterEach(() => vi.useRealTimers());

  it("returns the id of the toast carrying the message", () => {
    const first = pushToast("one", "error", 3500, undefined, "run:1");
    const second = pushToast("two", "error", 3500, undefined, "run:1");
    expect(second).toBe(first);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].count).toBe(2);
  });

  /// Five failures over four seconds should leave the count on screen for the
  /// full window after the *last* one, not vanish mid-burst on the first
  /// push's deadline.
  it("refreshes the dismissal window when it coalesces", () => {
    vi.useFakeTimers();
    pushToast("one", "error", 1000, undefined, "run:1");
    vi.advanceTimersByTime(900);
    pushToast("two", "error", 1000, undefined, "run:1");

    vi.advanceTimersByTime(200); // past the first deadline, short of the second
    expect(toasts()).toHaveLength(1);

    vi.advanceTimersByTime(900);
    expect(toasts()).toHaveLength(0);
  });

  it("dismisses every toast from one source", () => {
    pushToast("a", "error", 3500, undefined, "run:1");
    pushToast("b", "warning", 3500, undefined, "run:1");
    pushToast("c", "error", 3500, undefined, "run:2");
    dismissToastSource("run:1");
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].source).toBe("run:2");
  });

  /// An evicted toast's timer would otherwise fire against an id no longer in
  /// the list — harmless in effect, but it leaks a handle per eviction for the
  /// life of the process.
  it("does not leave a timer behind for an evicted toast", () => {
    vi.useFakeTimers();
    for (let i = 0; i < MAX_VISIBLE + 2; i++) pushToast(`n${i}`, "info", 1000);
    expect(toasts()).toHaveLength(MAX_VISIBLE);
    vi.advanceTimersByTime(2000);
    expect(toasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dismisses by id", () => {
    const id = pushToast("gone");
    dismissToast(id);
    expect(toasts()).toHaveLength(0);
  });
});
