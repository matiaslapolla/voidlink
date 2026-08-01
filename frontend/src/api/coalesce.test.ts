/// `coalesceInFlight` — one round trip for concurrent identical asks.
///
/// The property under test is narrow and the danger is in its edges: this must
/// never behave like a cache. A helper that held its answer even one tick too
/// long would hand a caller a worktree list from before the commit that woke
/// it, which is indistinguishable from the staleness bug it exists to help fix.

import { describe, expect, it, vi } from "vitest";
import { coalesceInFlight } from "./git";

/// A call whose settlement the test controls.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("coalesceInFlight", () => {
  it("runs once for callers that overlap", async () => {
    const d = deferred<string>();
    const run = vi.fn(() => d.promise);

    const a = coalesceInFlight("k", run);
    const b = coalesceInFlight("k", run);
    expect(run).toHaveBeenCalledTimes(1);

    d.resolve("value");
    expect(await a).toBe("value");
    expect(await b).toBe("value");
  });

  it("runs again once the first has settled — it is not a cache", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const a = coalesceInFlight("k", run);
    first.resolve("old");
    expect(await a).toBe("old");

    const b = coalesceInFlight("k", run);
    expect(run).toHaveBeenCalledTimes(2);
    second.resolve("fresh");
    expect(await b).toBe("fresh");
  });

  it("keys separately, so two repositories do not share an answer", async () => {
    const one = deferred<string>();
    const two = deferred<string>();
    const runOne = vi.fn(() => one.promise);
    const runTwo = vi.fn(() => two.promise);

    const a = coalesceInFlight("repo-a", runOne);
    const b = coalesceInFlight("repo-b", runTwo);
    one.resolve("a");
    two.resolve("b");

    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  it("shares the rejection, and does not poison the next call", async () => {
    const failing = deferred<string>();
    const ok = deferred<string>();
    const run = vi
      .fn()
      .mockImplementationOnce(() => failing.promise)
      .mockImplementationOnce(() => ok.promise);

    const a = coalesceInFlight("k", run);
    const b = coalesceInFlight("k", run);
    failing.reject(new Error("boom"));

    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");

    // A failure must not leave the key occupied — the retry has to reach Rust.
    const c = coalesceInFlight("k", run);
    ok.resolve("recovered");
    expect(await c).toBe("recovered");
    expect(run).toHaveBeenCalledTimes(2);
  });
});
