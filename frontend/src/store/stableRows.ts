/// Keep list rows the same *objects* across a refetch that did not change them.
///
/// Solid's `<For>` is keyed by reference. Every list in the git surfaces is
/// built from a resource that hands back a brand-new array of brand-new objects
/// on every pulse — and the git panes pulse on a filesystem watcher, so that is
/// several times a second while anything is running. `<For>` sees N new
/// references, tears down N rows and builds N more.
///
/// What that costs is not framerate, it is interaction:
///
/// - **Focus dies.** A focused row button is removed from the DOM mid-refresh,
///   so the keyboard user is dropped back to `<body>` between keystrokes.
/// - **Hover-revealed controls flicker.** The rename/delete buttons appear on
///   `group-hover`; the group is a different element now, so the pointer is not
///   over it until the next mouse event.
/// - **Anything mid-gesture is cancelled** — a transition, a text selection, a
///   menu anchored to a row.
///
/// The fix is not `<Index>`. `<Index>` keys by *position*, so inserting a
/// branch at the top would leave every row's DOM in place and silently
/// repurpose it for a different branch — focus would survive on the wrong row,
/// which is worse than losing it.
///
/// So: key by a real identity, and return the **previous object** whenever the
/// new one is indistinguishable. `<For>` then sees the same reference and
/// leaves the row alone. When a field genuinely changed, a new object is
/// returned and the row rebuilds exactly as it does today — the row really does
/// need to re-render, and that case was never the problem.
export function createRowIdentity<T>(
  /// What makes this row *this* row, across refetches. Never a field that
  /// changes as the row's contents change.
  key: (row: T) => string,
  /// What makes two versions of that row the same. Defaults to the whole row,
  /// which is what you want unless the row carries something unserializable.
  fingerprint: (row: T) => string = (row) => JSON.stringify(row),
): (rows: readonly T[]) => T[] {
  let previous = new Map<string, { print: string; row: T }>();
  return (rows) => {
    const next = new Map<string, { print: string; row: T }>();
    const out: T[] = [];
    for (const row of rows) {
      const id = key(row);
      const print = fingerprint(row);
      // Two rows sharing a key must not both adopt the cached object: `<For>`
      // renders one reference once, so the duplicate would vanish from the
      // list entirely. `next.has(id)` is the guard — the first row with a key
      // may keep its identity, later ones stay fresh objects and rebuild.
      const old = next.has(id) ? undefined : previous.get(id);
      const kept = old && old.print === print ? old.row : row;
      if (!next.has(id)) next.set(id, { print, row: kept });
      out.push(kept);
    }
    previous = next;
    return out;
  };
}
