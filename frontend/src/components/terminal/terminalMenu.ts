/// The terminal's right-click menu (Stream D), as a pure row builder.
///
/// Pulled out of `TerminalPane.tsx` for the same reason `boardModel.ts` is
/// separate from `BoardSurface.tsx`: the question with a wrong answer here —
/// which rows show, and with what `disabledReason` — is plain data in, data
/// out, and testable in `unit` without mounting a real `xterm.js` instance
/// (canvas, `ResizeObserver`, the Tauri PTY channel) just to check a label.
import type { ContextMenuItem } from "@/components/git/ContextMenu";
import type { IModes } from "@xterm/xterm";

/// Whether the program on the other end of the PTY has asked for the mouse.
///
/// One named predicate because two unrelated features ask this same question
/// and neither of them is really about tracking modes: linkifying (anything we
/// put under the cursor competes with the application for the same gesture) and
/// the right-click menu below. Both want "does the application own the mouse
/// right now", and `mouseTrackingMode` is live state — a program turns
/// reporting on when it starts and off when it exits — so callers must read it
/// off `term.modes` at the moment of the gesture rather than cache it.
export function applicationOwnsMouse(mouseTrackingMode: IModes["mouseTrackingMode"]): boolean {
  return mouseTrackingMode !== "none";
}

/// Whether a plain right-click on the grid should open *our* menu.
///
/// The gesture used to be shared between "open our menu" and "yield to a
/// full-screen app tracking the mouse", with Shift as the escape hatch back to
/// our menu. It no longer is: a plain right-click now pastes (see
/// `TerminalPane.tsx`'s `onContextMenu`, which is what actually applies
/// `applicationOwnsMouse` to decide paste-vs-yield), and the menu moves
/// wholesale to Shift+right-click — the same modifier that was already the
/// way back to it, now the *only* way in, whether or not the application owns
/// the mouse. Right-click-to-paste is the iTerm2/VS Code default; Shift for
/// the menu is the escape hatch both already use.
export function terminalMenuOpensOn(opts: { shiftKey: boolean }): boolean {
  return opts.shiftKey;
}

export interface TerminalMenuActions {
  /// The current selection text, or `""` when nothing is selected —
  /// `term.getSelection()` at the call site.
  selection: string;
  onCopy: (text: string) => void;
  onPaste: () => void;
  onClear: () => void;
  /// Run "Search selection in files" — the existing find-across-files surface,
  /// pre-filled with the trimmed selection.
  onSearchInFiles: (query: string) => void;
  /// Open `openPathTarget` (below) in the editor. Only ever called when it is
  /// set, so the row's own `disabledReason` is the real guard.
  onOpenPath: (path: string) => void;
  /// The selection resolved to an absolute, *existing* file path — relative
  /// to the workspace root or already absolute — or `undefined` when it
  /// doesn't. Resolving this needs a filesystem check, which is the caller's
  /// job (this builder stays pure); `undefined` also covers "haven't checked
  /// yet", so the row simply starts disabled and enables once the check
  /// lands.
  openPathTarget?: string;
  /// Absent means the pane offers no "close terminal" row.
  onClose?: () => void;
}

export function terminalMenuItems(actions: TerminalMenuActions): ContextMenuItem[] {
  const hasSelection = actions.selection.length > 0;
  const rows: ContextMenuItem[] = [
    {
      label: "Copy",
      disabledReason: hasSelection ? undefined : "Nothing selected",
      onSelect: () => actions.onCopy(actions.selection),
    },
    {
      label: "Paste",
      onSelect: actions.onPaste,
    },
    {
      label: "Search selection in files",
      separatorBefore: true,
      disabledReason: hasSelection ? undefined : "Nothing selected",
      onSelect: () => actions.onSearchInFiles(actions.selection),
    },
    {
      label: "Open path in editor",
      disabledReason: !hasSelection
        ? "Nothing selected"
        : actions.openPathTarget
          ? undefined
          : "Selection is not an existing file path",
      onSelect: () => {
        if (actions.openPathTarget) actions.onOpenPath(actions.openPathTarget);
      },
    },
    {
      label: "Clear",
      separatorBefore: true,
      onSelect: actions.onClear,
    },
  ];
  if (actions.onClose) {
    rows.push({ label: "Close terminal", separatorBefore: true, onSelect: actions.onClose });
  }
  return rows;
}
