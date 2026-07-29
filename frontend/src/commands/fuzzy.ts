/// The one fuzzy matcher, and the one set of highlight ranges.
///
/// There were two before this — a `fuzzyScore` in `CommandPalette.tsx` and a
/// path-weighted variant in `FileFinder.tsx` — and the two quick switchers would
/// have made four. They are the same algorithm with one knob (does a match in
/// the last path segment count for more?), so it is one function with one knob.
///
/// What is genuinely new here is `ranges`: which characters matched. MASTER.md
/// §11.5's "tinted-primary selection" idiom wants those characters marked with
/// `bg-primary/15`, and a scorer that only returns a number cannot say where.
///
/// DOM-free on purpose — `FuzzyText.tsx` renders what this returns, and the
/// scoring is unit-testable in plain node.

/// A half-open `[start, end)` slice of the searched string.
export type MatchRange = [number, number];

export interface FuzzyMatch {
  /// Higher is better. Only comparable between results from the same query.
  score: number;
  /// The matched character runs, in order, non-overlapping.
  ranges: MatchRange[];
}

export interface FuzzyOptions {
  /// Weight a hit after the last `/` far higher, so typing a file's name beats
  /// the same letters buried in a directory. What `FileFinder` did by hand.
  pathAware?: boolean;
}

/// Merge adjacent indices into runs, so `[0,1,2,7]` renders as two highlighted
/// spans rather than four.
function toRanges(indices: number[]): MatchRange[] {
  const out: MatchRange[] = [];
  for (const i of indices) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/// Score `text` against `query`, or `null` when it does not match at all.
///
/// An empty query matches everything at score 0 with no highlight — the resting
/// state of every overlay in the app.
export function fuzzyMatch(
  text: string,
  query: string,
  options: FuzzyOptions = {},
): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();

  // Contiguous substring: always beats a scattered subsequence, and is what the
  // user meant nine times in ten.
  const idx = t.indexOf(q);
  if (idx !== -1) {
    const ranges: MatchRange[] = [[idx, idx + q.length]];
    if (options.pathAware) {
      const slash = t.lastIndexOf("/");
      if (idx > slash) return { score: 2000 - (idx - slash), ranges };
      return { score: 1000 - idx, ranges };
    }
    return { score: 1000 - idx, ranges };
  }

  // Subsequence fallback, penalised by the gaps between hits.
  let score = 0;
  let cursor = 0;
  const indices: number[] = [];
  for (const ch of q) {
    const found = t.indexOf(ch, cursor);
    if (found === -1) return null;
    score -= found - cursor;
    indices.push(found);
    cursor = found + 1;
  }
  return { score: 100 + score, ranges: toRanges(indices) };
}

/// Best match across several fields of the same row — a palette action's label
/// and its group, a tab's label and its kind. Returns the winning field's index
/// alongside, so the caller highlights the field that actually matched.
export function bestFuzzyMatch(
  fields: readonly string[],
  query: string,
  options: FuzzyOptions = {},
): { field: number; match: FuzzyMatch } | null {
  let best: { field: number; match: FuzzyMatch } | null = null;
  fields.forEach((text, field) => {
    const match = fuzzyMatch(text, query, options);
    if (!match) return;
    if (!best || match.score > best.match.score) best = { field, match };
  });
  return best;
}
