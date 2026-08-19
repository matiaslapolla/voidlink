import { describe, expect, it } from "vitest";
import { PANE_BG, TRANSPARENT, terminalSurface } from "./terminalSurface";

describe("terminalSurface", () => {
  /// The regression guard that matters most: an install with no background
  /// image is the overwhelming majority, and it must keep rendering the theme's
  /// own body — including `allowTransparency` staying off, which is the half
  /// that costs rendering work rather than pixels.
  it("leaves the theme's colours alone when nothing is showing through", () => {
    const s = terminalSurface(false);
    expect(s.paneBg).toBe(PANE_BG);
    // The point of `undefined`: a surface decision with nothing to say about
    // colour must not restate one. Overriding here with a colour of its own is
    // exactly how the pane ended up with two hardcoded backgrounds.
    expect(s.gridBg).toBeUndefined();
    expect(s.allowTransparency).toBe(false);
  });

  it("clears both layers, not one, once the image shows through", () => {
    const s = terminalSurface(true);
    // Two translucent layers would compound — 50% over 50% reads as 75% — so
    // the pane box and the grid go transparent together and the single tint
    // comes from the island behind them.
    expect(s.paneBg).toBe("transparent");
    expect(s.gridBg).toBe(TRANSPARENT);
    // Without this xterm's texture atlas strips the alpha and paints opaque,
    // which is the failure mode that looks like "the setting does nothing".
    expect(s.allowTransparency).toBe(true);
  });

  it("keeps the pane box on the island token, not the chrome ones (D1)", () => {
    // The island invariant. It used to be kept by holding two literals that no
    // token could reach; it is now kept by naming the *right* token. Reading
    // `--background` would survive today (it is the same colour) and break the
    // moment D1's recession moves, which is the whole reason `--elev-1` exists.
    expect(PANE_BG).toBe("var(--elev-1)");
    expect(PANE_BG).not.toContain("--canvas");
    expect(PANE_BG).not.toContain("--background");
  });
});
