import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";
import { createInFlight, dedupeConcurrent } from "./inflight";

/// Signals need an owner, and every test here wants a fresh gate.
function withInFlight<T>(fn: (gate: ReturnType<typeof createInFlight>) => T): T {
  return createRoot((dispose) => {
    const out = fn(createInFlight());
    dispose();
    return out;
  });
}

describe("createInFlight", () => {
  it("skips a second call while the first is still running", async () => {
    const { busy, run, released } = withInFlight((gate) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;

      const first = gate.run(async () => {
        calls += 1;
        await held;
        return "first";
      });

      return {
        busy: gate.busy,
        run: gate.run,
        released: async () => {
          // A second invocation lands while the first is in flight.
          const second = await gate.run(async () => {
            calls += 1;
            return "second";
          });
          expect(second).toBeUndefined();
          expect(calls).toBe(1);
          expect(gate.busy()).toBe(true);
          release();
          expect(await first).toBe("first");
          return calls;
        },
      };
    });

    expect(await released()).toBe(1);
    // The gate reopens once the first call settles.
    expect(busy()).toBe(false);
    expect(await run(async () => "later")).toBe("later");
  });

  it("reopens the gate when the action throws", async () => {
    const gate = createRoot((dispose) => {
      const g = createInFlight();
      dispose();
      return g;
    });

    await expect(
      gate.run(() => Promise.reject(new Error("index.lock"))),
    ).rejects.toThrow("index.lock");
    expect(gate.busy()).toBe(false);
    expect(await gate.run(async () => "ok")).toBe("ok");
  });
});

describe("dedupeConcurrent", () => {
  it("shares one execution between concurrent callers", async () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const refetch = dedupeConcurrent(async () => {
      calls += 1;
      await held;
      return calls;
    });

    const a = refetch();
    const b = refetch();
    release();
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(calls).toBe(1);

    // A later call is a new round-trip, not a cached answer.
    expect(await refetch()).toBe(2);
  });
});
