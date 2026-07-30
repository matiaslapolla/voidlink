/// The changes list as data: filtering, flattening and focus movement.
///
/// `ChangesPane` renders three lists (conflicted, staged, unstaged) that behave
/// as one keyboard surface — arrow keys walk from the last staged file into the
/// first unstaged one without the user knowing there was a boundary, and the
/// stage/unstage/discard keys act on whichever row has focus. Doing that inside
/// the component would mean three `<For>`s each half-owning a shared cursor.
///
/// So the ordering, the filter and the movement are pure functions over the
/// status list, and the component only renders what they return and dispatches
/// the action they name. Which makes the two things worth testing — "does the
/// filter find the file I typed" and "does the cursor cross the section
/// boundary" — testable without a DOM.
import { fuzzyMatch, type MatchRange } from "@/commands/fuzzy";

/// One entry of `gitApi.fileStatus`, narrowed to what this module needs.
export interface ChangeEntry {
  path: string;
  status: string;
  staged: boolean;
}

/// Which of the three lists a row belongs to. The section is what decides
/// which action a key press maps to — `Space` stages an unstaged row and
/// unstages a staged one.
export type ChangeSection = "conflicted" | "staged" | "unstaged";

export interface ChangeRow {
  entry: ChangeEntry;
  section: ChangeSection;
  /// Identity of the *row*, not of the file.
  ///
  /// A path is no longer unique in this list: a file that is staged and then
  /// edited again appears once under Staged and once under Changes, and the two
  /// rows do opposite things — `Space` unstages the first and stages the
  /// second. Keying the cursor by path alone meant every lookup found the
  /// staged row, so pressing `Space` on the unstaged row unstaged the other
  /// one, and both rows drew the focus ring at once.
  key: string;
  /// Which characters of `entry.path` matched the filter, for the
  /// `bg-primary/15` highlight the palette and file finder already use. Empty
  /// when there is no filter.
  ranges: MatchRange[];
}

/// Sections in render order. Conflicts first because they block everything
/// else; staged before unstaged because that is the direction work flows.
const SECTION_ORDER: ChangeSection[] = ["conflicted", "staged", "unstaged"];

function sectionOf(entry: ChangeEntry): ChangeSection {
  if (entry.status === "conflicted") return "conflicted";
  return entry.staged ? "staged" : "unstaged";
}

/// The row's stable identity: its section plus its path.
///
/// A NUL escape as the separator because it is the one byte a path cannot
/// contain, so no filename can forge another row's key.
export function rowKey(section: ChangeSection, path: string): string {
  return `${section}\u0000${path}`;
}

/// The whole list, filtered and flattened into the exact order it renders in.
///
/// Filtering is fuzzy and path-aware — the same matcher the palette and the
/// file finder use, so typing `btn` finds `src/components/Button.tsx` here for
/// the same reason it does there. Ordering is *not* by score: a changes list
/// that reshuffles as you type loses the one property that makes it scannable,
/// which is that a file stays where you last saw it.
export function flattenChanges(entries: readonly ChangeEntry[], filter = ""): ChangeRow[] {
  const rows: ChangeRow[] = [];
  for (const section of SECTION_ORDER) {
    for (const entry of entries) {
      if (sectionOf(entry) !== section) continue;
      const match = fuzzyMatch(entry.path, filter, { pathAware: true });
      if (!match) continue;
      rows.push({ entry, section, key: rowKey(section, entry.path), ranges: match.ranges });
    }
  }
  return rows;
}

/// The rows of one section, for rendering it as its own group.
export function rowsIn(rows: readonly ChangeRow[], section: ChangeSection): ChangeRow[] {
  return rows.filter((r) => r.section === section);
}

/// Move the cursor by `delta` rows, clamping at both ends.
///
/// Clamping rather than wrapping: a list you can walk off the bottom of and
/// reappear at the top of is disorienting in a panel this short, and holding
/// `ArrowDown` should come to rest at the last file rather than cycling.
/// Crossing a section boundary is invisible on purpose — the three lists are
/// one keyboard surface.
///
/// Takes and returns a `ChangeRow.key`, not a path — see `rowKey`. Returns
/// `null` when there is nothing to focus.
export function moveFocus(
  rows: readonly ChangeRow[],
  currentKey: string | null,
  delta: number,
): string | null {
  if (rows.length === 0) return null;
  const current = rows.findIndex((r) => r.key === currentKey);
  // No cursor yet: `ArrowDown` starts at the top, `ArrowUp` at the bottom.
  if (current === -1) return delta > 0 ? rows[0].key : rows[rows.length - 1].key;
  const next = Math.min(rows.length - 1, Math.max(0, current + delta));
  return rows[next].key;
}

/// Keep the cursor on something real after a refresh. Staging a file moves it
/// between sections and filtering can remove it entirely; in both cases the
/// cursor should land near where it was rather than vanishing, so the user can
/// keep pressing the same key.
export function reconcileFocus(
  rows: readonly ChangeRow[],
  currentKey: string | null,
  previousIndex: number,
): string | null {
  if (rows.length === 0) return null;
  if (currentKey && rows.some((r) => r.key === currentKey)) return currentKey;
  const idx = Math.min(rows.length - 1, Math.max(0, previousIndex));
  return rows[idx].key;
}

/// What a key does to the focused row. Returned rather than performed, so the
/// mapping is data and the component owns the git calls.
export type ChangeAction =
  | { kind: "open" }
  | { kind: "stage" }
  | { kind: "unstage" }
  | { kind: "discard" }
  | { kind: "resolve" }
  | { kind: "move"; delta: number }
  | { kind: "none" };

/// The change list's local key map.
///
/// Local because this is navigation *inside* a focused widget, not a global
/// binding — `commands/keymap.ts` owns the latter and would have to grow a
/// mode stack to own the former. `Space` is deliberately the toggle rather
/// than two separate keys: the action a row needs is always the opposite of
/// its current state, and one key that does the right thing beats two the user
/// has to choose between.
export function actionForKey(key: string, section: ChangeSection): ChangeAction {
  switch (key) {
    case "ArrowDown":
      return { kind: "move", delta: 1 };
    case "ArrowUp":
      return { kind: "move", delta: -1 };
    case "PageDown":
      return { kind: "move", delta: 10 };
    case "PageUp":
      return { kind: "move", delta: -10 };
    case "Home":
      return { kind: "move", delta: -Number.MAX_SAFE_INTEGER };
    case "End":
      return { kind: "move", delta: Number.MAX_SAFE_INTEGER };
    case "Enter":
      return section === "conflicted" ? { kind: "resolve" } : { kind: "open" };
    case " ":
      if (section === "conflicted") return { kind: "resolve" };
      return section === "staged" ? { kind: "unstage" } : { kind: "stage" };
    case "Backspace":
    case "Delete":
      // Discard is irreversible, so it stays behind a confirm in the component
      // (§7.5.5) — this only names the intent.
      //
      // Only the *unstaged* section offers it. The mouse UI never puts a discard
      // control on a staged row (the secondary action is passed to the unstaged
      // list alone), so a keyboard binding that discarded staged work destroyed
      // something the visible interface said was safe — and staged work is
      // deliberate work, the most expensive kind to lose.
      return section === "unstaged" ? { kind: "discard" } : { kind: "none" };
    default:
      return { kind: "none" };
  }
}
