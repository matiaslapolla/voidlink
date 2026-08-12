/// What colour the terminal paints itself, and whether it paints itself at
/// all.
///
/// Split out of `TerminalPane.tsx` for the same reason `terminalMenu.ts` was:
/// it is a decision, not a rendering, and the pane it belongs to cannot be
/// mounted without xterm, a PTY and a webview under it.
///
/// **Direction D1 audit (islands).** The one thing that must be true after the
/// canvas recedes is that the terminal body renders at *island* lightness, not
/// at canvas lightness — otherwise the pane reads as a hole punched in the
/// shell rather than a panel floating on it. These two constants are literals
/// on purpose (a terminal palette is a readability decision, not a chrome
/// one), which means they are structurally immune: nothing here reads
/// `--background`, so nothing here can inherit the recession.
///
/// If this ever starts deriving its palette from the tokens — MASTER §12 lists
/// that as a TODO — it must read `--elev-1`, never `--background` and never
/// `--canvas`. `monacoTheme.ts` has the same contract and a test for it.
export const DARK_BG = "#09090b";
export const LIGHT_BG = "#fdf6e3"; // solarized-base3

/// Fully transparent, as `#rrggbbaa`. xterm only honours the alpha channel of
/// a theme background with `allowTransparency` on: with it off the WebGL
/// texture atlas strips it and the grid paints opaque.
export const TRANSPARENT = "#00000000";

export interface TerminalSurface {
  /// `background-color` for the pane box behind the grid.
  paneBg: string;
  /// `theme.background` for the xterm instance.
  gridBg: string;
  /// `allowTransparency`. Not free — with it on xterm can no longer assume a
  /// cell's background is opaque, so the renderer stops skipping cells it
  /// would otherwise leave to the clear colour — so it tracks the one case
  /// that needs it rather than being left on.
  allowTransparency: boolean;
}

/// `translucent` is `surfacesAreTranslucent()` from `store/settings.ts`:
/// an image is actually painted, the user asked the surfaces to let it
/// through, and the OS is not overriding that.
///
/// Both layers go fully transparent together rather than one of them carrying
/// the island's tint. Two translucent layers at 50% do not read as 50%, they
/// read as 75%, and that compounding is why the opacity slider seemed to
/// bottom out well short of showing the photo. So there is one tinted layer
/// under a terminal and it is the group island behind the pane
/// (`bg-background` in `MainSurface.tsx`), which also already carries the
/// frost. Tinting here and clearing the island would put monospace text on a
/// surface with no `backdrop-filter`, and a photograph's detail arriving
/// unblurred under it is the one thing the frost exists to prevent.
///
/// The D1 invariant above still holds under an image, and more exactly than
/// before: the body renders at island lightness because it is now literally
/// showing the island.
export function terminalSurface(mode: "light" | "dark", translucent: boolean): TerminalSurface {
  if (translucent) {
    return { paneBg: "transparent", gridBg: TRANSPARENT, allowTransparency: true };
  }
  const bg = mode === "light" ? LIGHT_BG : DARK_BG;
  return { paneBg: bg, gridBg: bg, allowTransparency: false };
}
