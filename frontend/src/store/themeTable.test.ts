/// The theme table's two invariants, both of which used to be comments.
///
/// 1. `frontend/index.html`'s pre-paint `LIGHT_THEMES` array equals the
///    `mode: "light"` entries of the table. That script runs before any module
///    and therefore cannot import them, so the list is duplicated — and a
///    duplicate with nothing checking it is a duplicate that drifts. When it
///    drifts, a light theme boots with `.dark` on `<html>` and the whole first
///    frame is inverted, which is only visible for the split second before
///    Solid corrects it and is therefore never noticed in review.
/// 2. Every theme resolves to the Monaco theme matching its own mode. The three
///    light themes are the ones that break an `id === "light"` check.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_THEME_ID,
  getThemeDef,
  LIGHT_THEME_IDS,
  THEMES,
  themeMode,
} from "./themeTable";

const INDEX_HTML = join(__dirname, "..", "..", "index.html");

/// The `LIGHT_THEMES` array as the pre-paint script actually declares it. A
/// regex rather than an import because the whole point of that script is that
/// it is not a module; reading the shipped text is the only way to assert
/// against what the browser will run.
function prePaintLightThemes(): string[] {
  const html = readFileSync(INDEX_HTML, "utf8");
  const m = /var LIGHT_THEMES = \[([^\]]*)\];/.exec(html);
  if (!m) throw new Error("no `var LIGHT_THEMES = [...]` in index.html");
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

describe("the theme table", () => {
  it("ships ten themes", () => {
    expect(THEMES).toHaveLength(10);
  });

  it("has a default that is in the table", () => {
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
    expect(getThemeDef(DEFAULT_THEME_ID).id).toBe(DEFAULT_THEME_ID);
  });

  it("falls back to the first entry for an id it does not know", () => {
    // A `localStorage` value from an older build, or a broadcast from a window
    // running different code. Never `undefined`, so no caller needs a guard.
    expect(getThemeDef("a-theme-that-was-removed").id).toBe(THEMES[0].id);
    expect(themeMode("a-theme-that-was-removed")).toBe(THEMES[0].mode);
  });

  it("names three light themes, only one of which is the string 'light'", () => {
    expect(LIGHT_THEME_IDS).toEqual(["light", "github-light", "solarized-light"]);
    expect(LIGHT_THEME_IDS.filter((id) => id === "light")).toHaveLength(1);
  });
});

describe("index.html's pre-paint LIGHT_THEMES", () => {
  it("equals the table's light entries, in the same order", () => {
    expect(prePaintLightThemes()).toEqual(LIGHT_THEME_IDS);
  });

  it("agrees with `themeMode` for every one of the ten themes", () => {
    // The stronger form of the same assertion: run the pre-paint script's own
    // decision — `indexOf(t) === -1 ? "dark" : "light"` — against every id and
    // check it against the one function that owns the answer.
    const list = prePaintLightThemes();
    for (const theme of THEMES) {
      const prePaint = list.indexOf(theme.id) === -1 ? "dark" : "light";
      expect(prePaint, `pre-paint mode for ${theme.id}`).toBe(themeMode(theme.id));
    }
  });
});
