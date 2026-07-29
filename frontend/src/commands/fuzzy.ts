/// Subsequence scoring for the two quick-open surfaces (⌘P's file finder and
/// ⇧⌘O's symbol picker).
///
/// Lifted out of `FileFinder.tsx` when the symbol picker needed the same
/// ranking. Deliberately not a fuzzy-match library: the rules below are tuned
/// for slash-separated paths and dot-separated symbol names, both of which want
/// "matched the last segment" to beat "matched somewhere in the middle", and
/// that is the only property either surface actually depends on.

/// Rank `candidate` against `query`. Higher is better; a negative result means
/// no match at all and the row should not be shown.
///
/// Three tiers, in order: a substring hit inside the last `/`-separated segment,
/// a substring hit anywhere, then a subsequence match penalised by how far the
/// characters had to spread.
export function fuzzyScore(candidate: string, query: string): number {
  if (!query) return 0;
  const t = candidate.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) {
    // Heavily prefer matches on the file name (last segment).
    const slash = t.lastIndexOf("/");
    if (idx > slash) return 2000 - (idx - slash);
    return 1000 - idx;
  }
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score -= found - ti;
    ti = found + 1;
  }
  return 100 + score;
}
