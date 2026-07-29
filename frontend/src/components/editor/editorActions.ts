/// The editing commands VoidLink surfaces for the code editor.
///
/// One table, three consumers:
///   1. `registerEditorActions` contributes each entry to the shared Monaco
///      editor via `addAction`, which is what puts them in Monaco's own context
///      menu and F1 palette;
///   2. `editorPaletteActions` turns the same table into `commands/registry.ts`
///      entries, so ⌘K finds them alongside every other VoidLink action;
///   3. `commands/keymap.ts` binds the handful that warrant a global chord.
///
/// Every entry delegates to a Monaco built-in rather than reimplementing it.
/// Monaco's `moveLinesDownAction` already handles multi-cursor, folded regions,
/// and the last-line edge case; a hand-rolled version would be a strictly worse
/// copy that drifts on the next Monaco upgrade. What this module adds is
/// *discoverability* — those commands exist today but are reachable only by
/// people who already know Monaco's chords.
///
/// Deliberately no dependency on `editorController`: it imports this, so a
/// reference back would be a cycle. Callers hand in the editor.

import type * as Monaco from "monaco-editor";
import type { Action } from "@/commands/registry";

export interface EditorActionDef {
  /// VoidLink's id — the one the palette and the keymap use. Namespaced so it
  /// cannot collide with a Monaco command id.
  id: string;
  label: string;
  description?: string;
  /// The Monaco built-in this runs.
  monacoId: string;
  /// Where the action lands in Monaco's right-click menu. Absent keeps it out —
  /// a fifteen-item context menu is worse than no context menu.
  contextMenuGroupId?: string;
  contextMenuOrder?: number;
}

/// The closed list. `1_modification` is Monaco's own group id for commands that
/// change the buffer; reusing it keeps the menu ordered the way the built-ins
/// already are.
export const EDITOR_ACTIONS: readonly EditorActionDef[] = [
  {
    id: "editor.format-document",
    label: "Format document",
    description: "Run the language's formatter over the whole file",
    monacoId: "editor.action.formatDocument",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1,
  },
  {
    id: "editor.duplicate-line-up",
    label: "Duplicate line up",
    monacoId: "editor.action.copyLinesUpAction",
  },
  {
    id: "editor.duplicate-line-down",
    label: "Duplicate line down",
    monacoId: "editor.action.copyLinesDownAction",
  },
  {
    id: "editor.move-line-up",
    label: "Move line up",
    monacoId: "editor.action.moveLinesUpAction",
  },
  {
    id: "editor.move-line-down",
    label: "Move line down",
    monacoId: "editor.action.moveLinesDownAction",
  },
  {
    id: "editor.toggle-line-comment",
    label: "Toggle line comment",
    monacoId: "editor.action.commentLine",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 2,
  },
  {
    id: "editor.transform-uppercase",
    label: "Transform to uppercase",
    monacoId: "editor.action.transformToUppercase",
  },
  {
    id: "editor.transform-lowercase",
    label: "Transform to lowercase",
    monacoId: "editor.action.transformToLowercase",
  },
  {
    id: "editor.transform-titlecase",
    label: "Transform to title case",
    monacoId: "editor.action.transformToTitlecase",
  },
  {
    id: "editor.sort-lines-ascending",
    label: "Sort lines ascending",
    monacoId: "editor.action.sortLinesAscending",
  },
  {
    id: "editor.sort-lines-descending",
    label: "Sort lines descending",
    monacoId: "editor.action.sortLinesDescending",
  },
  {
    id: "editor.jump-to-bracket",
    label: "Jump to matching bracket",
    monacoId: "editor.action.jumpToBracket",
  },
  {
    id: "editor.add-cursor-above",
    label: "Add cursor above",
    monacoId: "editor.action.insertCursorAbove",
  },
  {
    id: "editor.add-cursor-below",
    label: "Add cursor below",
    monacoId: "editor.action.insertCursorBelow",
  },
  {
    id: "editor.add-cursor-next-occurrence",
    label: "Add cursor at next occurrence",
    description: "Select the next match of the current selection",
    monacoId: "editor.action.addSelectionToNextFindMatch",
  },
] as const;

/// Run one entry against an editor. Returns `false` when there is no editor or
/// Monaco does not have the built-in (a language with no formatter, say), so
/// callers can stay quiet rather than reporting a failure the user caused by
/// not having a formatter installed.
export function runEditorAction(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  def: EditorActionDef,
): boolean {
  if (!editor) return false;
  const action = editor.getAction(def.monacoId);
  if (!action) return false;
  editor.focus();
  void action.run();
  return true;
}

/// Contribute every entry to `editor`, returning a disposer.
///
/// Guarded against a second call on the same editor: `addAction` with an id
/// Monaco already knows replaces the contribution, so a double registration is
/// not fatal — but it does leak the first disposable, and "registered exactly
/// once" is a property worth keeping true rather than merely survivable.
const registered = new WeakSet<object>();

export function registerEditorActions(
  editor: Monaco.editor.IStandaloneCodeEditor,
): () => void {
  if (registered.has(editor)) return () => {};
  registered.add(editor);
  const disposables = EDITOR_ACTIONS.map((def) =>
    editor.addAction({
      id: def.id,
      label: def.label,
      contextMenuGroupId: def.contextMenuGroupId,
      contextMenuOrder: def.contextMenuOrder,
      run: () => void runEditorAction(editor, def),
    }),
  );
  return () => {
    registered.delete(editor);
    for (const d of disposables) d.dispose();
  };
}

/// The same table as `commands/registry.ts` actions, so ⌘K lists them.
///
/// `enabled` is what keeps the palette honest: with no editor attached — no
/// file open, or the host unmounted in stacked mode — these do nothing, and a
/// row that would do nothing renders greyed rather than pretending.
export function editorPaletteActions(
  getEditor: () => Monaco.editor.IStandaloneCodeEditor | null,
): Action[] {
  return EDITOR_ACTIONS.map((def) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    group: "Editor",
    enabled: () => getEditor() !== null,
    run: () => void runEditorAction(getEditor(), def),
  }));
}
