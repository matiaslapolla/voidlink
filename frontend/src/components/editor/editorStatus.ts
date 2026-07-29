/// The strings the editor status bar shows, derived and nothing else.
///
/// Split out from the component because every one of these is a pure function
/// of a Monaco model plus a cursor, and the interesting parts (a selection
/// spanning three lines reads differently from a caret; tabs and spaces are
/// not the same indent) are exactly the parts a component test cannot reach
/// without booting Monaco.

import type * as Monaco from "monaco-editor";

/// Monaco's language ids are lowercase machine names (`typescript`, `csharp`).
/// The status bar shows what a person calls the language. Ids not listed here
/// fall through to a capitalised form, which is right for `rust`, `go`, `lua`
/// and most of the rest — the map only exists for the ones it is wrong for.
const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  xml: "XML",
  yaml: "YAML",
  markdown: "Markdown",
  csharp: "C#",
  cpp: "C++",
  c: "C",
  sql: "SQL",
  graphql: "GraphQL",
  ini: "INI",
  shell: "Shell",
  php: "PHP",
  r: "R",
  powershell: "PowerShell",
  plaintext: "Plain text",
};

export function languageLabel(languageId: string): string {
  const known = LANGUAGE_LABELS[languageId];
  if (known) return known;
  return languageId.charAt(0).toUpperCase() + languageId.slice(1);
}

export interface CursorState {
  line: number;
  column: number;
  /// Characters covered by the selection. `0` for a bare caret.
  selected: number;
  /// Lines the selection touches. `1` for a bare caret or a within-line span.
  selectedLines: number;
}

export const NO_CURSOR: CursorState = { line: 1, column: 1, selected: 0, selectedLines: 1 };

/// `12:4`, or `12:4 (18 selected)`, or `12:4 (3 lines selected)`.
///
/// The selection suffix only appears when there is one — a permanently-visible
/// `(0 selected)` is noise, and a segment whose width changes on every
/// keystroke is worse, so the suffix is deliberately coarse.
export function cursorLabel(c: CursorState): string {
  const base = `${c.line}:${c.column}`;
  if (c.selected === 0) return base;
  if (c.selectedLines > 1) return `${base} (${c.selectedLines} lines selected)`;
  return `${base} (${c.selected} selected)`;
}

/// `Spaces: 2` / `Tab size: 4`, the phrasing every editor uses, and the reason
/// it is two phrasings: with `insertSpaces` off the number is how wide a tab
/// *renders*, which is not the same claim as how many spaces get inserted.
export function indentLabel(opts: { insertSpaces: boolean; tabSize: number }): string {
  return opts.insertSpaces ? `Spaces: ${opts.tabSize}` : `Tab size: ${opts.tabSize}`;
}

/// `LF` / `CRLF`. Monaco reports `\n` or `\r\n`; there is no third case.
export function eolLabel(eol: string): string {
  return eol === "\r\n" ? "CRLF" : "LF";
}

/// The only encoding VoidLink has. `fs_read_file` / `fs_write_file` are both
/// UTF-8, so this is a statement of fact rather than a detected value — and it
/// is shown, not hidden, because a status bar that omits the encoding invites
/// the assumption that it was detected.
export const ENCODING_LABEL = "UTF-8";

/// Read a cursor out of a live editor. The one impure function here, kept
/// beside the formatters so the component has no Monaco reasoning in it.
export function readCursor(editor: Monaco.editor.IStandaloneCodeEditor): CursorState {
  const position = editor.getPosition();
  const selection = editor.getSelection();
  const model = editor.getModel();
  if (!position) return NO_CURSOR;
  const selected =
    selection && model && !selection.isEmpty()
      ? model.getValueInRange(selection).length
      : 0;
  const selectedLines =
    selection && !selection.isEmpty()
      ? Math.abs(selection.endLineNumber - selection.startLineNumber) + 1
      : 1;
  return { line: position.lineNumber, column: position.column, selected, selectedLines };
}
