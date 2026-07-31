import { describe, expect, it } from "vitest";
import {
  clampPosition,
  compareScopes,
  describeMove,
  hillHeight,
  hillPath,
  phaseOf,
  pointAt,
  stalledDays,
  type HillScope,
} from "./hillModel";

function scope(partial: Partial<HillScope> = {}): HillScope {
  return {
    id: "s1",
    workspaceId: "ws",
    name: "Search",
    position: 0.2,
    updatedAt: 0,
    done: false,
    ...partial,
  };
}

describe("clampPosition", () => {
  it("holds the dot on the hill", () => {
    expect(clampPosition(-3)).toBe(0);
    expect(clampPosition(1.4)).toBe(1);
    expect(clampPosition(0.5)).toBe(0.5);
  });

  /// A persisted scope is user-editable JSON on disk. `NaN` reaching the
  /// renderer produces an SVG path of `NaN NaN` and a blank chart.
  it("treats a non-finite position as the start rather than rendering NaN", () => {
    expect(clampPosition(Number.NaN)).toBe(0);
    expect(clampPosition(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("phaseOf", () => {
  it("names the three phases", () => {
    expect(phaseOf(scope({ position: 0.1 }))).toBe("uphill");
    expect(phaseOf(scope({ position: 0.5 }))).toBe("crest");
    expect(phaseOf(scope({ position: 0.9 }))).toBe("downhill");
  });

  /// A crest with no width is a transition no hand-dragged dot ever lands on,
  /// which would make the most important state in the model unobservable.
  it("gives the crest enough width to actually land on", () => {
    expect(phaseOf(scope({ position: 0.48 }))).toBe("crest");
    expect(phaseOf(scope({ position: 0.52 }))).toBe("crest");
    expect(phaseOf(scope({ position: 0.4 }))).toBe("uphill");
  });

  it("reports done regardless of position", () => {
    expect(phaseOf(scope({ position: 0.2, done: true }))).toBe("done");
  });
});

describe("hillHeight", () => {
  /// The curve must meet the baseline flat at both ends, or the drawn hill has
  /// a visible corner where it joins the axis.
  it("is zero at both ends and one at the crest", () => {
    expect(hillHeight(0)).toBeCloseTo(0, 10);
    expect(hillHeight(1)).toBeCloseTo(0, 10);
    expect(hillHeight(0.5)).toBeCloseTo(1, 10);
  });

  it("is symmetric about the crest", () => {
    expect(hillHeight(0.3)).toBeCloseTo(hillHeight(0.7), 10);
  });

  it("rises monotonically up the first half", () => {
    let previous = -1;
    for (let p = 0; p <= 0.5; p += 0.05) {
      const h = hillHeight(p);
      expect(h).toBeGreaterThan(previous);
      previous = h;
    }
  });
});

describe("pointAt and hillPath", () => {
  it("puts the crest at the top of the box and the ends on the baseline", () => {
    expect(pointAt(0, 200, 80)).toEqual({ x: 0, y: 80 });
    expect(pointAt(0.5, 200, 80).y).toBeCloseTo(0, 6);
    expect(pointAt(1, 200, 80).x).toBe(200);
  });

  /// The dot is placed with `pointAt`; if the path were an approximation of a
  /// different function the dot would sit off its own curve.
  it("draws the path through the same points the dot uses", () => {
    const path = hillPath(200, 80, 4);
    const crest = pointAt(0.5, 200, 80);
    expect(path).toContain(`${crest.x.toFixed(2)} ${crest.y.toFixed(2)}`);
    expect(path.startsWith("M")).toBe(true);
  });

  it("never emits NaN, whatever the sample count", () => {
    for (const samples of [0, 1, 2, 7]) {
      expect(hillPath(100, 40, samples)).not.toContain("NaN");
    }
  });
});

describe("describeMove", () => {
  /// Crossing the crest is the event worth reading in a check-in six weeks
  /// later — the summary has to name it, not just say the dot moved.
  it("names the crossing when the phase changes", () => {
    expect(describeMove("Search", 0.3, 0.8)).toBe(
      "Search is over the hill — now making it happen",
    );
    expect(describeMove("Search", 0.8, 0.2)).toBe(
      "Search went back uphill — still figuring it out",
    );
    expect(describeMove("Search", 0.2, 0.5)).toBe("Search reached the crest");
  });

  it("states the direction within a phase", () => {
    expect(describeMove("Search", 0.1, 0.3)).toBe("Search moved forward, figuring it out");
    expect(describeMove("Search", 0.9, 0.7)).toBe("Search moved back, making it happen");
  });

  /// "68%" is the false precision the hill exists to replace.
  it("never states a percentage", () => {
    expect(describeMove("Search", 0.11, 0.68)).not.toMatch(/\d/);
  });
});

describe("stalledDays", () => {
  const now = new Date(2026, 6, 31, 12).getTime();

  it("is null for a scope moved today", () => {
    expect(stalledDays(scope({ updatedAt: now - 3_600_000 }), now)).toBeNull();
  });

  /// A scope nobody has moved in a week is how "we are stuck" becomes visible
  /// without anyone having to say it in a meeting.
  it("counts whole days of standing still", () => {
    expect(stalledDays(scope({ updatedAt: now - 7 * 86_400_000 }), now)).toBe(7);
  });
});

describe("compareScopes", () => {
  /// Sorting by progress buries the work that needs attention under the work
  /// that is already safe.
  it("puts what is still being figured out above what is being executed", () => {
    const uphill = scope({ id: "u", name: "Uphill", position: 0.1 });
    const downhill = scope({ id: "d", name: "Downhill", position: 0.9 });
    expect([downhill, uphill].sort(compareScopes).map((s) => s.name)).toEqual([
      "Uphill",
      "Downhill",
    ]);
  });

  it("sinks finished scopes without removing them", () => {
    const done = scope({ id: "d", name: "Done", position: 0.1, done: true });
    const live = scope({ id: "l", name: "Live", position: 0.9 });
    expect([done, live].sort(compareScopes).map((s) => s.name)).toEqual(["Live", "Done"]);
  });

  it("is stable for two scopes at the same position", () => {
    const a = scope({ id: "a", name: "Alpha", position: 0.3 });
    const b = scope({ id: "b", name: "Beta", position: 0.3 });
    expect([b, a].sort(compareScopes).map((s) => s.name)).toEqual(["Alpha", "Beta"]);
  });
});
