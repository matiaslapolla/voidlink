/// `git add -p`'s line-selection mode, as a pure transformation.
///
/// The whole of line-level staging is one idea: a patch is *not* the lines you
/// picked, it is the whole hunk with the lines you did not pick neutralised.
/// Get that backwards and git applies a patch whose pre-image does not match
/// the file, which either fails loudly (fine) or applies at an offset (not
/// fine — that is how staging silently writes the wrong content).
///
/// So nothing here rewrites a file. It builds a `FileDiff` carrying one
/// synthetic hunk and hands it to the *existing* `git_apply_hunk` /
/// `git_discard_hunk`, which serialise it to a unified patch and let libgit2
/// apply it — including the stale-basis guard, which we deliberately keep by
/// copying `oldBlobOid` through untouched. There is no new Rust command
/// because there did not need to be one: Rust already builds its patch from
/// whatever lines the `FileDiff` carries, so a filtered `FileDiff` is a
/// filtered patch.
///
/// The two directions are mirror images, and which one you need depends on
/// what the patch's pre-image has to be:
///
///   * **forward** (stage from the working tree) applies to the index, whose
///     content is the hunk's *old* side. Every `-` line must therefore still
///     appear: the ones you picked as `-`, the ones you did not as context.
///     Unpicked `+` lines are dropped — they are not in the index and adding
///     them is exactly what you declined to do.
///   * **reverse** (unstage, or discard from the working tree) is un-applied
///     against the hunk's *new* side. So it is the `+` lines that must all
///     appear — picked as `+` (to be removed), unpicked as context — and the
///     unpicked `-` lines that are dropped.
///
/// Both are then handed to Rust with the same `reverse` flag the whole-hunk
/// path uses, so the inversion itself stays in one place.
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";

/// See the module header. `forward` stages; `reverse` unstages or discards.
export type PatchDirection = "forward" | "reverse";

/// A set of lines chosen inside exactly one hunk.
///
/// `lines` indexes the hunk's own `lines` array — the raw one, markers
/// included — and not a filtered or rendered view of it. A row index would be
/// a second numbering that could drift from the first, and drifting numbering
/// is precisely the failure this feature cannot have.
export interface LineSelection {
  hunkIndex: number;
  lines: readonly number[];
}

/// Why a hunk cannot be staged line by line, or `null` when it can.
///
/// Returned rather than thrown so the renderer can grey the affordance out and
/// say why, instead of offering a control that fails on click.
export type LineStagingBlock = "no-newline" | "binary" | "no-lines";

export function lineStagingBlock(file: FileDiff, hunk: DiffHunk | undefined): LineStagingBlock | null {
  if (file.isBinary) return "binary";
  if (!hunk) return "no-lines";
  // A `\ No newline at end of file` marker is a claim about the line above it,
  // and neutralising that line moves the claim to a line it was never about.
  // Reconstructing which side keeps the marker is real work with a silent
  // wrong answer, so hunks that carry one keep whole-hunk staging only.
  if (hunk.lines.some((l) => l.origin === "\\")) return "no-newline";
  if (!hunk.lines.some(isChanged)) return "no-lines";
  return null;
}

export function explainLineStagingBlock(reason: LineStagingBlock): string {
  switch (reason) {
    case "no-newline":
      return "This hunk ends without a trailing newline — stage or discard it whole.";
    case "binary":
      return "Binary files have no lines to pick.";
    case "no-lines":
      return "This hunk has no added or removed lines.";
  }
}

/// The lines a user is allowed to pick: additions and deletions. Context is
/// not a choice — it is in both sides already.
export function isChanged(line: DiffLine): boolean {
  return line.origin === "+" || line.origin === "-";
}

/// The indices, within `hunk.lines`, that `isChanged` accepts.
export function selectableIndices(hunk: DiffHunk): number[] {
  const out: number[] = [];
  hunk.lines.forEach((l, i) => {
    if (isChanged(l)) out.push(i);
  });
  return out;
}

/// A `FileDiff` carrying one hunk: `file`'s hunk `hunkIndex`, with everything
/// outside `selected` neutralised for `direction`.
///
/// Returns `null` when the selection is empty, or holds nothing that is a
/// changed line in this hunk, or names a hunk that does not exist. Refusing is
/// the point: an empty selection must never fall through to "then stage the
/// whole hunk", which is the difference between doing nothing and staging
/// lines the user was in the middle of deciding about.
///
/// The result is meant to be passed with `hunkIndex: 0`.
export function buildLineSelectionDiff(
  file: FileDiff,
  hunkIndex: number,
  selected: Iterable<number>,
  direction: PatchDirection,
): FileDiff | null {
  const hunk = file.hunks[hunkIndex];
  if (!hunk) return null;
  if (lineStagingBlock(file, hunk)) return null;

  const picked = new Set<number>();
  for (const i of selected) {
    const line = hunk.lines[i];
    if (line && isChanged(line)) picked.add(i);
  }
  if (picked.size === 0) return null;

  /// Which origin survives unpicked. See the module header: the side that has
  /// to be reconstructed exactly is kept as context, the other is dropped.
  const keepAsContext = direction === "forward" ? "-" : "+";
  const dropUnpicked = direction === "forward" ? "+" : "-";

  const lines: DiffLine[] = [];
  hunk.lines.forEach((line, i) => {
    if (!isChanged(line)) {
      lines.push(line);
      return;
    }
    if (picked.has(i)) {
      lines.push(line);
      return;
    }
    if (line.origin === keepAsContext) {
      // Neutralised, not removed. Both line numbers survive because a context
      // line legitimately has both, and the deletion's old number is the one
      // it keeps in the pre-image.
      lines.push({ ...line, origin: " " });
      return;
    }
    if (line.origin === dropUnpicked) return;
  });

  // A selection that neutralised every change would produce a context-only
  // patch — a no-op that libgit2 applies happily and that would report
  // success while doing nothing. Cannot happen given `picked.size > 0`, but
  // the assertion is cheaper than the bug it rules out.
  if (!lines.some(isChanged)) return null;

  const synthetic: DiffHunk = {
    ...hunk,
    // Counts are recomputed on the Rust side from the lines actually shipped
    // (`build_unified_patch`), so leaving these as the original hunk's totals
    // would be a header that lies about its own body. Recompute here too, so
    // the value is right in the object as well as in the patch text.
    oldLines: lines.filter((l) => l.origin !== "+").length,
    newLines: lines.filter((l) => l.origin !== "-").length,
    lines,
  };

  return { ...file, hunks: [synthetic] };
}

/// Extend a selection with shift-click, within one hunk.
///
/// Plain click toggles a single line and moves the anchor to it; shift-click
/// selects the whole run of changed lines between the anchor and the clicked
/// line. A click in a different hunk starts over — a selection spanning two
/// hunks would have to become two patches, and two patches is two chances for
/// the second to fail after the first has already been applied.
export function applyLineClick(
  current: LineSelection | null,
  anchor: number | null,
  hunk: DiffHunk,
  hunkIndex: number,
  lineIndex: number,
  shift: boolean,
): { selection: LineSelection | null; anchor: number | null } {
  const line = hunk.lines[lineIndex];
  if (!line || !isChanged(line)) return { selection: current, anchor };

  const sameHunk = current?.hunkIndex === hunkIndex;
  if (shift && sameHunk && anchor !== null) {
    const lo = Math.min(anchor, lineIndex);
    const hi = Math.max(anchor, lineIndex);
    const range = selectableIndices(hunk).filter((i) => i >= lo && i <= hi);
    return { selection: { hunkIndex, lines: range }, anchor };
  }

  const existing = sameHunk ? new Set(current!.lines) : new Set<number>();
  if (existing.has(lineIndex)) existing.delete(lineIndex);
  else existing.add(lineIndex);

  if (existing.size === 0) return { selection: null, anchor: null };
  return {
    selection: { hunkIndex, lines: [...existing].sort((a, b) => a - b) },
    anchor: lineIndex,
  };
}

/// How many lines the action would touch, for a button that has to say so.
/// `0` when the selection is elsewhere or absent, which is also the caller's
/// signal to act on the whole hunk instead.
export function selectionSizeFor(selection: LineSelection | null, hunkIndex: number): number {
  return selection && selection.hunkIndex === hunkIndex ? selection.lines.length : 0;
}
