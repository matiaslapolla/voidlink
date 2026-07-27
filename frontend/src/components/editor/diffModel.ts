/// Turning a git hunk list back into two whole documents.
///
/// Monaco's diff editor wants two full texts; libgit2 hands us hunks. Rather
/// than add a "read this file at that ref" Rust command, we reconstruct the
/// original side from the working-tree text plus the hunks — which is exact,
/// because a diff enumerates *every* difference between the two files: lines the
/// hunks don't mention are byte-identical on both sides, and inside a hunk the
/// `-` and context lines spell the old file out literally.
///
/// The one thing a hunk list cannot tell us is whether the old file ended with a
/// newline (libgit2 reports that as an out-of-band marker line, not as content),
/// so we mirror the working tree's EOF state. Getting that wrong the other way
/// would paint a phantom change on the last line of every file.

import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";

/// libgit2's EOF-newline markers arrive with origin `~` (see the `_ => "~"` arm
/// in `src-tauri/src/git/diff.rs`). They are annotations, not file content, and
/// splicing them in would corrupt the reconstruction.
function isEofMarker(line: DiffLine): boolean {
  return line.origin === "~" && line.content.startsWith("\\ No newline");
}

/// Whether a diff line is present in the *old* file: removals and context, but
/// not additions. `~` is treated as context, matching `SplitDiffRenderer`.
function inOldSide(line: DiffLine): boolean {
  return line.origin === "-" || line.origin === " " || line.origin === "~";
}

/// Reconstruct the pre-change text of a file from its post-change text and the
/// hunks describing the difference.
///
/// `workingText` is the full current content. Hunks are applied in `newStart`
/// order; unchanged stretches between them are copied across untouched.
export function reconstructOriginal(workingText: string, hunks: DiffHunk[]): string {
  const newLines = workingText.split("\n");
  const ordered = [...hunks].sort((a, b) => a.newStart - b.newStart);
  const out: string[] = [];
  // 1-based cursor into `newLines`, tracking how far we have copied.
  let cursor = 1;

  for (const hunk of ordered) {
    // Where this hunk begins in the *new* file. A pure deletion has no width
    // there, and git reports its `newStart` as the line the removal follows
    // rather than the line it replaces — so the hunk starts one line later, and
    // reading `newStart` literally would emit the deleted text too early.
    const start = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;

    // Everything between the previous hunk and this one is identical in both
    // files, so it belongs in the old text verbatim.
    for (let i = cursor; i < start && i <= newLines.length; i++) {
      out.push(newLines[i - 1]);
    }
    for (const line of hunk.lines) {
      if (isEofMarker(line)) continue;
      if (inOldSide(line)) out.push(line.content);
    }
    cursor = Math.max(cursor, start + hunk.newLines);
  }

  for (let i = cursor; i <= newLines.length; i++) out.push(newLines[i - 1]);

  // Mirror the working tree's trailing-newline state (see the module comment).
  const text = out.join("\n");
  if (workingText.endsWith("\n") && !text.endsWith("\n")) return `${text}\n`;
  if (!workingText.endsWith("\n") && text.endsWith("\n")) return text.replace(/\n$/, "");
  return text;
}

/// The two documents a diff editor should show for one file.
export interface DiffSides {
  original: string;
  modified: string;
  /// Set when there is nothing meaningful to diff — a binary blob, or a file
  /// git no longer knows about. Callers render this instead of an empty editor.
  unavailable: string | null;
}

/// Build both sides of a working-tree diff.
///
/// `fileDiff` is `null` when the file has no changes at all: both sides are then
/// the working text, which is exactly what a diff editor should show (no marks).
export function workingTreeSides(
  workingText: string,
  fileDiff: FileDiff | null,
): DiffSides {
  if (!fileDiff) {
    return { original: workingText, modified: workingText, unavailable: null };
  }
  if (fileDiff.isBinary) {
    return { original: "", modified: "", unavailable: "Binary file — no text diff." };
  }
  switch (fileDiff.status) {
    // A file added since HEAD has no original side at all; reconstructing one
    // from its hunks would produce an empty document the slow way.
    case "added":
      return { original: "", modified: workingText, unavailable: null };
    case "deleted":
      return {
        original: reconstructOriginal("", fileDiff.hunks),
        modified: "",
        unavailable: null,
      };
    default:
      return {
        original: reconstructOriginal(workingText, fileDiff.hunks),
        modified: workingText,
        unavailable: null,
      };
  }
}
