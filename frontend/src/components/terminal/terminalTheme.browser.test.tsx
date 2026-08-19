/// The terminal palette against the *real* cascade.
///
/// `terminalTheme.test.ts` reads `index.css` and `themes.css` as text and
/// merges the blocks by specificity by hand. That catches a missing token or a
/// duplicated palette, but it cannot catch the one assumption the whole design
/// rests on: that `--term-bg: var(--elev-1)` arrives at `getComputedStyle` as a
/// *colour* rather than as the seven characters `var(--e`. Custom properties
/// substitute their variables at computed-value time, so it does — but that is
/// a fact about browsers, and this is where the browser gets to say so.
///
/// The second half is the reported bug itself, end to end: two dark themes,
/// same mode, and the grid has to come out different.
import { describe, expect, it, afterEach } from "vitest";
import { deriveXtermTheme, readTermTokens } from "./terminalTheme";

/// What `store/theme.ts`'s `applyTheme` writes, and nothing else. Going through
/// `setTheme` would drag in `localStorage` and a Tauri broadcast to assert a
/// property of the stylesheet.
function applyTheme(id: string, mode: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("light", mode === "light");
  root.classList.toggle("dark", mode === "dark");
  if (id === "dark" || id === "light") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
}

afterEach(() => applyTheme("dark", "dark"));

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

describe("the terminal palette, resolved by a real browser", () => {
  it("substitutes var(--elev-1) into --term-bg instead of handing it over raw", () => {
    applyTheme("nord", "dark");
    const tokens = readTermTokens();
    expect(tokens["--term-bg"]).not.toContain("var(");
    expect(tokens["--term-bg"]).not.toBe("");
    // And it has to survive the parser too — an unsubstituted `var()` would
    // reach `cssColorToHex` as garbage and get dropped, leaving the grid on
    // xterm's own default black under every theme.
    expect(deriveXtermTheme(tokens).background).toMatch(HEX);
  });

  it("moves the grid background when the theme's island moves", () => {
    applyTheme("dark", "dark");
    const onDark = deriveXtermTheme(readTermTokens()).background;
    applyTheme("light", "light");
    const onLight = deriveXtermTheme(readTermTokens()).background;
    expect(onLight).not.toBe(onDark);
  });

  /// The bug, exactly as reported. Both are dark, so `mode()` is identical for
  /// the two and the old code returned the same palette object for both.
  it("repaints between two themes of the same mode", () => {
    applyTheme("monokai", "dark");
    const monokai = deriveXtermTheme(readTermTokens());
    applyTheme("dracula", "dark");
    const dracula = deriveXtermTheme(readTermTokens());

    expect(dracula).not.toEqual(monokai);
    // Named rather than left to the deep-equal, so a failure says which slot:
    // Monokai's red is its pink #f92672, Dracula's is #ff5555.
    expect(monokai.red).not.toBe(dracula.red);
    expect(monokai.foreground).toBe(dracula.foreground); // both #f8f8f2 — a real shared value
    expect(monokai.blue).not.toBe(dracula.blue);
  });

  it("gives every theme a complete, parseable palette through the cascade", () => {
    const themes: [string, "dark" | "light"][] = [
      ["dark", "dark"],
      ["light", "light"],
      ["github-dark", "dark"],
      ["github-light", "light"],
      ["monokai", "dark"],
      ["solarized-dark", "dark"],
      ["solarized-light", "light"],
      ["nord", "dark"],
      ["dracula", "dark"],
      ["one-dark", "dark"],
    ];
    for (const [id, mode] of themes) {
      applyTheme(id, mode);
      const derived = deriveXtermTheme(readTermTokens()) as Record<string, string>;
      // 21 tokens in, 21 xterm keys out. Anything less is a token the cascade
      // did not resolve — the failure this file exists to make visible.
      expect(Object.keys(derived), id).toHaveLength(21);
      for (const [key, value] of Object.entries(derived)) {
        expect(value, `${id} ${key}`).toMatch(HEX);
      }
    }
  });
});
