/// The terminal's right-click menu (Stream D), as a pure row builder.
///
/// Pulled out of `TerminalPane.tsx` for the same reason `boardModel.ts` is
/// separate from `BoardSurface.tsx`: the question with a wrong answer here —
/// which rows show, and with what `disabledReason` — is plain data in, data
/// out, and testable in `unit` without mounting a real `xterm.js` instance
/// (canvas, `ResizeObserver`, the Tauri PTY channel) just to check a label.
import type { ContextMenuItem } from "@/components/git/ContextMenu";

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
