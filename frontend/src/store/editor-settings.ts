import { createSignal } from "solid-js";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

const STORAGE_KEY = "voidlink-editor-settings";

const DEFAULTS: EditorSettings = {
  fontFamily: '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", monospace',
  fontSize: 12,
  lineHeight: 1.6,
};

function load(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

const [editorSettings, setEditorSettings] = createSignal<EditorSettings>(load());

export function useEditorSettings() {
  return editorSettings;
}

export function updateEditorSettings(partial: Partial<EditorSettings>) {
  const next = { ...editorSettings(), ...partial };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  setEditorSettings(next);
}
