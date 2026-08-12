import { describe, expect, it } from "vitest";
import { DARK_BG, LIGHT_BG, TRANSPARENT, terminalSurface } from "./terminalSurface";

describe("terminalSurface", () => {
  /// The regression guard that matters most: an install with no background
  /// image is the overwhelming majority, and it must render byte-identically
  /// to what shipped — including `allowTransparency` staying off, which is the
  /// half that costs rendering work rather than pixels.
  it("is exactly the old opaque terminal when nothing is showing through", () => {
    expect(terminalSurface("dark", false)).toEqual({
      paneBg: DARK_BG,
      gridBg: DARK_BG,
      allowTransparency: false,
    });
    expect(terminalSurface("light", false)).toEqual({
      paneBg: LIGHT_BG,
      gridBg: LIGHT_BG,
      allowTransparency: false,
    });
  });

  it("clears both layers, not one, once the image shows through", () => {
    for (const mode of ["dark", "light"] as const) {
      const s = terminalSurface(mode, true);
      // Two translucent layers would compound — 50% over 50% reads as 75% —
      // so the pane box and the grid go transparent together and the single
      // tint comes from the island behind them.
      expect(s.paneBg, mode).toBe("transparent");
      expect(s.gridBg, mode).toBe(TRANSPARENT);
      // Without this xterm's texture atlas strips the alpha and paints opaque,
      // which is the failure mode that looks like "the setting does nothing".
      expect(s.allowTransparency, mode).toBe(true);
    }
  });

  it("keeps the grid colours off the chrome tokens (D1)", () => {
    // The island invariant: these are literals, so no amount of canvas
    // recession can reach them. A `var(--…)` creeping in here is the bug.
    expect(DARK_BG).not.toContain("var(");
    expect(LIGHT_BG).not.toContain("var(");
  });
});
