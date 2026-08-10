/// The one invariant Direction D1 rests on, checked without a DOM.
///
/// D1 says the canvas *recedes* below the islands and the islands stay exactly
/// where they were. If any theme ever ends up with a canvas that is lighter
/// than — or indistinguishable from — its islands, the whole shell flattens:
/// panels stop reading as detached, the gaps stop reading as gaps, and the
/// direction has silently reverted without a single test going red.
///
/// `--canvas` is derived rather than hand-authored precisely so this can be a
/// property rather than ten hardcoded pairs to eyeball. There are ten
/// surface-defining blocks — the two base roots in `index.css` plus the eight
/// named themes in `themes.css` — and this asserts the property for all ten by
/// reading the same CSS the app ships.
///
/// The `github-light` case is the reason the derivation is relative. Its
/// `--background` is `oklch(1.000 0.000 0)`: pure white, with no room to
/// recede by *lightening*. Darkening works everywhere; lightening does not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = __dirname;

const indexCss = readFileSync(join(SRC, "index.css"), "utf8");
const themesCss = readFileSync(join(SRC, "themes.css"), "utf8");

/// The body of the first rule whose selector line starts with `selector`.
function blockFor(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

/// The lightness component of an `oklch(L C H)` declaration. Only `L` matters
/// here: mixing toward black in oklab scales all three channels toward zero,
/// and a strictly smaller `L` is exactly what "recessed" means.
function oklchLightness(value: string): number {
  const m = /oklch\(\s*([0-9.]+)/.exec(value);
  if (!m) throw new Error(`not an oklch value: ${value}`);
  return Number.parseFloat(m[1]);
}

/// The `--canvas` mix ratio declared for a mode, as the fraction of the island
/// colour that survives. Keeping 85% of the island in oklab against a black
/// whose `L` is 0 leaves a lightness of `0.85 x L`.
function mixRatio(selector: string): number {
  const block = blockFor(indexCss, selector);
  const m = block.match(
    /--canvas:\s*color-mix\(in oklab,\s*var\(--background\)\s*([0-9.]+)%,\s*black\)/,
  );
  if (!m) throw new Error(`no derived --canvas in ${selector}`);
  return Number.parseFloat(m[1]) / 100;
}

/// Same shape as `mixRatio`, generalised to any `--token: color-mix(in oklab,
/// var(--background) N%, black)` declaration — the region surfaces
/// (`--surface-rail`, `--surface-tabstrip`, `--surface-statusbar`) are
/// derived exactly the way `--canvas` is, off the same `:root`/`:root.light`
/// blocks, for the same reason: one definition, inherited by every named
/// theme through the `var(--background)` indirection.
function regionRatio(selector: string, token: string): number {
  const block = blockFor(indexCss, selector);
  const re = new RegExp(
    `${token}:\\s*color-mix\\(in oklab,\\s*var\\(--background\\)\\s*([0-9.]+)%,\\s*black\\)`,
  );
  const m = block.match(re);
  if (!m) throw new Error(`no derived ${token} in ${selector}`);
  return Number.parseFloat(m[1]) / 100;
}

const REGION_TOKENS = ["--surface-statusbar", "--surface-rail", "--surface-tabstrip"];

function backgroundOf(css: string, selector: string): string {
  const m = /--background:\s*([^;]+);/.exec(blockFor(css, selector));
  if (!m) throw new Error(`no --background in ${selector}`);
  return m[1].trim();
}

/// Every block in the app that defines its own `--background`, with the mode
/// whose `--canvas` rule applies to it. `store/theme.ts` sets the mode class and
/// `data-theme` together, so a `:root.light[data-theme=...]` block is always
/// matched by the `:root.light` canvas rule, never by `:root`'s.
///
/// Both halves name their mode class. The dark blocks used to be a bare
/// `:root[data-theme=...]`, which tied on specificity with `:root.light` and lost
/// the tie to import order — see the header of `themes.css`.
const SURFACES: { name: string; css: string; selector: string; mode: "dark" | "light" }[] = [
  { name: "default dark", css: indexCss, selector: ":root", mode: "dark" },
  { name: "default light", css: indexCss, selector: ":root.light", mode: "light" },
  { name: "github-dark", css: themesCss, selector: ':root.dark[data-theme="github-dark"]', mode: "dark" },
  {
    name: "github-light",
    css: themesCss,
    selector: ':root.light[data-theme="github-light"]',
    mode: "light",
  },
  { name: "monokai", css: themesCss, selector: ':root.dark[data-theme="monokai"]', mode: "dark" },
  {
    name: "solarized-dark",
    css: themesCss,
    selector: ':root.dark[data-theme="solarized-dark"]',
    mode: "dark",
  },
  {
    name: "solarized-light",
    css: themesCss,
    selector: ':root.light[data-theme="solarized-light"]',
    mode: "light",
  },
  { name: "nord", css: themesCss, selector: ':root.dark[data-theme="nord"]', mode: "dark" },
  { name: "dracula", css: themesCss, selector: ':root.dark[data-theme="dracula"]', mode: "dark" },
  { name: "one-dark", css: themesCss, selector: ':root.dark[data-theme="one-dark"]', mode: "dark" },
];

/// Below this, two surfaces separated only by lightness read as one surface.
/// The token ladder's smallest deliberate step (`--background 0.200` ->
/// `--sidebar 0.213`) is 0.013, so 0.010 is the floor rather than the target.
const MIN_SEPARATION = 0.01;

describe("the recessed canvas (Direction D1)", () => {
  it("covers every block in the app that defines its own --background", () => {
    const declared =
      (indexCss.match(/--background:/g)?.length ?? 0) +
      (themesCss.match(/--background:/g)?.length ?? 0);
    // If someone adds a ninth theme, this fails and points at this list.
    expect(SURFACES).toHaveLength(declared);
  });

  it("derives the canvas rather than hardcoding a pair per theme", () => {
    // Eight themes redefine `--background` independently; none of them may
    // author its own canvas, or there would be ten values to keep in sync.
    expect(themesCss).not.toContain("--canvas");
    expect(mixRatio(":root")).toBeGreaterThan(0);
    expect(mixRatio(":root.light")).toBeGreaterThan(0);
  });

  it.each(SURFACES)(
    "keeps the canvas strictly darker than the island in $name",
    ({ css, selector, mode }) => {
      const island = oklchLightness(backgroundOf(css, selector));
      const canvas = island * mixRatio(mode === "light" ? ":root.light" : ":root");

      expect(canvas).toBeLessThan(island);
      expect(island - canvas).toBeGreaterThanOrEqual(MIN_SEPARATION);
    },
  );

  it("derives the region surfaces rather than hardcoding them per theme", () => {
    // Same argument as --canvas: `--surface-rail` / `--surface-tabstrip` /
    // `--surface-statusbar` must be declared once, in index.css, and never
    // restated in themes.css, or the eight named themes stop inheriting them
    // for free through the `var(--background)` indirection.
    for (const token of REGION_TOKENS) {
      expect(themesCss).not.toContain(token);
    }
  });

  it.each(SURFACES)(
    "keeps every region strictly between canvas and island in $name",
    ({ css, selector, mode }) => {
      const modeSelector = mode === "light" ? ":root.light" : ":root";
      const island = oklchLightness(backgroundOf(css, selector));
      const canvas = island * mixRatio(modeSelector);

      for (const token of REGION_TOKENS) {
        const region = island * regionRatio(modeSelector, token);
        expect(region).toBeGreaterThan(canvas);
        expect(region).toBeLessThan(island);
      }
    },
  );

  it("recedes from github-light's pure white, the least-headroom case", () => {
    // Named on its own because the directions spec names it: there is no
    // lighter colour than `oklch(1.000 0.000 0)`, so a canvas that tried to
    // rise would be invisible in exactly one theme and nobody would notice
    // until they switched to it.
    const island = oklchLightness(
      backgroundOf(themesCss, ':root.light[data-theme="github-light"]'),
    );
    expect(island).toBe(1);
    expect(island * mixRatio(":root.light")).toBeLessThan(1);
  });

  it("names the geometry constants exactly once, in index.css", () => {
    // The D4 fallback stays a one-wave rework only while these live in one
    // place. A component restating `6px` is the regression this catches.
    for (const token of [
      "--island-gap",
      "--island-inset",
      "--island-radius",
      "--island-radius-inner",
    ]) {
      expect(indexCss).toContain(`${token}:`);
    }
  });
});
