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

/// Whether a `contextmenu` on the grid should open *our* menu, or be left for
/// the application.
///
/// Taking it unconditionally is what wedged full-screen TUIs: xterm reports the
/// button-3 press to the program, our overlay then takes the pointer, and the
/// matching release never arrives — lazygit, btop and claude sit waiting for a
/// button-up that cannot come and have to be killed. So when the application
/// owns the mouse the gesture is its own, and Shift is the way back to our
/// menu, the same escape hatch iTerm2 and VS Code use (and the same modifier
/// xterm's own `SelectionService` already takes for forcing a selection through
/// mouse reporting).
///
/// The alternate screen is deliberately *not* part of this. A full-screen app
/// can run with reporting off — a pager, a `less` — and there the right-click
/// is still ours to answer.
export function terminalMenuOpensOn(opts: {
  mouseTrackingMode: IModes["mouseTrackingMode"];
  shiftKey: boolean;
}): boolean {
  return !applicationOwnsMouse(opts.mouseTrackingMode) || opts.shiftKey;
}

export interface TerminalMenuActions {
  /// The current selection text, or `""` when nothing is selected —
  /// `term.getSelection()` at the call site.
  selection: string;
  onCopy: (text: string) => void;
  onPaste: () => void;
  onClear: () => void;
  /// Absent means the pane offers no "close terminal" row.
  onClose?: () => void;
}

export function terminalMenuItems(actions: TerminalMenuActions): ContextMenuItem[] {
  const rows: ContextMenuItem[] = [
    {
      label: "Copy",
      disabledReason: actions.selection ? undefined : "Nothing selected",
      onSelect: () => actions.onCopy(actions.selection),
    },
    {
      label: "Paste",
      onSelect: actions.onPaste,
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
