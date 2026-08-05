/// The keymap: one declarative table that is the single source of truth for
/// every global shortcut in voidlink.
///
/// Three surfaces read this table and nothing else:
///   - `keybindings.ts` turns it into the capture-phase keydown handler,
///   - the command palette derives each action's accelerator label from it,
///   - the shortcuts cheat sheet and the settings Keyboard pane render it.
///
/// Because the label is *derived*, an accelerator shown in the UI cannot drift
/// from the chord that actually fires — the old hand-typed `shortcutLabel`
/// strings could, and did.
///
/// The shape is intentionally serialisable (ids + plain chord objects, no
/// closures) so a user-editable JSON keymap can be layered on later without
/// restructuring anything. Building that editor is out of scope here.

import type { Chord } from "@/commands/keys";
import { chordId } from "@/commands/keys";
import {
  ACTION_IDS,
  TAB_SELECT_COUNT,
  tabSelectId,
  workspaceSelectId,
  type ActionId,
} from "@/commands/actionIds";

/// Where a chord is live.
///
/// The keydown listener runs in the capture phase and swallows what it
/// matches, so a global binding wins over Monaco *and* over the shell running
/// in an xterm pane. Anything that would take a key those surfaces need gets
/// scoped down instead of dropped.
///   - `global`                — always fires (the default).
///   - `outside-terminal`      — stands down while a terminal pane has focus.
///   - `outside-text-surfaces` — stands down in a terminal *or* the editor.
export type BindingScope = "global" | "outside-terminal" | "outside-text-surfaces";

export interface Binding extends Chord {
  scope?: BindingScope;
}

export type KeymapGroup =
  | "App"
  | "File"
  | "Editor"
  | "View"
  | "Tabs"
  | "Workspace"
  | "Terminal"
  | "Git"
  | "Stack"
  | "AI";

/// Display order for grouped surfaces (cheat sheet, settings).
export const KEYMAP_GROUPS: readonly KeymapGroup[] = [
  "App",
  "File",
  "Editor",
  "View",
  "Tabs",
  "Workspace",
  "Terminal",
  "Git",
  "Stack",
  "AI",
];

export interface KeymapEntry {
  /// Which registered action this fires. One entry per action — a second
  /// chord for the same action goes in `alternates`, not in a second entry.
  actionId: ActionId;
  group: KeymapGroup;
  /// The chord rendered as this action's accelerator everywhere in the UI.
  binding: Binding;
  /// Extra chords that run the same action. Never rendered as the primary
  /// label; the cheat sheet lists them beside it when they read differently.
  alternates?: Binding[];
  /// Why this chord, when the answer isn't obvious. Surfaced nowhere — it's
  /// for whoever next has to decide whether they're allowed to change it.
  note?: string;
  /// Which window registers the action this chord fires. Omitted means the
  /// workbench. The chord is still installed everywhere — every window builds
  /// its bindings from the same table — but the dev-time "is this action really
  /// registered?" audit only holds a window responsible for its own entries.
  window?: KeymapWindow;
}

/// The window roles a keymap entry can belong to. Mirrors the Tauri window
/// labels in `src-tauri/src/window.rs`; the git window registers no actions of
/// its own, so it does not appear here.
export type KeymapWindow = "main" | "editor";

/// Chords whose `event.key` is the *shifted* character on a US layout are
/// declared with that shifted value (`?` for Shift+/, `~` for Shift+backquote)
/// because that is what the browser reports. `formatChord` maps them back to
/// the physical key so the label reads `⌘⇧/`, not `⌘⇧?`. The unshifted spelling
/// is kept as an alternate for layouts that report it the other way.
export const KEYMAP: readonly KeymapEntry[] = [
  // ── App ───────────────────────────────────────────────────────────────
  { actionId: "palette.open", group: "App", binding: { meta: true, key: "k" } },
  {
    actionId: "help.shortcuts",
    group: "App",
    binding: { meta: true, shift: true, key: "?" },
    alternates: [
      { meta: true, shift: true, key: "/" },
      { meta: true, key: "/", scope: "outside-text-surfaces" },
    ],
    note: "Bare ⌘/ is scoped away from the editor and terminal — it is Monaco's toggle-line-comment.",
  },
  {
    actionId: "app.settings",
    group: "App",
    binding: { meta: true, key: "," },
    note: "Universal settings convention; Ctrl+, is not a readline or Monaco binding.",
  },

  // ── File ──────────────────────────────────────────────────────────────
  { actionId: "file.open", group: "File", binding: { meta: true, key: "p" } },
  {
    actionId: "file.new",
    group: "File",
    window: "editor",
    binding: { meta: true, alt: true, key: "n" },
    note: "Not ⌘N: that is the workbench's new-workspace chord, and validateKeymapShape forbids a second claim on it regardless of which window each entry belongs to.",
  },
  {
    actionId: "file.save",
    group: "File",
    window: "editor",
    binding: { meta: true, key: "s", scope: "outside-terminal" },
    note: "Ctrl+S is XOFF in a shell — scoped so the terminal keeps flow control.",
  },

  // ── Editor ────────────────────────────────────────────────────────────
  // The rest of the editing commands (duplicate/move line, toggle comment,
  // multi-cursor) are reachable through ⌘K and Monaco's own chords, which
  // already match every other editor the user has. Binding them globally here
  // would shadow those with identical behaviour and take the chord away from
  // the terminal for nothing.
  {
    actionId: "editor.format-document",
    group: "Editor",
    window: "editor",
    binding: { meta: true, shift: true, key: "i", scope: "outside-terminal" },
    note: "⌥⇧F is VS Code's, but Option remaps the character on macOS so the chord never matches. ⌘⇧I is the Windows/Linux binding and survives both layouts.",
  },
  {
    actionId: "editor.find-in-files",
    group: "Editor",
    window: "editor",
    binding: { meta: true, alt: true, key: "f", scope: "outside-terminal" },
    note: "⌘⇧F is the convention but git.fetch already owns it, and moving a chord users have is worse than picking the adjacent one. ⌘⌥ keeps the character unremapped on macOS, same as ⌘⌥B for blame.",
  },
  {
    actionId: "editor.go-to-symbol",
    group: "Editor",
    window: "editor",
    binding: { meta: true, shift: true, key: "o", scope: "outside-terminal" },
    note: "VS Code's own chord, and unclaimed here. Scoped out of the terminal, where ⌘⇧O is nothing but ought to stay nothing.",
  },
  {
    actionId: "editor.split-right",
    group: "Editor",
    window: "editor",
    binding: { meta: true, alt: true, key: "\\", scope: "outside-terminal" },
    note: "VS Code's split is bare ⌘\\, but ui.swap-sidebars has owned that since before the editor had groups and moving a chord users already have is worse than taking the adjacent one. Split-down, close-group and focus-next-group stay palette-only: they are far rarer than split-right, and every remaining ⌘⌥ punctuation chord is remapped by at least one macOS keyboard layout.",
  },

  // ── View ──────────────────────────────────────────────────────────────
  { actionId: "ui.toggle-left-sidebar", group: "View", binding: { meta: true, key: "b" } },
  { actionId: "ui.toggle-git-sidebar", group: "View", binding: { meta: true, key: "j" } },
  { actionId: "ui.swap-sidebars", group: "View", binding: { meta: true, key: "\\" } },
  {
    actionId: "view.toggle-blame",
    group: "View",
    window: "editor",
    binding: { meta: true, alt: true, key: "b" },
  },
  {
    actionId: "ui.toggle-diff-mode",
    group: "View",
    binding: { meta: true, shift: true, key: "d" },
    note: "D for diff layout. ⌘⌥D would be swallowed by macOS (Dock hiding).",
  },
  {
    actionId: "ui.maximize-pane",
    group: "View",
    binding: { meta: true, alt: true, key: "m" },
    note: "M for maximize. ⌘M is minimise-window on macOS and never reaches us; the ⌥ slot is free.",
  },
  {
    actionId: "ui.split-pane-right",
    group: "View",
    binding: { meta: true, alt: true, key: "s" },
    note: "S for split. The arrows would read better and are not available: ⌘⌥← / → are ui.navigate-back / forward and have been since before panes existed, and ⌘\\ (VS Code's split) is ui.swap-sidebars with ⌘⌥\\ taken by the editor window's own split-right.",
  },
  {
    actionId: "ui.split-pane-down",
    group: "View",
    binding: { meta: true, alt: true, key: "d" },
    note: "D for down, beside ui.split-pane-right in the ⌥ block. ⌘⇧D is the diff-layout toggle; this is the free slot next to it.",
  },
  {
    actionId: "ui.close-pane",
    group: "View",
    binding: { meta: true, alt: true, key: "w" },
    note: "⌘W closes a tab, so the pane that *holds* tabs takes the ⌥ slot beside it — the same relationship the two actions have on screen.",
  },
  {
    actionId: "ui.toggle-tab-group",
    group: "View",
    binding: { meta: true, alt: true, key: "g" },
    note: "G for group, in the same ⌥ block as the four pane actions — a tab group is a collapse inside a pane, so it belongs beside them rather than near the tab chords. ⌘G is find-next in Monaco and never reaches the workbench; ⌘⇧G is its reverse.",
  },
  {
    actionId: "ui.zen",
    group: "View",
    binding: { meta: true, alt: true, key: "z" },
    note: "Zen has no chord sequences to lean on (`keys.ts` models single chords), and ⌘⇧Z is Monaco's redo — so the ⌥ slot again. The status bar renders whatever this entry says, so the two cannot drift.",
  },

  {
    actionId: "ui.navigate-back",
    group: "View",
    binding: { meta: true, alt: true, key: "ArrowLeft" },
    alternates: [
      { meta: true, alt: true, key: "[" },
      { meta: true, shift: true, key: "[" },
    ],
    note: "⌘⌥← is the browser back chord, and back/forward is what those arrows mean everywhere else. They were held by `tab.prev`/`tab.next` until MRU cycling made document-order stepping redundant; the bracket pairs stay as alternates because both spellings are muscle memory for somebody. The title bar carries the same two as buttons for anyone who would rather not remember it.",
  },
  {
    actionId: "ui.navigate-forward",
    group: "View",
    binding: { meta: true, alt: true, key: "ArrowRight" },
    alternates: [
      { meta: true, alt: true, key: "]" },
      { meta: true, shift: true, key: "]" },
    ],
  },

  // ── Tabs ──────────────────────────────────────────────────────────────
  {
    actionId: "tab.close",
    group: "Tabs",
    binding: { meta: true, key: "w" },
    note: "Only reaches us because the native menu's Close Window item was rebuilt without an accelerator — see `macos_menu` in src-tauri/src/menu.rs.",
  },
  { actionId: "tab.reopen-last", group: "Tabs", binding: { meta: true, shift: true, key: "t" } },

  // `tab.next` and `tab.prev` are deliberately **palette-only**. They used to
  // claim ⌘⌥←/→ plus the ⌘⇧[ / ⌘⇧] alternates, which made four separate models
  // for moving between tabs: document-order stepping, MRU cycling, jump-to-N,
  // and back/forward. MRU (`tab.mru-*`) covers "the one I was just in",
  // jump-to-N covers "that one, by position", and `ui.navigate-*` covers "where
  // I came from" — document-order stepping is the one nobody reaches for once
  // MRU exists, and it was holding two chord pairs to do it.
  //
  // The actions stay registered and stay in the palette, so nothing became
  // unreachable. `primaryChordFor` returning `undefined` is a supported state
  // and renders as a palette entry with no accelerator.
  //
  // What the freed chords bought: ⌘⌥←/→ went to `ui.navigate-back/forward`,
  // which is the motion those arrows actually describe, and the bracket pair
  // ⌘⇧[ / ⌘⇧] came back as its VS Code-shaped alternate.
  {
    actionId: "tab.mru-next",
    group: "Tabs",
    binding: { meta: true, key: "Tab" },
    note: "Ctrl+Tab. `meta` is Cmd-or-Ctrl, and on macOS ⌘Tab never reaches an app — the OS app switcher takes it — so this is Ctrl+Tab there and Ctrl+Tab on Linux/Windows too. Held-modifier UI: the overlay commits when the modifier is released, which `keybindings.ts` watches for.",
  },
  {
    actionId: "tab.mru-prev",
    group: "Tabs",
    binding: { meta: true, shift: true, key: "Tab" },
  },
  {
    actionId: "tab.switch",
    group: "Tabs",
    binding: { meta: true, shift: true, key: "e" },
    note: "Go to an open tab by name. E for 'everything open'; ⌘E is Monaco's find-selection and is left alone.",
  },
  // ⌘⌥1-⌘⌥9 jump to a tab in the focused group; ⌘1-⌘9 are already the nine
  // workspace slots. ⌥ alone remaps `event.key` on macOS (⌥1 reports "¡"), but
  // ⌘⌥ does not — which is why the digit chords here carry both modifiers.
  ...Array.from({ length: TAB_SELECT_COUNT }, (_, i): KeymapEntry => ({
    actionId: tabSelectId(i + 1) as ActionId,
    group: "Tabs",
    binding: { meta: true, alt: true, key: String(i + 1) },
  })),
  {
    actionId: "tab.select.last",
    group: "Tabs",
    binding: { meta: true, alt: true, key: "0" },
    note: "0 sits past 9 on the digit row, which is where 'the last one' belongs.",
  },

  // ── Workspace ─────────────────────────────────────────────────────────
  {
    actionId: "workspace.new",
    group: "Workspace",
    binding: { meta: true, key: "n" },
    note: "cmux parity: ⌘N makes a workspace, ⌘T makes a terminal. ⌘⇧N stays the stack's new branch.",
  },
  {
    actionId: "workspace.next",
    group: "Workspace",
    binding: { meta: true, shift: true, key: "ArrowRight" },
  },
  {
    actionId: "workspace.prev",
    group: "Workspace",
    binding: { meta: true, shift: true, key: "ArrowLeft" },
  },
  ...Array.from({ length: 9 }, (_, i): KeymapEntry => ({
    actionId: workspaceSelectId(i + 1) as ActionId,
    group: "Workspace",
    binding: { meta: true, key: String(i + 1) },
  })),
  {
    actionId: "workspace.switch",
    group: "Workspace",
    binding: { meta: true, shift: true, key: "p" },
    note: "Every worktree across every workspace, with its dirty/ahead/behind badges. ⌘⇧P is the switcher chord people arrive with; the command palette here is ⌘K, so it is free.",
  },

  // ── Terminal ──────────────────────────────────────────────────────────
  {
    actionId: "terminal.new",
    group: "Terminal",
    binding: { meta: true, key: "t" },
    alternates: [
      { meta: true, shift: true, key: "~" },
      { meta: true, shift: true, key: "`" },
    ],
    note: "cmux parity: ⌘T is the terminal. ⌘⇧` stays as the VS Code chord for anyone who came from there.",
  },
  { actionId: "terminal.repeat-last", group: "Terminal", binding: { meta: true, shift: true, key: "r" } },

  // ── Git ───────────────────────────────────────────────────────────────
  {
    actionId: "git.refresh",
    group: "Git",
    binding: { meta: true, alt: true, key: "r" },
    note: "⌘⇧R is already the terminal repeat, so refresh takes the ⌥ slot.",
  },
  { actionId: "git.fetch", group: "Git", binding: { meta: true, shift: true, key: "f" } },
  {
    actionId: "git.pull",
    group: "Git",
    binding: { meta: true, shift: true, key: "u" },
    note: "U for 'update from upstream'; P belongs to the file finder family.",
  },
  {
    actionId: "git.commit-graph",
    group: "Git",
    binding: { meta: true, shift: true, key: "h" },
    note: "H for history.",
  },
  {
    actionId: "git.compare",
    group: "Git",
    binding: { meta: true, shift: true, key: "c", scope: "outside-terminal" },
    note: "Ctrl+Shift+C is copy in most Linux terminals — scoped so it still is.",
  },
  { actionId: "git.ai-draft-commit", group: "Git", binding: { meta: true, shift: true, key: "m" } },
  {
    actionId: "git.open-window",
    group: "Git",
    binding: { meta: true, shift: true, key: "g" },
    note: "Opens the standalone git window, or focuses it when it is already open.",
  },

  // ── Stack ─────────────────────────────────────────────────────────────
  {
    actionId: "stack.branch-on-top",
    group: "Stack",
    binding: { meta: true, shift: true, key: "n" },
    note: "N for new branch. Restack and submit stay palette-only — they rewrite history or hit the network.",
  },

  // ── AI ────────────────────────────────────────────────────────────────
  { actionId: "agent.toggle", group: "AI", binding: { meta: true, shift: true, key: "a" } },
  {
    actionId: "agent.newTab",
    group: "AI",
    binding: { meta: true, alt: true, key: "a" },
    note: "The slide-over is for a quick question; a tab is for a thread you want to keep, split, and come back to after a reload.",
  },
];

/// Every chord an entry claims, primary first.
export function chordsOf(entry: KeymapEntry): Binding[] {
  return [entry.binding, ...(entry.alternates ?? [])];
}

/// The entry that owns `actionId`, if any.
export function entryFor(actionId: string): KeymapEntry | undefined {
  return KEYMAP.find((e) => e.actionId === actionId);
}

/// The chord rendered as an action's accelerator. `undefined` when the action
/// is palette-only — that is a normal state, not an error.
export function primaryChordFor(actionId: string): Chord | undefined {
  return entryFor(actionId)?.binding;
}

// ─── Validation ──────────────────────────────────────────────────────────

export type KeymapProblemKind = "duplicate-chord" | "duplicate-action" | "unknown-action";

export interface KeymapProblem {
  kind: KeymapProblemKind;
  detail: string;
}

/// Structural checks that need no runtime: no action bound twice, no chord
/// claimed twice. Called by the unit test and by the dev-mode assertion.
export function validateKeymapShape(): KeymapProblem[] {
  const problems: KeymapProblem[] = [];
  const seenActions = new Set<string>();
  const chordOwner = new Map<string, string>();

  for (const entry of KEYMAP) {
    if (seenActions.has(entry.actionId)) {
      problems.push({
        kind: "duplicate-action",
        detail: `action "${entry.actionId}" appears in more than one keymap entry — use \`alternates\` for a second chord`,
      });
    }
    seenActions.add(entry.actionId);

    for (const chord of chordsOf(entry)) {
      const id = chordId(chord);
      const owner = chordOwner.get(id);
      if (owner) {
        problems.push({
          kind: "duplicate-chord",
          detail: `chord "${id}" is claimed by both "${owner}" and "${entry.actionId}"`,
        });
      } else {
        chordOwner.set(id, entry.actionId);
      }
    }
  }

  return problems;
}

/// Shape checks plus: does every bound action actually exist?
///
/// Pass the ids that are really registered (`getActions().map(a => a.id)`) for
/// the runtime assertion, or `ACTION_IDS` for the static test.
export function validateKeymap(
  knownActionIds: readonly string[],
  opts: { window?: KeymapWindow } = {},
): KeymapProblem[] {
  const known = new Set(knownActionIds);
  const problems = validateKeymapShape();

  for (const entry of KEYMAP) {
    // When auditing one window, entries owned by another are somebody else's
    // to register — flagging them here would just be noise in the console.
    if (opts.window && (entry.window ?? "main") !== opts.window) continue;
    if (!known.has(entry.actionId)) {
      problems.push({
        kind: "unknown-action",
        detail: `keymap binds "${entry.actionId}", which is not a registered action`,
      });
    }
  }

  return problems;
}

/// Convenience for the static test and the dev assertion's default case.
export function validateKeymapAgainstCatalog(): KeymapProblem[] {
  return validateKeymap(ACTION_IDS);
}
