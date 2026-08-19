/// The xterm palette, derived from VoidLink's own CSS custom properties.
///
/// The twin of `editor/monacoTheme.ts`, and it exists for the same reason and
/// fixes the same class of bug one surface over. VoidLink ships ten themes;
/// the terminal used to hold exactly two palettes, picked with
/// `mode() === "light" ? LIGHT : DARK`. So `dracula`, `nord`, `monokai`,
/// `github-dark`, `solarized-dark` and `one-dark` — six of the ten — all
/// rendered the same zinc grid, and only the light/dark toggle moved anything.
/// That is "theme no cambia terminal".
///
/// **Why the sixteen colours are still literals, just not *here*.**
/// `tokenHygiene.test.ts` exempted `TerminalPane.tsx` with a real argument:
/// routing sixteen ANSI slots through VoidLink's six semantic colours "would
/// produce a terminal that lies about what a program printed". That argument
/// is intact and this module obeys it — nothing below derives red from
/// `--destructive`. What changed is *where* the palette lives: `themes.css`,
/// which the same test calls the place literals are supposed to live, one
/// canonical ANSI table per theme. A palette stops being a literal smuggled
/// into a component and becomes what it always was, a per-theme constant.
///
/// **The D1 contract, unchanged.** The grid must render at *island* lightness.
/// `--term-bg` defaults to `var(--elev-1)` and no theme overrides it, so that
/// is now enforced by the token graph rather than by a comment. `--background`
/// and `--canvas` are absent from `TERM_TOKEN_NAMES` on purpose, and
/// `terminalTheme.test.ts` asserts it.
///
/// Everything below `readTermTokens` is pure — it maps a token record to an
/// xterm `ITheme` — which is what makes it testable in `node`, where there is
/// no cascade to compute.

import type { ITheme } from "@xterm/xterm";
import { cssColorToHex } from "@/components/editor/cssColor";

/// The palette tokens, in xterm's own vocabulary.
///
/// Named rather than numbered (`--term-blue`, not `--term-ansi-4`) because the
/// table is authored by hand ten times over: an off-by-one in a numbered slot
/// is invisible in review and shows up as "why is git's diff magenta", while a
/// misspelled name is a missing key that falls back visibly. The names map 1:1
/// onto `ITheme`, so `THEME_KEY` below is a rename and not a decision.
export const TERM_TOKEN_NAMES = [
  "--term-bg",
  "--term-fg",
  "--term-cursor",
  "--term-cursor-accent",
  "--term-selection",
  "--term-black",
  "--term-red",
  "--term-green",
  "--term-yellow",
  "--term-blue",
  "--term-magenta",
  "--term-cyan",
  "--term-white",
  "--term-bright-black",
  "--term-bright-red",
  "--term-bright-green",
  "--term-bright-yellow",
  "--term-bright-blue",
  "--term-bright-magenta",
  "--term-bright-cyan",
  "--term-bright-white",
] as const;

export type TermTokenName = (typeof TERM_TOKEN_NAMES)[number];
export type TermTokens = Record<TermTokenName, string>;

/// Token → `ITheme` key. The whole mapping, as data, so the derivation below is
/// a loop rather than twenty-one hand-written assignments that can disagree.
const THEME_KEY: Record<TermTokenName, keyof ITheme> = {
  "--term-bg": "background",
  "--term-fg": "foreground",
  "--term-cursor": "cursor",
  "--term-cursor-accent": "cursorAccent",
  "--term-selection": "selectionBackground",
  "--term-black": "black",
  "--term-red": "red",
  "--term-green": "green",
  "--term-yellow": "yellow",
  "--term-blue": "blue",
  "--term-magenta": "magenta",
  "--term-cyan": "cyan",
  "--term-white": "white",
  "--term-bright-black": "brightBlack",
  "--term-bright-red": "brightRed",
  "--term-bright-green": "brightGreen",
  "--term-bright-yellow": "brightYellow",
  "--term-bright-blue": "brightBlue",
  "--term-bright-magenta": "brightMagenta",
  "--term-bright-cyan": "brightCyan",
  "--term-bright-white": "brightWhite",
};

/// The one token whose alpha is meaningful. xterm composites the selection over
/// whatever the cell already holds, so a translucent value is a feature there
/// and a hole in every other slot — a "50% red" glyph would render as the
/// background showing through the letterform.
const KEEPS_ALPHA: ReadonlySet<TermTokenName> = new Set(["--term-selection"]);

/// Snapshot the live cascade. Reads `<html>`, where both the mode class and
/// `data-theme` land (see `store/theme.ts`), so a named theme's overrides are
/// already resolved by the time this runs.
///
/// Custom properties substitute their `var()` references at computed-value
/// time, which is why `--term-bg: var(--elev-1)` arrives here as the theme's
/// actual `oklch(...)` and not as the literal string `var(--elev-1)`.
export function readTermTokens(el: Element = document.documentElement): TermTokens {
  const computed = getComputedStyle(el);
  const out = {} as TermTokens;
  for (const name of TERM_TOKEN_NAMES) {
    out[name] = computed.getPropertyValue(name).trim();
  }
  return out;
}

/// Derive the xterm theme. Pure: `tokens` and `gridBg` are the only inputs.
///
/// `gridBg` overrides `--term-bg` and exists for exactly one caller — the
/// translucent surface, which needs `#00000000` in that slot while every other
/// colour stays the theme's (see `terminalSurface.ts` for why both layers clear
/// together). Passing it as an argument rather than reading the setting keeps
/// this module free of the settings store.
///
/// A token that fails to parse is dropped rather than defaulted. xterm falls
/// back to its own built-in colour for an absent key, which is a far better
/// failure than the `#000000` that `?? "#000"` would produce — a themes.css
/// typo costs one wrong-ish colour instead of an unreadable grid.
export function deriveXtermTheme(tokens: TermTokens, gridBg?: string): ITheme {
  const theme: ITheme = {};
  const bg = tokens["--term-bg"];

  for (const name of TERM_TOKEN_NAMES) {
    const hex = cssColorToHex(tokens[name], KEEPS_ALPHA.has(name) ? {} : { over: bg });
    if (hex) (theme as Record<string, string>)[THEME_KEY[name]] = hex;
  }

  // Last, so it wins over the token even when the token parsed fine.
  if (gridBg !== undefined) theme.background = gridBg;
  return theme;
}
