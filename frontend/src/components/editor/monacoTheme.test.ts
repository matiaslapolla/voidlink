import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cssColorToHex, parseCssColor } from "./cssColor";
import {
  deriveMonacoTheme,
  monacoThemeName,
  otherMode,
  THEME_TOKEN_NAMES,
  VOIDLINK_DARK,
  VOIDLINK_LIGHT,
  voidlinkThemeDefinitions,
  type ThemeTokens,
} from "./monacoTheme";

/// A token record standing in for one theme's slice of the cascade. The real
/// `readCssTokens` needs a browser to compute; everything downstream of it is
/// pure, which is the point of the split.
function tokens(overrides: Partial<ThemeTokens> = {}): ThemeTokens {
  const base = {} as ThemeTokens;
  for (const name of THEME_TOKEN_NAMES) base[name] = "oklch(0.5 0.05 270)";
  return { ...base, ...overrides };
}

describe("cssColorToHex", () => {
  it("converts the oklch notation the token files are written in", () => {
    // Pure white and pure black are the two conversions with a known answer
    // independent of the matrices' rounding.
    expect(cssColorToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(cssColorToHex("oklch(0 0 0)")).toBe("#000000");
  });

  it("round-trips a hex token unchanged", () => {
    expect(cssColorToHex("#0d1117")).toBe("#0d1117");
    expect(cssColorToHex("#0D1117")).toBe("#0d1117");
    expect(cssColorToHex("#abc")).toBe("#aabbcc");
  });

  it("keeps alpha as an eighth and ninth hex digit", () => {
    expect(cssColorToHex("oklch(1 0 0 / 50%)")).toBe("#ffffff80");
    expect(cssColorToHex("oklch(1 0 0)", { alpha: 0.5 })).toBe("#ffffff80");
  });

  it("composites over a background when the caller needs an opaque surface", () => {
    // Monaco renders alpha on `editor.background` as a hole, so those ids go
    // through `over`. White at 50% over black is mid grey.
    expect(cssColorToHex("#ffffff80", { over: "#000000" })).toBe("#808080");
    expect(cssColorToHex("#ffffff", { alpha: 0.5, over: "#000000" })).toBe("#808080");
  });

  it("parses rgb and rgba in both the legacy and modern forms", () => {
    expect(cssColorToHex("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(cssColorToHex("rgba(255, 0, 0, 0.5)")).toBe("#ff000080");
    expect(cssColorToHex("rgb(255 0 0 / 50%)")).toBe("#ff000080");
  });

  it("returns null for anything it cannot parse, rather than guessing black", () => {
    expect(cssColorToHex("")).toBeNull();
    expect(cssColorToHex("var(--background)")).toBeNull();
    expect(cssColorToHex("chartreuse")).toBeNull();
    expect(parseCssColor("#12")).toBeNull();
  });

  it("clamps out-of-gamut oklch into sRGB instead of overflowing", () => {
    const hex = cssColorToHex("oklch(0.7 0.4 140)");
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("deriveMonacoTheme", () => {
  it("derives the editor colours from the token record, not from constants", () => {
    const dark = deriveMonacoTheme("dark", tokens({ "--elev-1": "#101010" }));
    const light = deriveMonacoTheme("light", tokens({ "--elev-1": "#fafafa" }));

    expect(dark.colors["editor.background"]).toBe("#101010");
    expect(light.colors["editor.background"]).toBe("#fafafa");
  });

  it("re-derives every dependent colour when the cascade changes", () => {
    // The acceptance case: swap `data-theme`, re-read the tokens, and the
    // theme object that comes out is different. Only the token record changes.
    const before = deriveMonacoTheme("dark", tokens({ "--elev-1": "#272822" }));
    const after = deriveMonacoTheme("dark", tokens({ "--elev-1": "#282a36" }));

    expect(before.colors["editor.background"]).not.toBe(after.colors["editor.background"]);
    expect(after.colors["editor.background"]).toBe("#282a36");
    // Gutter follows the canvas, so it moves with it.
    expect(after.colors["editorGutter.background"]).toBe("#282a36");
  });

  it("keeps the stock base only as an inheritance floor, per mode", () => {
    expect(deriveMonacoTheme("dark", tokens()).base).toBe("vs-dark");
    expect(deriveMonacoTheme("light", tokens()).base).toBe("vs");
    expect(deriveMonacoTheme("dark", tokens()).inherit).toBe(true);
  });

  it("emits token rules in Monaco's no-hash format and colours with the hash", () => {
    const theme = deriveMonacoTheme("dark", tokens({ "--primary": "#58a6ff" }));
    const keyword = theme.rules.find((r) => r.token === "keyword");
    expect(keyword?.foreground).toBe("58a6ff");
    expect(theme.colors["editorCursor.foreground"]).toBe("#58a6ff");
  });

  it("drops colour ids whose token is unparseable rather than emitting black", () => {
    const theme = deriveMonacoTheme("dark", tokens({ "--warning": "notacolour" }));
    expect(theme.colors["editorWarning.foreground"]).toBeUndefined();
    expect(theme.colors["editorError.foreground"]).toBeDefined();
  });

  /// Direction D1's whole contrast argument: the editor body renders at the
  /// *island* surface, never at the recessed canvas. If `--canvas` ever became
  /// a token this module reads, the editor would look like a hole punched in
  /// the shell rather than a panel floating on it.
  it("paints the editor body from the island surface, never from the canvas", () => {
    expect(THEME_TOKEN_NAMES).toContain("--elev-1");
    expect(THEME_TOKEN_NAMES).not.toContain("--canvas");
    expect(THEME_TOKEN_NAMES).not.toContain("--elev-0");

    const theme = deriveMonacoTheme("dark", tokens({ "--elev-1": "#1b1b1f" }));
    expect(theme.colors["editor.background"]).toBe("#1b1b1f");
    expect(theme.colors["editorGutter.background"]).toBe("#1b1b1f");
    expect(theme.colors["peekViewEditor.background"]).toBe("#1b1b1f");
  });

  it("names the two themes by app mode", () => {
    expect(monacoThemeName("dark")).toBe(VOIDLINK_DARK);
    expect(monacoThemeName("light")).toBe(VOIDLINK_LIGHT);
  });
});

/// The theme pair can never invert.
///
/// The bug this locks down: `applyVoidlinkTheme` used to define BOTH names from
/// the one snapshot the cascade can hold. Under `solarized-light` that made
/// `voidlink-dark` a "dark" theme whose `editor.background` was `#fdf6e3`. It
/// only stayed invisible while the applied name always matched the tokens just
/// read, and Monaco's dynamic import breaks that: a theme switch during the
/// chunk load could apply `voidlink-dark` built from light tokens, which is the
/// "editor background drifts to the opposite theme" report.
///
/// So: the active name is derived from the live tokens, and the *other* name is
/// a colourless `base`-only definition — `vs` is light and `vs-dark` is dark by
/// construction, so whichever name a stale `setTheme` lands on, it cannot show
/// the wrong mode's body. Asserted for all ten themes, against the real CSS,
/// because `--elev-1` is `var(--background)` and each theme redefines that.
describe("the light and dark definitions can never invert", () => {
  const SRC = join(__dirname, "..", "..");
  const indexCss = readFileSync(join(SRC, "index.css"), "utf8");
  const themesCss = readFileSync(join(SRC, "themes.css"), "utf8");

  function backgroundOf(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) throw new Error(`no rule for ${selector}`);
    const open = css.indexOf("{", at);
    const body = css.slice(open + 1, css.indexOf("}", open));
    const m = body.match(/--background:\s*([^;]+);/);
    if (!m) throw new Error(`no --background in ${selector}`);
    return m[1].trim();
  }

  /// Every VoidLink theme, its mode, and the island colour the editor body takes
  /// (`--elev-1` is `var(--background)`, see index.css). Ten entries, because ten
  /// is the number of themes the app ships.
  const ALL_THEMES: { id: string; mode: "dark" | "light"; selector: string; css: string }[] = [
    { id: "dark", mode: "dark", selector: ":root", css: indexCss },
    { id: "light", mode: "light", selector: ":root.light", css: indexCss },
    ...(
      [
        ["github-dark", "dark"],
        ["github-light", "light"],
        ["monokai", "dark"],
        ["solarized-dark", "dark"],
        ["solarized-light", "light"],
        ["nord", "dark"],
        ["dracula", "dark"],
        ["one-dark", "dark"],
      ] as const
    ).map(([id, mode]) => ({
      id,
      mode,
      selector: `:root.${mode}[data-theme="${id}"]`,
      css: themesCss,
    })),
  ];

  /// Mean channel value, 0-1. Every VoidLink dark theme sits below 0.20 and
  /// every light one above 0.85, so a midpoint threshold is not a close call —
  /// it separates "dark body" from "light body" with a wide margin.
  function brightness(hex: string): number {
    const m = hex.match(/^#([0-9a-fA-F]{6})/);
    if (!m) throw new Error(`not a 6-digit hex: ${hex}`);
    const n = Number.parseInt(m[1], 16);
    return ((n >> 16) + ((n >> 8) & 0xff) + (n & 0xff)) / (3 * 255);
  }

  it("covers all ten themes", () => {
    expect(ALL_THEMES).toHaveLength(10);
  });

  it.each(ALL_THEMES)(
    "$id: the applied name carries a $mode body and the other name carries none",
    ({ mode, selector, css }) => {
      const bg = backgroundOf(css, selector);
      const defs = voidlinkThemeDefinitions(mode, tokens({ "--elev-1": bg, "--background": bg }));

      const active = defs[monacoThemeName(mode)];
      const inactive = defs[monacoThemeName(otherMode(mode))];

      // The applied theme's body is on the right side of the line.
      const lit = brightness(active.colors["editor.background"]);
      if (mode === "dark") expect(lit).toBeLessThan(0.5);
      else expect(lit).toBeGreaterThan(0.5);

      // The other name names no background at all, so it inherits its stock
      // base's — which is the correct mode by construction. This is the
      // assertion that used to fail: it carried the active theme's hex.
      expect(inactive.colors["editor.background"]).toBeUndefined();
      expect(inactive.base).toBe(otherMode(mode) === "light" ? "vs" : "vs-dark");
      expect(inactive.rules).toEqual([]);
    },
  );

  it("registers exactly the two names, whichever mode is active", () => {
    for (const mode of ["dark", "light"] as const) {
      expect(Object.keys(voidlinkThemeDefinitions(mode, tokens())).sort()).toEqual(
        [VOIDLINK_DARK, VOIDLINK_LIGHT].sort(),
      );
    }
  });
});

/// MASTER.md §11.5: stock Monaco chrome inside a VoidLink shell is the identity
/// risk for this module. A guard test rather than a code review note, because
/// `theme: "vs-dark"` is a one-word regression that reviews miss.
describe("no stock Monaco theme remains", () => {
  const SRC = join(__dirname, "..", "..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx?$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
    }
    return out;
  }

  it("has no `vs` / `vs-dark` theme string outside the derived themes' base", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      // `monacoTheme.ts` legitimately names both as `base:` — that is the
      // inheritance floor, not an applied theme.
      if (file.endsWith("monacoTheme.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (/["']vs(-dark)?["']/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
