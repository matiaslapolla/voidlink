import { createStore } from "solid-js/store";
import { createEffect } from "solid-js";

export type CursorStyle = "block" | "underline" | "bar";
export type UiTextSize = "sm" | "base" | "xl";
export type UiDensity = "compact" | "normal" | "comfortable";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontWeightBold: number;
  letterSpacing: number;
  ligatures: boolean;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  cursorWidth: number;
  scrollback: number;
  tabStopWidth: number;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  macOptionIsMeta: boolean;
  rightClickSelectsWord: boolean;
  wordSeparator: string;
  scrollSensitivity: number;
  scrollOnUserInput: boolean;
}

export interface UiSettings {
  textSize: UiTextSize;
  density: UiDensity;
}

export interface AppSettings {
  ui: UiSettings;
  terminal: TerminalSettings;
}

const STORAGE_KEY = "voidlink-settings";

const DEFAULTS: AppSettings = {
  ui: {
    textSize: "base",
    density: "normal",
  },
  terminal: {
    // Prefer a nerd-font stack so Starship/powerline glyphs render, with plain
    // system fallbacks if no nerd font is installed.
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrainsMono NF", "FiraCode Nerd Font", "FiraCode NF", "Cascadia Code", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    fontWeight: 400,
    fontWeightBold: 700,
    letterSpacing: 0,
    ligatures: false,
    cursorStyle: "block",
    cursorBlink: true,
    cursorWidth: 1,
    scrollback: 5000,
    tabStopWidth: 8,
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
    macOptionIsMeta: false,
    rightClickSelectsWord: false,
    wordSeparator: " ()[]{}',\"`",
    scrollSensitivity: 1,
    scrollOnUserInput: true,
  },
};

function mergeDefaults<T extends object>(defaults: T, partial: Partial<T> | undefined): T {
  if (!partial) return { ...defaults };
  return { ...defaults, ...partial };
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ui: mergeDefaults(DEFAULTS.ui, parsed.ui),
      terminal: mergeDefaults(DEFAULTS.terminal, parsed.terminal),
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

const [settings, setSettings] = createStore<AppSettings>(load());

createEffect(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
});

// ── UI effects: apply textSize + density to <html> so CSS rules can react.
const TEXT_SIZE_PX: Record<UiTextSize, number> = { sm: 14, base: 16, xl: 18 };

createEffect(() => {
  const html = document.documentElement;
  html.style.fontSize = `${TEXT_SIZE_PX[settings.ui.textSize]}px`;
  html.setAttribute("data-density", settings.ui.density);
});

export function useSettings() {
  return {
    settings,
    updateTerminal(patch: Partial<TerminalSettings>) {
      setSettings("terminal", patch);
    },
    updateUi(patch: Partial<UiSettings>) {
      setSettings("ui", patch);
    },
    reset() {
      setSettings(JSON.parse(JSON.stringify(DEFAULTS)));
    },
  };
}

export const DEFAULT_SETTINGS = DEFAULTS;
