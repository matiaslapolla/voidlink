import { createEffect, createSignal, onCleanup } from "solid-js";
import { textPrompt } from "./prompt";
import { createOverlay } from "./overlay";
import { COMMAND_PREFIX, type PaletteMode } from "./paletteMode";

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

// ─── Action sources ───────────────────────────────────────────────────────
/// This is the fix for PALETTE-SRC1: before it, the whole action catalog was
/// one array assembled inside `App.tsx`, which had to import from — and
/// therefore know about — every feature that wanted a palette entry: git,
/// stack, worktrees, snapshots, layout presets, the agent panel. A feature
/// couldn't contribute a row without `App.tsx` growing another import and
/// another few dozen lines in that one array, the same "one file has to know
/// the whole list" shape `TAB_SPECS` (`store/layout/tabs.ts`) and
/// `createOverlay` (`commands/overlay.ts`) already fixed for tab kinds and
/// modal surfaces.
///
/// A *source* is a feature's own reactive slice of the catalog: a function
/// that returns the `Action[]` it currently wants registered, closing over
/// whatever store state it needs. `registerActionSource` is the one thing a
/// feature module calls — declaring its actions and registering them is the
/// same act, so there is no second step (App.tsx wiring an effect) to forget.
///
/// `priority` makes this source's position in the composed catalog explicit
/// rather than incidental. The palette's resting list (no query, action not
/// recently used) falls back to registration order — see
/// `CommandPalette.tsx`'s `rank` — so *some* order has to be picked, and
/// leaving it to "whichever source's effect happened to fire most recently"
/// would let two features that update at different rates drift apart in the
/// list a user has already learned the shape of. Lower runs first; ties break
/// by registration order.
export type ActionSourceFn = () => Action[];

interface ActionSourceEntry {
  priority: number;
  seq: number;
  get: ActionSourceFn;
}

const [actionSources, setActionSources] = createSignal<ActionSourceEntry[]>([]);
let actionSourceSeq = 0;

/// Contribute a reactive slice of the palette catalog. Call once, at the
/// point the feature owns the state its actions close over (typically once
/// per component instance, the same place `useKeybindings` or
/// `useModifierRelease` are called) — not inside an effect of your own; the
/// composed catalog (`useActionSourceCatalog`, below) is the single effect
/// that tracks every source's reads and rebuilds the whole list as one unit.
///
/// Returns an unregister function. Most callers never need it — the app has
/// one instance of each source for its lifetime — but it exists so a source
/// can be torn down (and so tests can register and clean up without leaking
/// state into the next one).
export function registerActionSource(priority: number, get: ActionSourceFn): () => void {
  const entry: ActionSourceEntry = { priority, seq: actionSourceSeq++, get };
  setActionSources((cur) => [...cur, entry]);
  return () => setActionSources((cur) => cur.filter((e) => e !== entry));
}

/// The form every feature registration function (`registerGitActions`,
/// `registerWorkspaceActions`, …) actually calls: `registerActionSource`,
/// with its unregister function handed straight to `onCleanup`. Without this,
/// a source outlives the component that declared it — harmless for `AppInner`
/// today (it mounts once, for the app's lifetime), but a trap for the next
/// context this runs in: a satellite window that *does* unmount its sources,
/// or a test that mounts the same feature twice and finds its second
/// registration's ids duplicated by a first one nothing ever tore down.
export function useActionSource(priority: number, get: ActionSourceFn): void {
  onCleanup(registerActionSource(priority, get));
}

/// Every source's actions, concatenated in priority order. A plain function,
/// not a memo: it is only ever called from inside the tracked scope of
/// `useActionSourceCatalog`'s effect, and calling `entry.get()` there is what
/// makes that effect depend on whatever signals each source's closure reads —
/// exactly as if all of it were still one hand-written array in one effect.
function composeActionSources(): Action[] {
  return [...actionSources()]
    .sort((a, b) => a.priority - b.priority || a.seq - b.seq)
    .flatMap((entry) => entry.get());
}

/// Wires the composed catalog into the registry. Call exactly once, from
/// reactive scope that lives for the app's lifetime (`AppInner` in
/// `App.tsx`) — after every feature has had the chance to call
/// `registerActionSource`, though even that ordering is not load-bearing:
/// a source registered after this runs still takes effect on the next
/// dependency change, because `actionSources` is itself a signal this
/// effect reads.
export function useActionSourceCatalog(): void {
  createEffect(() => {
    const dispose = registerActions(composeActionSources());
    onCleanup(dispose);
  });
}

/// Palette open state — shared so any caller (keybinding, button) can toggle
/// it. `createOverlay` rather than a bare `createSignal`: each of these is a
/// modal surface the embedded browser has to hide behind (see
/// `commands/overlay.ts`), and this way that is true by construction instead
/// of by an `App.tsx` effect someone had to remember to add. The cheat sheet
/// was never wired into that effect list before this change — an
/// unregistered overlay that nobody had hit yet, and exactly the failure mode
/// BR-O1 describes.
const paletteOverlay = createOverlay("palette");
const cheatSheetOverlay = createOverlay("cheat-sheet");
const worktreeSwitcherOverlay = createOverlay("worktree-switcher");
const tabSwitcherOverlay = createOverlay("tab-switcher");
/// The project brain, same mechanism. Its overlay component used to register
/// itself on mount and unregister on cleanup; owning the state here means the
/// registration cannot disagree with whether the surface is actually open.
const brainOverlay = createOverlay("brain");
/// The project board. Beside the brain rather than on the tab strip, for the
/// reason `BoardOverlay.tsx`'s header sets out.
const boardOverlay = createOverlay("board");

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
  return paletteOverlay.isOpen();
}

/// The query the palette starts with, set by whoever opened it.
///
/// This is how one overlay serves two chords. ⌘P wants files, which is the
/// empty query; ⌘K wants commands, which is the same picker with a `>` already
/// typed. Seeding the *query* rather than carrying a mode flag beside it means
/// the two entry points differ by one character and nothing else — and the
/// user's first backspace lands them in the other mode, which is the whole
/// point of the `>` convention.
const [paletteSeed, setPaletteSeed] = createSignal("");

export function openPalette(mode: PaletteMode = "files") {
  setPaletteSeed(mode === "commands" ? COMMAND_PREFIX : "");
  paletteOverlay.open();
}

/// Read once, when the palette's content mounts. Not reactive after that: the
/// seed is where the user *started*, and the input owns the query from the
/// first keystroke on.
export function paletteSeedQuery(): string {
  return paletteSeed();
}

export function closePalette() {
  paletteOverlay.close();
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

export function isCheatSheetOpen() {
  return cheatSheetOverlay.isOpen();
}

export function openCheatSheet() {
  cheatSheetOverlay.open();
}

export function closeCheatSheet() {
  cheatSheetOverlay.close();
}

/// The project brain, as an overlay rather than a tab.
///
/// It was a tab kind until the 2026-07-29 audit's cut C2: a vault viewer
/// reports no state, and the tab strip is for things that do. Held here beside
/// the other palette-invoked surfaces because that is what it now is — the
/// difference from those is only that its panel is large enough to read in.
export function isBrainOpen() {
  return brainOverlay.isOpen();
}

export function openBrain() {
  brainOverlay.open();
}

export function closeBrain() {
  brainOverlay.close();
}

/// The project board — cards as markdown files under `.voidlink/board/`, the
/// same storage bargain the brain makes. See `BoardOverlay.tsx` for why it is
/// an overlay rather than a tab kind.
export function isBoardOpen() {
  return boardOverlay.isOpen();
}

export function openBoard() {
  boardOverlay.open();
}

export function closeBoard() {
  boardOverlay.close();
}

/// The worktree/workspace switcher: every worktree across every workspace, with
/// its dirty/ahead/behind badges.
export function isWorktreeSwitcherOpen() {
  return worktreeSwitcherOverlay.isOpen();
}

export function openWorktreeSwitcher() {
  worktreeSwitcherOverlay.open();
}

export function closeWorktreeSwitcher() {
  worktreeSwitcherOverlay.close();
}

/// "Go to open tab" — the same chrome, over what is already open.
export function isTabSwitcherOpen() {
  return tabSwitcherOverlay.isOpen();
}

export function openTabSwitcher() {
  tabSwitcherOverlay.open();
}

export function closeTabSwitcher() {
  tabSwitcherOverlay.close();
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
