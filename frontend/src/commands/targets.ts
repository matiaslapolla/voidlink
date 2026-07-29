/// What a picker can send you to, described without saying how.
///
/// The palette and the "go to open tab" switcher both list open tabs, and the
/// palette also lists recently closed files. Neither of them knows how to
/// activate one: the kind-dispatch (`selectTerminal` vs `selectCompareTab` vs
/// "open the editor window and reveal a line") lives in `App.tsx`, which owns
/// the store and the cross-window plumbing.
///
/// So the pickers take a list of these — a label to search, an icon hint, and a
/// closure that does the thing — and stay presentation.
export interface OpenTabTarget {
  id: string;
  label: string;
  /// A `TabKind` string, used only to pick the row's icon.
  kind: string;
  /// Secondary text, also searched: a compare's refs, a browser tab's URL.
  detail?: string;
  open: () => void;
}

export interface RecentFileTarget {
  /// Full path, shown as the row's secondary text and searched path-aware.
  path: string;
  /// Basename, the primary text.
  label: string;
  open: () => void;
}
