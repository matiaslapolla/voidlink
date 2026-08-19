/// Who owns Undo and Redo at the moment the Edit menu is clicked.
///
/// `menu.rs` strips the accelerator off the Edit menu's Undo/Redo items so
/// ⌘Z / ⌘⇧Z fall through AppKit and reach whichever surface has focus — that
/// half works, and it is what fixed the keyboard chord. What it also did was
/// take away the native `execCommand` forwarding that a *click* on those items
/// used to get, so Rust now emits `voidlink://menu-undo-redo` and asks the
/// webview to run the command itself.
///
/// `document.execCommand("undo")` is the obvious way to do that and is wrong
/// for the surface that matters. It drives the browser's own editing history
/// for the focused editable element; Monaco's focused element is a hidden
/// 1×1 textarea it uses purely as an input funnel, and the document's history
/// lives in a model Monaco owns. Measured, not assumed — see
/// `undoRouting.browser.test.tsx`, which types into a real Monaco and finds
/// `execCommand` leaves the buffer untouched while `trigger("undo")` reverts
/// it. `menu.rs`'s own module doc says "Monaco owns its own undo stack" three
/// paragraphs before wiring the click to `execCommand` anyway.
///
/// So the command is routed rather than broadcast: Monaco first, because it is
/// the only surface that can be focused *and* invisible to `execCommand`, and
/// the browser otherwise — which is still the right answer for the commit
/// message box, the rename input and every other plain field in the app.
import { loadedMonaco } from "./monaco";

export type UndoCommand = "undo" | "redo";

/// Run `cmd` against whatever has focus. Returns what it routed to, which is
/// the only thing a test can observe from the outside and the reason this
/// returns anything at all.
export function runUndoRedo(cmd: UndoCommand): "monaco" | "document" {
  // `hasTextFocus()` and not a `.monaco-editor` `closest()` check: with a diff
  // tab open there are two editors inside one container and only one of them
  // should move. Monaco's own answer is the authority on which.
  const editor = loadedMonaco()
    ?.editor.getEditors()
    .find((e) => e.hasTextFocus());

  if (editor) {
    // The handler ids are literally `"undo"` / `"redo"` — the same commands
    // Monaco binds ⌘Z to internally, so a menu click and the chord end up in
    // the same place instead of being two mechanisms that can disagree.
    editor.trigger("menu", cmd, null);
    return "monaco";
  }

  document.execCommand(cmd);
  return "document";
}
