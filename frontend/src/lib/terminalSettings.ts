const TERMINAL_SETTINGS_KEY = "voidlink-terminal-settings";

export interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  lineHeight: number;
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", monospace',
  fontSize: 16,
  scrollback: 5000,
  cursorStyle: "block",
  cursorBlink: true,
  lineHeight: 1.0,
};

export function loadTerminalSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(TERMINAL_SETTINGS_KEY);
    if (raw) return { ...DEFAULT_TERMINAL_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_TERMINAL_SETTINGS };
}

export function saveTerminalSettings(settings: TerminalSettings) {
  localStorage.setItem(TERMINAL_SETTINGS_KEY, JSON.stringify(settings));
}
