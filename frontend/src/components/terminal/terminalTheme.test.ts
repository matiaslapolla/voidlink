/// The terminal palette, asserted against the CSS the app actually ships.
///
/// The bug this locks down: the terminal held two palettes and picked between
/// them with `mode() === "light"`. Six of the ten themes are dark, so
/// `github-dark`, `monokai`, `solarized-dark`, `nord`, `dracula` and `one-dark`
/// all rendered the *same* zinc grid, and switching between them repainted
/// nothing. Nothing failed, because nothing was checking that a theme's
/// terminal looked like that theme.
///
/// So the load-bearing test here is `every theme's palette is distinct`. The
/// rest — completeness, parseability, the D1 token contract — are the ways a
/// hand-authored table of sixteen colours times ten themes goes wrong quietly.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TERM_TOKEN_NAMES,
  deriveXtermTheme,
  type TermTokens,
} from "./terminalTheme";

const SRC = join(__dirname, "..", "..");
const indexCss = readFileSync(join(SRC, "index.css"), "utf8");
const themesCss = readFileSync(join(SRC, "themes.css"), "utf8");

/// Every declaration of `--term-*` under `selector`, across *all* of that
/// selector's blocks in the file.
///
/// "All", not "the first", is the part that matters: `themes.css` declares each
/// named theme twice on purpose — once for its chrome tokens near the top and
/// once for its ANSI table in the palette section at the bottom — and a reader
/// that stopped at the first block would find no palette at all and quietly
/// assert nothing.
function termDeclarations(css: string, selector: string): Partial<TermTokens> {
  const out: Partial<TermTokens> = {};
  let from = 0;
  let found = 0;
  for (;;) {
    const at = css.indexOf(`${selector} {`, from);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    const body = css.slice(open + 1, close);
    for (const name of TERM_TOKEN_NAMES) {
      const m = body.match(new RegExp(`${name}:\\s*([^;]+);`));
      if (m) out[name] = m[1].replace(/\/\*.*?\*\//g, "").trim();
    }
    from = close + 1;
    found += 1;
  }
  if (found === 0) throw new Error(`no rule for ${selector}`);
  return out;
}

/// The ten themes, and the cascade each one resolves through. Custom properties
/// on `<html>` layer by specificity: `:root` (0-1-0) is the floor, `:root.light`
/// (0-2-0) is the light floor, and `:root.<mode>[data-theme=…]` (0-3-0) wins.
/// Merging in that order is the cascade, for these declarations, exactly.
const THEMES: { id: string; mode: "dark" | "light" }[] = [
  { id: "dark", mode: "dark" },
  { id: "light", mode: "light" },
  { id: "github-dark", mode: "dark" },
  { id: "github-light", mode: "light" },
  { id: "monokai", mode: "dark" },
  { id: "solarized-dark", mode: "dark" },
  { id: "solarized-light", mode: "light" },
  { id: "nord", mode: "dark" },
  { id: "dracula", mode: "dark" },
  { id: "one-dark", mode: "dark" },
];

const ROOT = termDeclarations(indexCss, ":root");
const ROOT_LIGHT = termDeclarations(indexCss, ":root.light");

function resolve(theme: { id: string; mode: "dark" | "light" }): TermTokens {
  const layers: Partial<TermTokens>[] = [ROOT];
  if (theme.mode === "light") layers.push(ROOT_LIGHT);
  if (theme.id !== "dark" && theme.id !== "light") {
    layers.push(termDeclarations(themesCss, `:root.${theme.mode}[data-theme="${theme.id}"]`));
  }
  const merged = Object.assign({}, ...layers) as TermTokens;
  // `--term-bg` and `--term-cursor-accent` are the two `var()` references in
  // the table, and both resolve to the island. The browser substitutes them at
  // computed-value time; here that is one hardcoded step, because chasing
  // `--elev-1` → `--background` → the theme's oklch would be reimplementing the
  // cascade to assert a colour no test below actually reads.
  merged["--term-bg"] = "#101014";
  merged["--term-cursor-accent"] = "#101014";
  return merged;
}

describe("the shipped terminal palettes", () => {
  it("covers all ten themes", () => {
    expect(THEMES).toHaveLength(10);
  });

  it.each(THEMES)("$id declares every palette token", (theme) => {
    const tokens = resolve(theme);
    const missing = TERM_TOKEN_NAMES.filter((n) => !tokens[n]);
    expect(missing).toEqual([]);
  });

  it.each(THEMES)("$id's tokens all parse to a colour", (theme) => {
    // `deriveXtermTheme` drops what it cannot parse, so a dropped key is a
    // typo in `themes.css` — a missing `#`, a five-digit hex — that would
    // otherwise ship as one slot silently falling back to xterm's own default.
    const derived = deriveXtermTheme(resolve(theme));
    expect(Object.keys(derived)).toHaveLength(TERM_TOKEN_NAMES.length);
    for (const [key, value] of Object.entries(derived)) {
      expect(value, key).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    }
  });

  /// The regression. Before this change the answer for six of these was one
  /// shared object.
  it("gives every theme a palette of its own", () => {
    const ansi = TERM_TOKEN_NAMES.filter((n) => n !== "--term-bg" && n !== "--term-cursor-accent");
    const seen = new Map<string, string>();
    for (const theme of THEMES) {
      const tokens = resolve(theme);
      const key = ansi.map((n) => tokens[n]).join("|");
      const twin = seen.get(key);
      expect(twin, `${theme.id} has the same palette as ${twin}`).toBeUndefined();
      seen.set(key, theme.id);
    }
  });

  /// Direction D1: the grid renders at island lightness. `terminalSurface.ts`
  /// used to hold this by being unable to read a token at all; it now holds
  /// because of what the tokens say, so this is where it is checked.
  it("pins the grid background to the island, in one place, forever", () => {
    expect(ROOT["--term-bg"]).toBe("var(--elev-1)");
    for (const theme of THEMES) {
      if (theme.id === "dark" || theme.id === "light") continue;
      const own = termDeclarations(themesCss, `:root.${theme.mode}[data-theme="${theme.id}"]`);
      // A theme that set its own `--term-bg` would be a terminal painted at
      // some colour the shell around it does not use — the "hole punched in
      // the shell" D1 exists to prevent.
      expect(own["--term-bg"], theme.id).toBeUndefined();
    }
  });

  it("never routes a chrome token into the grid", () => {
    // `--canvas` is the recessed surface *between* islands and `--background`
    // is allowed to drift away from `--elev-1`. Neither may reach the terminal.
    for (const theme of THEMES) {
      for (const [name, value] of Object.entries(resolve(theme))) {
        expect(value, `${theme.id} ${name}`).not.toContain("--canvas");
        expect(value, `${theme.id} ${name}`).not.toContain("var(--background)");
      }
    }
  });
});

describe("deriveXtermTheme", () => {
  const tokens = Object.fromEntries(
    TERM_TOKEN_NAMES.map((n) => [n, n === "--term-bg" ? "#000000" : "#abcdef"]),
  ) as TermTokens;

  it("maps every token onto an xterm key", () => {
    const derived = deriveXtermTheme(tokens) as Record<string, string>;
    expect(derived.background).toBe("#000000");
    expect(derived.foreground).toBe("#abcdef");
    expect(derived.brightWhite).toBe("#abcdef");
    expect(derived.selectionBackground).toBe("#abcdef");
  });

  it("lets the surface override the background and nothing else", () => {
    const derived = deriveXtermTheme(tokens, "#00000000") as Record<string, string>;
    expect(derived.background).toBe("#00000000");
    // The override is a surface decision about one slot. If it reached the
    // ANSI table, a translucent terminal would lose its theme entirely.
    expect(derived.red).toBe("#abcdef");
  });

  it("keeps alpha on the selection and flattens it everywhere else", () => {
    const translucent = { ...tokens, "--term-selection": "#abcdef80", "--term-red": "#ffffff80" };
    const derived = deriveXtermTheme(translucent) as Record<string, string>;
    // xterm composites the selection over the cell, so alpha is the feature.
    expect(derived.selectionBackground).toBe("#abcdef80");
    // A half-transparent glyph colour is a hole in the letterform, not a
    // lighter red — so it is composited over the body first.
    expect(derived.red).toBe("#808080");
  });

  it("drops a token it cannot parse rather than defaulting it to black", () => {
    const broken = { ...tokens, "--term-green": "not-a-colour" };
    const derived = deriveXtermTheme(broken) as Record<string, string>;
    expect("green" in derived).toBe(false);
  });
});
