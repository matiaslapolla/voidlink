import { createSignal } from "solid-js";
import { textPrompt } from "./prompt";

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
const [worktreeSwitcherOpen, setWorktreeSwitcherOpen] = createSignal(false);
const [tabSwitcherOpen, setTabSwitcherOpen] = createSignal(false);
const [brainOpen, setBrainOpen] = createSignal(false);

// ─── Recently-used actions ────────────────────────────────────────────────
/// Ids in most-recent-first order, capped. In memory rather than persisted: the
/// palette's job is to make *this* session's repetition cheap, and a list
/// restored from last week reorders rows the user has already learned the
/// position of.
///
/// Read as a plain array, not a signal, and snapshotted by the palette when it
/// opens — MASTER's palette rule is that recency ordering must be stable while
/// the palette is on screen, so running an action must not reshuffle the list
/// under the row you are about to press.
const RECENT_ACTION_LIMIT = 12;
let recentActionIds: string[] = [];

export function recordActionUse(id: string): void {
  recentActionIds = [id, ...recentActionIds.filter((x) => x !== id)].slice(
    0,
    RECENT_ACTION_LIMIT,
  );
}

/// A snapshot of the recency order. Callers hold onto what they get rather than
/// re-reading it.
export function recentActionOrder(): string[] {
  return [...recentActionIds];
}

/// Run an action and record it. Every palette row and every keybinding goes
/// through here so "recently used" means "recently used", not "recently used
/// from the palette".
export function runAction(action: Action): void | Promise<void> {
  recordActionUse(action.id);
  return action.run();
}

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

/// The project brain, as an overlay rather than a tab.
///
/// It was a tab kind until the 2026-07-29 audit's cut C2: a vault viewer
/// reports no state, and the tab strip is for things that do. Held here beside
/// the other palette-invoked surfaces because that is what it now is — the
/// difference from those is only that its panel is large enough to read in.
export function isBrainOpen() {
  return brainOpen();
}

export function openBrain() {
  setBrainOpen(true);
}

export function closeBrain() {
  setBrainOpen(false);
}

/// The worktree/workspace switcher: every worktree across every workspace, with
/// its dirty/ahead/behind badges.
export function isWorktreeSwitcherOpen() {
  return worktreeSwitcherOpen();
}

export function openWorktreeSwitcher() {
  setWorktreeSwitcherOpen(true);
}

export function closeWorktreeSwitcher() {
  setWorktreeSwitcherOpen(false);
}

/// "Go to open tab" — the same chrome, over what is already open.
export function isTabSwitcherOpen() {
  return tabSwitcherOpen();
}

export function openTabSwitcher() {
  setTabSwitcherOpen(true);
}

export function closeTabSwitcher() {
  setTabSwitcherOpen(false);
}

/// Deep link into one editor setting by name.
///
/// Registered here rather than in `App.tsx`'s catalog for the same reason
/// "Open commit graph" is: it needs no store closure, only an event the shell
/// picks up. The typed name becomes the settings pane's filter query, which is
/// the same fuzzy search the pane's own box runs — so "font size", "fontSize"
/// and "editor.fontSize" all land in the same place.
registerActions([
  {
    id: "settings.goto",
    label: "Go to setting…",
    description: "Open Settings filtered to one editor setting by name or dotted id",
    group: "App",
    run: async () => {
      const query = await textPrompt({
        title: "Go to setting",
        label: "Setting",
        placeholder: "editor.fontSize, word wrap, relative…",
        confirmLabel: "Go",
      });
      if (query === null) return;
      window.dispatchEvent(
        new CustomEvent("voidlink:goto-setting", { detail: query }),
      );
    },
  },
]);
