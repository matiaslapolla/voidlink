import { createSignal } from "solid-js";
import { onThemeChange, publishThemeChange } from "@/api/windows";
import {
  DEFAULT_THEME_ID,
  getThemeDef,
  THEMES,
  themeMode,
  type ThemeDef,
  type ThemeId,
  type ThemeMode,
} from "@/store/themeTable";

/// The table, the mode type and the light/dark predicate live in
/// `store/themeTable.ts` — pure, importable from a `node` test, and the single
/// owner of "is this theme light or dark" (see that file). Re-exported here so
/// every existing `@/store/theme` import keeps working.
export { THEMES, themeMode };
export type { ThemeDef, ThemeId, ThemeMode };

const STORAGE_KEY = "voidlink-theme";

function loadTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && THEMES.some((t) => t.id === stored)) return stored;
  } catch { /* ignore */ }
  return DEFAULT_THEME_ID;
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
  const mode = themeMode(id);
  const root = document.documentElement;

  // Set mode class (light or dark) for color-scheme and existing selectors
  root.classList.toggle("light", mode === "light");
  root.classList.toggle("dark", mode === "dark");

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

  // **The cascade is written before the signal, and the order is the bug fix.**
  //
  // A Solid setter called outside `batch` runs the whole update cycle
  // synchronously, user effects included, before it returns. With
  // `setThemeIdRaw` first, every `createEffect` that watches the theme ran
  // while `<html>` still carried the *previous* theme's class and
  // `data-theme` — so `MonacoPanes`' and `SettingsJsonPane`'s theme sync
  // called `applyVoidlinkTheme(monaco, <new mode>)`, whose `readCssTokens()`
  // then snapshotted the *old* palette and registered it under the new mode's
  // name. Switching a dark theme to a light one left `voidlink-light` holding
  // a dark body, and nothing re-ran to correct it: that is "the editor theme
  // inverts against the UI", and it persisted until the next theme change.
  //
  // `monacoTheme.ts` already made the *inactive* name colourless so a stale
  // apply cannot invert; this closes the other half, where the name and the
  // tokens genuinely disagree at the moment of reading.
  applyTheme(id, broadcast);
  setThemeIdRaw(id);
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
    /** Current mode: "dark" or "light" — via `themeMode`, the one owner. */
    mode: () => themeMode(themeId()),
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
