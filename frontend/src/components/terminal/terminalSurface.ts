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
/// shell rather than a panel floating on it.
///
/// This used to hold two hardcoded backgrounds — `#09090b` and `#fdf6e3` — and
/// keep the contract by being structurally unable to read a token. It now
/// states the contract positively instead: the pane box takes `--elev-1` by
/// name, and the grid takes `--term-bg`, which `index.css` defines as
/// `var(--elev-1)` and which no theme in `themes.css` overrides. `--background`
/// and `--canvas` appear in neither, and are absent from
/// `terminalTheme.ts`'s token list too, so neither can reach the grid — the
/// same contract `monacoTheme.ts` keeps, now held by the token graph rather
/// than by the absence of a lookup.
///
/// The pane box is a styled DOM element, so it takes the `var()` verbatim and
/// the cascade resolves it: no parsing, no snapshot, nothing to go stale on a
/// theme change. Only the grid needs a resolved colour, because it is a canvas
/// — and that one already arrives parsed in `--term-bg`, which is why the
/// opaque case here overrides nothing at all.

/// The pane box's `background-color`, as a CSS value rather than a colour.
///
/// `--elev-1` and not `--background`: they resolve to the same colour today,
/// and the whole point of D1 is that they are allowed to stop doing so.
export const PANE_BG = "var(--elev-1)";

/// Fully transparent, as `#rrggbbaa`. xterm only honours the alpha channel of
/// a theme background with `allowTransparency` on: with it off the WebGL
/// texture atlas strips it and the grid paints opaque.
export const TRANSPARENT = "#00000000";

export interface TerminalSurface {
  /// `background-color` for the pane box behind the grid.
  paneBg: string;
  /// An override for `theme.background` on the xterm instance, or `undefined`
  /// to leave the theme's own `--term-bg` in place. Undefined is the ordinary
  /// case: a surface decision that has nothing to say about colour should not
  /// be restating the colour.
  gridBg: string | undefined;
  /// `allowTransparency`. Not free — with it on xterm can no longer assume a
  /// cell's background is opaque, so the renderer stops skipping cells it
  /// would otherwise leave to the clear colour — so it tracks the one case
  /// that needs it rather than being left on.
  allowTransparency: boolean;
}

/// `translucent` is `surfacesAreTranslucent()` from `store/settings.ts`: an
/// image is actually painted, the user asked the surfaces to let it through,
/// and the OS is not overriding that.
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
export function terminalSurface(translucent: boolean): TerminalSurface {
  if (translucent) {
    return { paneBg: "transparent", gridBg: TRANSPARENT, allowTransparency: true };
  }
  return { paneBg: PANE_BG, gridBg: undefined, allowTransparency: false };
}
