import { createSignal } from "solid-js";
import { onThemeChange, publishThemeChange } from "@/api/windows";

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

/// Write the theme into this document and tell the other windows.
///
/// Mutating `<html>` is inherently per-document, and until the broadcast existed
/// that was the *entire* propagation mechanism: `localStorage` is shared but
/// nothing re-read it, so a satellite window (which hydrates once, at module
/// eval, and is reused rather than recreated) kept whatever theme it opened on
/// forever. This is the single mutation point, so it is also the single place
/// the change has to leave the window from.
///
/// `broadcast` is false when we are *applying* a remote change — see
/// `bridgeThemeAcrossWindows` for why re-publishing would ping-pong.
function applyTheme(id: string, broadcast = true) {
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
  if (broadcast) void publishThemeChange(id);
}

// Apply immediately on load (no flash). Deliberately does not broadcast: this
// is us catching up to the stored value, not a change anyone else has to hear,
// and a satellite booting would otherwise shout its stale hydration at the
// workbench.
const initial = loadTheme();
applyTheme(initial, false);

const [themeId, setThemeIdRaw] = createSignal<string>(initial);

function setTheme(id: string, broadcast = true) {
  if (!THEMES.some((t) => t.id === id)) return;
  // Idempotent: re-applying the theme already on screen would redefine the
  // Monaco themes and repaint every editor for nothing, and it is the second
  // line of defence against a broadcast loop.
  if (id === themeId()) return;
  setThemeIdRaw(id);
  applyTheme(id, broadcast);
}

/// Follow theme changes made in another window. Call once per window root.
///
/// Returns a disposer for symmetry with `bridgeGitRefsAcrossWindows`; in
/// practice the roots live as long as the window does.
export function bridgeThemeAcrossWindows(): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  // `broadcast: false` — the sender already told everyone. Echoing it back
  // would have this window and the sender hand the same value to each other
  // forever (the `source` guard only drops our *own* emit, not the cycle).
  void onThemeChange((id) => setTheme(id, false)).then((fn) => {
    if (disposed) void fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    if (unlisten) unlisten();
  };
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
    /** Set theme by ID. Wrapped rather than passed through so the internal
     * `broadcast` flag stays internal — a UI that suppressed it would silently
     * reintroduce the cross-window drift this channel exists to fix. */
    setTheme: (id: string) => setTheme(id),
    /** Toggle between dark/light (with smart pairing) */
    toggleTheme,
    /** All available theme definitions */
    THEMES,
  };
}
