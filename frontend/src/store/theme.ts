import { createSignal } from "solid-js";

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

const STORAGE_KEY = "voidlink-theme";

function loadTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((t) => t.id === stored)) return stored;
  } catch { /* ignore */ }
  return "dark";
}

function getThemeDef(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

function applyTheme(id: string) {
  const def = getThemeDef(id);
  const root = document.documentElement;

  // Set mode class (light or dark) for color-scheme and existing selectors
  root.classList.toggle("light", def.mode === "light");
  root.classList.toggle("dark", def.mode === "dark");

  // Set data-theme attribute for theme-specific CSS overrides
  // The default dark/light themes use no data-theme (they rely on :root / :root.light)
  if (id === "dark" || id === "light") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", id);
  }

  localStorage.setItem(STORAGE_KEY, id);
}

// Apply immediately on load (no flash)
const initial = loadTheme();
applyTheme(initial);

const [themeId, setThemeIdRaw] = createSignal<string>(initial);

function setTheme(id: string) {
  if (!THEMES.some((t) => t.id === id)) return;
  setThemeIdRaw(id);
  applyTheme(id);
}

/**
 * Toggle between light and dark:
 * - If current theme has a same-named counterpart in the opposite mode, switch to it
 *   (e.g. solarized-dark <-> solarized-light, github-dark <-> github-light)
 * - Otherwise, switch to the default theme of the opposite mode
 */
function toggleTheme() {
  const current = getThemeDef(themeId());
  const oppositeMode: ThemeMode = current.mode === "dark" ? "light" : "dark";

  // Try to find a paired theme (e.g. github-dark -> github-light)
  const baseName = current.id.replace(/-dark$|-light$/, "");
  const paired = THEMES.find(
    (t) => t.mode === oppositeMode && t.id === `${baseName}-${oppositeMode}`
  );
  if (paired) {
    setTheme(paired.id);
    return;
  }

  // For "dark" <-> "light" default themes
  if (current.id === "dark" || current.id === "light") {
    setTheme(oppositeMode);
    return;
  }

  // Fallback: switch to default of opposite mode
  setTheme(oppositeMode);
}

export function useTheme() {
  return {
    /** Current theme ID (e.g. "github-dark", "monokai") */
    theme: themeId,
    /** Current mode: "dark" or "light" */
    mode: () => getThemeDef(themeId()).mode,
    /** Set theme by ID */
    setTheme,
    /** Toggle between dark/light (with smart pairing) */
    toggleTheme,
    /** All available theme definitions */
    THEMES,
  };
}
