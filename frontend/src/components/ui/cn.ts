/// Join class fragments, dropping the falsy ones.
///
/// Deliberately not `clsx`: the primitives in this folder compose three or four
/// static strings and a couple of conditionals, which is the entire feature set,
/// and a dependency whose whole pitch is a single local binary should not carry
/// one for that. No merge/dedupe either — a primitive that needs to *beat* a
/// caller's class does it by ordering, and callers pass `class` last on purpose.
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
