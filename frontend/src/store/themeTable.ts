/// The theme table, and the one function that answers "is this theme light or
/// dark".
///
/// Split out of `store/theme.ts` because that module is a *store*: it reads
/// `localStorage` and mutates `document.documentElement` at module eval, so it
/// cannot be imported by a `node` unit test. This half is pure data plus one
/// predicate, which is exactly the half the light/dark question lives in.
///
/// Three places used to decide light-vs-dark independently: the `mode` field
/// here, `useTheme().mode`, and `frontend/index.html`'s pre-paint `LIGHT_THEMES`
/// array — which cannot import anything, because it runs before any module.
/// That array is now checked against `LIGHT_THEME_IDS` by `themeTable.test.ts`
/// rather than by a comment asking the next person to remember, and everything
/// on the module side goes through `themeMode()`.
///
/// `store/theme.ts` re-exports `ThemeMode`, `ThemeDef` and `THEMES`, so nothing
/// that already imports from there needs to change.

export type ThemeMode = "dark" | "light";

export interface ThemeDef {
  id: string;
  label: string;
  mode: ThemeMode;
  /** Preview colors: [bg, fg, primary, border] as CSS color strings */
  preview: [string, string, string, string];
}

export const THEMES: ThemeDef[] = [
  {
    id: "dark",
    label: "Default Dark",
    mode: "dark",
    preview: ["oklch(0.145 0.012 270)", "oklch(0.950 0.008 270)", "oklch(0.655 0.200 270)", "oklch(1 0.008 270 / 12%)"],
  },
  {
    id: "light",
    label: "Default Light",
    mode: "light",
    preview: ["oklch(0.980 0.006 270)", "oklch(0.145 0.012 270)", "oklch(0.530 0.220 270)", "oklch(0 0.006 270 / 12%)"],
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    mode: "dark",
    preview: ["#0d1117", "#e6edf3", "#58a6ff", "#30363d"],
  },
  {
    id: "github-light",
    label: "GitHub Light",
    mode: "light",
    preview: ["#ffffff", "#1f2328", "#0969da", "#d1d9e0"],
  },
  {
    id: "monokai",
    label: "Monokai",
    mode: "dark",
    preview: ["#272822", "#f8f8f2", "#a6e22e", "#3e3d32"],
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    mode: "dark",
    preview: ["#002b36", "#839496", "#268bd2", "#073642"],
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    mode: "light",
    preview: ["#fdf6e3", "#657b83", "#268bd2", "#eee8d5"],
  },
  {
    id: "nord",
    label: "Nord",
    mode: "dark",
    preview: ["#2e3440", "#eceff4", "#88c0d0", "#3b4252"],
  },
  {
    id: "dracula",
    label: "Dracula",
    mode: "dark",
    preview: ["#282a36", "#f8f8f2", "#bd93f9", "#44475a"],
  },
  {
    id: "one-dark",
    label: "One Dark",
    mode: "dark",
    preview: ["#282c34", "#abb2bf", "#61afef", "#3e4452"],
  },
];

export type ThemeId = (typeof THEMES)[number]["id"];

/// The default theme, and the fallback for an id nothing in `THEMES` matches —
/// a `localStorage` value from an older build, or a broadcast from a window
/// running different code.
export const DEFAULT_THEME_ID = "dark";

export function getThemeDef(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/// **The** light-vs-dark answer. Every caller that needs to know which mode a
/// theme is — the `<html>` class, `useTheme().mode`, the Monaco theme name —
/// goes through this, so there is one place for the answer to be wrong in.
export function themeMode(id: string): ThemeMode {
  return getThemeDef(id).mode;
}

/// The light themes, in table order. Only three of the ten, and only one of
/// them is the string "light" — `github-light` and `solarized-light` are the
/// two that a `id === "light"` check silently gets backwards.
///
/// Exported for `frontend/index.html`'s pre-paint script, which duplicates this
/// list because it runs before any module can be imported, and for the test
/// that holds the two in step.
export const LIGHT_THEME_IDS: string[] = THEMES.filter((t) => t.mode === "light").map((t) => t.id);
