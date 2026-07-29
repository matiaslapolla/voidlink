import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cssColorToHex, parseCssColor } from "./cssColor";
import {
  deriveMonacoTheme,
  monacoThemeName,
  THEME_TOKEN_NAMES,
  VOIDLINK_DARK,
  VOIDLINK_LIGHT,
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
