import { createSignal } from "solid-js";

/// A user-invokable action surfaced by the Cmd+K palette and (optionally)
/// bound to a global keyboard shortcut. Actions are registered once at app
/// startup with closures over the store; they can be re-registered if the
/// workspace ID changes (the closures capture state).
export interface Action {
  id: string;
  /// Visible label in the palette.
  label: string;
  /// Optional logical group used as a section header in the palette.
  group?: string;
  /// Optional human-friendly description shown in the palette.
  description?: string;
  /// Optional accelerator hint shown next to the label. Display only — actual
  /// binding lives in `shortcut` so we can match key events without parsing
  /// formatted strings.
  shortcutLabel?: string;
  /// Predicate that returns true when this action should be selectable in
  /// the current state. Disabled actions are still shown (greyed out).
  enabled?: () => boolean;
  /// What happens when invoked.
  run: () => void | Promise<void>;
}

const [actions, setActions] = createSignal<Action[]>([]);

export function registerActions(list: Action[]): () => void {
  setActions((cur) => {
    const ids = new Set(list.map((a) => a.id));
    return [...cur.filter((a) => !ids.has(a.id)), ...list];
  });
  return () => {
    setActions((cur) => cur.filter((a) => !list.some((l) => l.id === a.id)));
  };
}

export function getActions(): Action[] {
  return actions();
}

export function getAction(id: string): Action | undefined {
  return actions().find((a) => a.id === id);
}

/// Palette open state — shared so any caller (keybinding, button) can toggle it.
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [fileFinderOpen, setFileFinderOpen] = createSignal(false);

export function isPaletteOpen() {
  return paletteOpen();
}

export function openPalette() {
  setPaletteOpen(true);
}

export function closePalette() {
  setPaletteOpen(false);
}

export function isFileFinderOpen() {
  return fileFinderOpen();
}

export function openFileFinder() {
  setFileFinderOpen(true);
}

export function closeFileFinder() {
  setFileFinderOpen(false);
}
