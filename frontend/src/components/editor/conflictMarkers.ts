/// Parsing and rewriting of git's conflict markers.
///
/// Extracted from the git sidebar's block-based `ConflictTab` so the merge
/// editor in the editor window can share exactly one implementation: two
/// parsers for `<<<<<<<` would be two chances to disagree about what a
/// half-resolved file means, and the marker grammar is subtle enough
/// (diff3 base sections, malformed blocks) that duplicating it is how you get a
/// resolver that silently drops a hunk.

/// A single parsed conflict block from a working-tree file. `ours` and `theirs`
/// always exist; `base` is only present for diff3-style markers (`|||||||`
/// between the `<<<` and `===`). `startLine` / `endLine` are 0-indexed
/// positions in the raw file so we can splice back accurately.
export interface ConflictBlock {
  startLine: number;
  endLine: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

/// Parse `<<<<<<< / ||||||| / ======= / >>>>>>>` markers out of `content` and
/// return both the block metadata and the segmented text so callers can render
/// conflict regions distinctly from plain prose.
export function parseConflicts(content: string): {
  blocks: ConflictBlock[];
  lines: string[];
} {
  const lines = content.split("\n");
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const startLine = i;
    const oursLabel = lines[i].slice(8).trim();
    const oursStart = i + 1;
    let baseStart: number | null = null;
    let theirsStart: number | null = null;
    let endLine: number | null = null;
    let theirsLabel = "";
    for (let j = oursStart; j < lines.length; j++) {
      if (lines[j].startsWith("|||||||")) baseStart = j + 1;
      else if (lines[j].startsWith("=======")) theirsStart = j + 1;
      else if (lines[j].startsWith(">>>>>>>")) {
        endLine = j;
        theirsLabel = lines[j].slice(8).trim();
        break;
      }
    }
    if (theirsStart === null || endLine === null) {
      // Malformed — give up on this block but skip past `<<<` to avoid
      // an infinite loop.
      i++;
      continue;
    }
    const oursEnd = baseStart !== null ? baseStart - 1 : theirsStart - 1;
    const baseEnd = baseStart !== null ? theirsStart - 1 : null;
    const ours = lines.slice(oursStart, oursEnd).join("\n");
    const base =
      baseStart !== null && baseEnd !== null
        ? lines.slice(baseStart, baseEnd).join("\n")
        : null;
    const theirs = lines.slice(theirsStart, endLine).join("\n");
    blocks.push({
      startLine,
      endLine,
      ours,
      base,
      theirs,
      oursLabel: oursLabel || "ours",
      theirsLabel: theirsLabel || "theirs",
    });
    i = endLine + 1;
  }
  return { blocks, lines };
}

/// Splice `replacement` into `content` from `block.startLine` through
/// `block.endLine` (inclusive). Returns the updated full-file string.
export function replaceBlock(
  content: string,
  block: ConflictBlock,
  replacement: string,
): string {
  const lines = content.split("\n");
  const replacementLines = replacement.split("\n");
  // Edge case: if the replacement is the empty string we still want to
  // splice in one empty line so subsequent block offsets stay sane
  // until the next parse. Skipping the splice would be wrong because
  // `endLine - startLine + 1` lines need to go away.
  lines.splice(
    block.startLine,
    block.endLine - block.startLine + 1,
    ...(replacement === "" ? [] : replacementLines),
  );
  return lines.join("\n");
}

/// The text a given resolution choice puts in place of a conflict block.
///
/// "Both" keeps ours first, then theirs — the convention git itself suggests
/// with diff3 markers — and inserts the separating newline only when `ours`
/// doesn't already end in one, so accepting both never glues two lines together.
export function resolutionText(
  block: ConflictBlock,
  choice: "ours" | "theirs" | "both",
): string {
  switch (choice) {
    case "ours":
      return block.ours;
    case "theirs":
      return block.theirs;
    case "both":
      return (
        block.ours +
        (block.ours.endsWith("\n") || block.ours === "" ? "" : "\n") +
        block.theirs
      );
  }
}

/// Apply one resolution to a whole-file buffer. The composition of
/// `resolutionText` and `replaceBlock`, kept here so the merge editor and the
/// sidebar's block view can't drift on the "accept both" newline rule.
export function applyResolution(
  content: string,
  block: ConflictBlock,
  choice: "ours" | "theirs" | "both",
): string {
  return replaceBlock(content, block, resolutionText(block, choice));
}
