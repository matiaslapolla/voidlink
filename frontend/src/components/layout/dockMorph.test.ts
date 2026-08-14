/// The two decisions in the dock's opening gesture that have a wrong answer:
/// where the panel grows *from*, and whether it grows at all.
///
/// The playback itself (`runDockMorph`) is one `Element.animate` call and is not
/// tested here — asserting on a keyframe list is asserting that the browser
/// still has an animation engine. What is worth holding is that a keyboard user
/// never gets motion (§7.1 is absolute) and that an origin outside the panel is
/// clamped rather than swung through.
import { describe, expect, it } from "vitest";

import {
  morphDurationMs,
  morphEasing,
  morphOrigin,
  shouldMorph,
  type MorphBox,
} from "./dockMorph";

/// A panel on the left edge, clear of a 40px strip plus the 6px island gap —
/// the geometry `AppShell`'s `room()` actually produces in docked mode.
const PANEL: MorphBox = { left: 46, top: 0, width: 256, height: 800 };

describe("morphOrigin", () => {
  it("puts the origin under the button that opened the panel", () => {
    // A dock button centred at y=300, in the lane to the panel's left.
    expect(morphOrigin(PANEL, { x: 26, y: 300 })).toEqual({ x: 0, y: 300 });
  });

  it("clamps a button outside the panel to the nearest edge", () => {
    // The button is *always* outside: the strip sits in the lane the panel
    // stops short of. Left of the box clamps to x=0 rather than going negative,
    // which is what keeps the growth anchored instead of arcing.
    expect(morphOrigin(PANEL, { x: -500, y: 300 }).x).toBe(0);
    expect(morphOrigin(PANEL, { x: 5000, y: 300 }).x).toBe(256);
  });

  it("clamps along the panel's own axis too", () => {
    // A bottom-edge dock puts the button below a full-height panel.
    expect(morphOrigin(PANEL, { x: 100, y: 9999 }).y).toBe(800);
    expect(morphOrigin(PANEL, { x: 100, y: -20 }).y).toBe(0);
  });

  it("survives a panel with no box", () => {
    const empty: MorphBox = { left: 0, top: 0, width: 0, height: 0 };
    expect(morphOrigin(empty, { x: 50, y: 50 })).toEqual({ x: 0, y: 0 });
  });
});

describe("shouldMorph", () => {
  it("moves for a pointer", () => {
    expect(shouldMorph({ pointer: true, reducedMotion: false })).toBe(true);
  });

  it("never moves for the keyboard", () => {
    // §7.1: keyboard-initiated is `--dur-instant`, without exception.
    expect(shouldMorph({ pointer: false, reducedMotion: false })).toBe(false);
  });

  it("never moves under prefers-reduced-motion", () => {
    // `index.css` flattens transitions, but a WAAPI animation is not a
    // transition and that block cannot reach it — so it is asked here.
    expect(shouldMorph({ pointer: true, reducedMotion: true })).toBe(false);
  });
});

describe("the two directions", () => {
  /// §7.1's out is 75% of its in, and the curves are not each other's reverse.
  /// Asserted as a relationship rather than against two literals: the numbers
  /// are tokens, and a test that restated them would just be a third place they
  /// could drift from `index.css`.
  it("leaves faster than it arrives", () => {
    expect(morphDurationMs("out")).toBeLessThan(morphDurationMs("in"));
  });

  it("stays inside the motion budget in both directions", () => {
    // §7.1 budgets 120–240ms. A morph outside it is not a slower morph, it is a
    // different doctrine.
    for (const direction of ["in", "out"] as const) {
      expect(morphDurationMs(direction)).toBeGreaterThanOrEqual(120);
      expect(morphDurationMs(direction)).toBeLessThanOrEqual(240);
    }
  });

  it("decelerates in and accelerates out", () => {
    // Not the same curve reversed — entering settles, leaving gets out of the
    // way. Equal curves here would mean the token lookup silently fell through
    // to one fallback for both.
    expect(morphEasing("in")).not.toBe(morphEasing("out"));
  });
});
