/// The text rewrites that run on the way to disk.
///
/// Pure string→string, and separate from `editorController` on purpose: these
/// are the only part of the save path with interesting edge cases (CRLF, a file
/// that is entirely whitespace, a buffer that already ends in a newline) and
/// they should be testable without a Monaco instance.
///
/// Format-on-save is *not* here. Formatting is Monaco's — it runs a registered
/// document-formatting provider against the model and needs the editor — so it
/// happens in the controller, before these run. The order matters and is
/// asserted in the tests: format, then trim, then final newline. Trimming after
/// a formatter means a formatter that leaves trailing space still yields a
/// clean file; adding the final newline last means it survives the trim.

export interface SaveTransformOptions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

/// The line terminator the text already uses. A CRLF file must stay CRLF —
/// silently converting line endings on save is how an editor turns a one-line
/// change into a whole-file diff.
function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/// Strip trailing spaces and tabs from every line, leaving the terminators
/// alone. Blank-but-indented lines collapse to empty, which is the point.
export function trimTrailingWhitespace(text: string): string {
  // Split on the terminator rather than a regex over the whole string so a
  // lone `\r` inside a CRLF pair is never treated as content.
  return text
    .split("\n")
    .map((line) => {
      const hadCr = line.endsWith("\r");
      const body = hadCr ? line.slice(0, -1) : line;
      return body.replace(/[ \t]+$/, "") + (hadCr ? "\r" : "");
    })
    .join("\n");
}

/// Guarantee exactly one terminator at the end of a non-empty file. An empty
/// buffer stays empty — writing a newline into a file the user just emptied is
/// a change they did not ask for.
export function insertFinalNewline(text: string): string {
  if (text === "") return text;
  if (text.endsWith("\n")) return text;
  return text + detectEol(text);
}

/// Everything the save pipeline does to the buffer text, in order.
export function applySaveTransforms(text: string, opts: SaveTransformOptions): string {
  let out = text;
  if (opts.trimTrailingWhitespace) out = trimTrailingWhitespace(out);
  if (opts.insertFinalNewline) out = insertFinalNewline(out);
  return out;
}
