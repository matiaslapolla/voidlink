import { describe, expect, it } from "vitest";
import { highestSignal, terminalSignal } from "./StatusLed";

describe("highestSignal", () => {
  it("returns nothing for an empty signal set", () => {
    expect(highestSignal([])).toBeUndefined();
    expect(highestSignal([undefined, null])).toBeUndefined();
  });

  /// MASTER.md §7.5.3 rule 2. The ordering exists because a tab with a dirty
  /// buffer *and* a failed process must report the failure — the case a naive
  /// "last signal wins" implementation gets backwards.
  it("applies failed > running > bell > finished > dirty", () => {
    expect(highestSignal(["dirty", "failed"])).toBe("failed");
    expect(highestSignal(["dirty", "running"])).toBe("running");
    expect(highestSignal(["finished", "bell"])).toBe("bell");
    expect(highestSignal(["dirty", "finished"])).toBe("finished");
    expect(highestSignal(["running", "failed", "bell", "dirty"])).toBe("failed");
  });

  it("is order-independent", () => {
    expect(highestSignal(["failed", "dirty"])).toBe(highestSignal(["dirty", "failed"]));
  });
});

describe("terminalSignal", () => {
  it("maps the terminal's two-bit state onto the vocabulary", () => {
    expect(terminalSignal(true, true)).toBe("running");
    expect(terminalSignal(true, false)).toBe("running");
    expect(terminalSignal(false, true)).toBe("finished");
    expect(terminalSignal(false, false)).toBe("stale");
  });
});
