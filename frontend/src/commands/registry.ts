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
  /// Keep this action out of the palette list while still registering it, so
  /// the keymap can bind it. Used for the nine "go to workspace N" actions,
  /// which are useful as chords but pure noise as palette rows.
  hidden?: boolean;
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

/// Every action the palette should list. Hidden entries stay registered — the
/// keymap still resolves them — they just don't earn a row.
export function getVisibleActions(): Action[] {
  return actions().filter((a) => !a.hidden);
}

/// Palette open state — shared so any caller (keybinding, button) can toggle it.
const [paletteOpen, setPaletteOpen] = createSignal(false);
const [fileFinderOpen, setFileFinderOpen] = createSignal(false);
const [cheatSheetOpen, setCheatSheetOpen] = createSignal(false);

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

// ─── Built-in commands ────────────────────────────────────────────────────
// "Open commit graph" lives here (not in App.tsx's store-scoped catalog)
// because it needs no store closure — it broadcasts an event that
// MainSurface picks up to open the graph tab for the active workspace,
// keeping the palette entry decoupled from the layout store. Registered at
// module load; App.tsx's own catalog re-registers independently by id.
registerActions([
  {
    id: "git.commit-graph",
    label: "Open commit graph",
    description: "Visualize the commit history DAG with lanes and ref decorations",
    group: "Git",
    run: () => {
      window.dispatchEvent(new CustomEvent("voidlink:open-commit-graph"));
    },
  },
]);

export function openFileFinder() {
  setFileFinderOpen(true);
}

export function closeFileFinder() {
  setFileFinderOpen(false);
}

export function isCheatSheetOpen() {
  return cheatSheetOpen();
}

export function openCheatSheet() {
  setCheatSheetOpen(true);
}

export function closeCheatSheet() {
  setCheatSheetOpen(false);
}
