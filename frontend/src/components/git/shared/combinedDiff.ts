/// Every change in the worktree, assembled into one scrollable model.
///
/// Git answers "what changed" in two separate diffs — HEAD→index and
/// index→workdir — and the second one also carries untracked files. Reviewing
/// a change means reading all of it, and the app made you open one tab per
/// file and remember which of the three lists each came from.
///
/// The one genuinely hard part, and the reason this is a pure module with
/// tests rather than a loop inside a component: **a file can be in two of
/// those diffs at once.** Stage a function, keep editing it, and the path has
/// staged changes *and* unstaged changes, which are two different diffs of two
/// different pairs of blobs. Listing it twice is a lie about how many files
/// changed; listing it once and picking a diff is a lie about what changed. So
/// it appears once, filed under the first section it belongs to, carrying both
/// states — and the row says so.
///
/// Untracked files have no old blob to diff against. Nothing here fabricates
/// one: `git_diff_working` already emits them with `status: "untracked"` and
/// an all-additions hunk against an empty base, so they are separated out by
/// status rather than by a second round trip. What they need is not different
/// data but a section of their own and a sentence saying why every line is
/// green — otherwise a new 400-line file reads as a 400-line rewrite.
import type { FileDiff } from "@/types/git";

export type CombinedSection = "staged" | "unstaged" | "untracked";

/// The order sections are shown in, and the order a file's states are listed
/// in when it has more than one. Staged first because it is what a commit
/// would take.
export const SECTION_ORDER: CombinedSection[] = ["staged", "unstaged", "untracked"];

export const SECTION_LABELS: Record<CombinedSection, string> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};

/// One diff of one path. A path with two states has two of these.
export interface CombinedState {
  section: CombinedSection;
  file: FileDiff;
}

export interface CombinedEntry {
  /// The path, and the identity: two states of one file share it. Stable
  /// across a refetch, so it is also the key expand-state is remembered by.
  path: string;
  /// Which section the row is filed under — the first of `SECTION_ORDER` the
  /// path appears in.
  section: CombinedSection;
  /// Ordered by `SECTION_ORDER`. Never empty.
  states: CombinedState[];
  /// Summed across every state, so a partially-staged file's row totals the
  /// whole change rather than half of it.
  additions: number;
  deletions: number;
  /// True when git renamed the path. Carried on the entry because the row
  /// header shows `old → new` and the states do not each need to repeat it.
  renamedFrom: string | null;
}

export interface CombinedSectionGroup {
  section: CombinedSection;
  entries: CombinedEntry[];
}

export interface CombinedDiff {
  /// Every entry, already ordered: by section, then by path within it.
  entries: CombinedEntry[];
  groups: CombinedSectionGroup[];
  totalAdditions: number;
  totalDeletions: number;
  /// Paths that are in more than one section. The header shows the count
  /// because "3 files are partly staged" is the single most surprising fact
  /// about a working tree and nothing else in the app says it.
  partiallyStagedCount: number;
}

/// How a `FileDiff` is identified with a path.
///
/// `newPath` first, because that is where the file is *now* — the name the
/// user will look for. A deletion has only `oldPath`.
export function pathOf(file: FileDiff): string {
  return file.newPath ?? file.oldPath ?? "";
}

/// Assemble the two working diffs into one model.
///
/// `staged` is `git diff --cached`; `unstaged` is `git diff`, which already
/// includes untracked files — they are split out here by their status rather
/// than fetched separately, so the two lists can never disagree about which
/// files exist.
export function assembleCombinedDiff(input: {
  staged: readonly FileDiff[];
  unstaged: readonly FileDiff[];
}): CombinedDiff {
  const byPath = new Map<string, CombinedEntry>();

  const add = (file: FileDiff, section: CombinedSection) => {
    const path = pathOf(file);
    // A delta with neither path is not addressable and cannot be rendered or
    // acted on; dropping it beats a row labelled with the empty string.
    if (!path) return;
    const existing = byPath.get(path);
    if (existing) {
      // Second state of the same path: the partially-staged case. Filed where
      // it already is — `SECTION_ORDER` put the earlier section first — and
      // the new diff is appended rather than replacing anything.
      existing.states.push({ section, file });
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      existing.renamedFrom ??= renameOf(file);
      return;
    }
    byPath.set(path, {
      path,
      section,
      states: [{ section, file }],
      additions: file.additions,
      deletions: file.deletions,
      renamedFrom: renameOf(file),
    });
  };

  // Insertion order matters: `SECTION_ORDER`'s first section to contain a path
  // is the one the row is filed under, and it is also the first state listed.
  for (const f of staged(input)) add(f, "staged");
  for (const f of tracked(input)) add(f, "unstaged");
  for (const f of untracked(input)) add(f, "untracked");

  const entries = [...byPath.values()].sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) ||
      a.path.localeCompare(b.path),
  );

  const groups = SECTION_ORDER.map((section) => ({
    section,
    entries: entries.filter((e) => e.section === section),
  })).filter((g) => g.entries.length > 0);

  return {
    entries,
    groups,
    totalAdditions: entries.reduce((n, e) => n + e.additions, 0),
    totalDeletions: entries.reduce((n, e) => n + e.deletions, 0),
    partiallyStagedCount: entries.filter((e) => e.states.length > 1).length,
  };
}

/// Deduplicate within one list too.
///
/// libgit2 emits one delta per path, but a rename can produce two entries in
/// pathological histories and the assembly above would then double-count the
/// additions. Cheap to rule out, and the alternative is a total that is
/// silently wrong.
function dedupe(files: readonly FileDiff[]): FileDiff[] {
  const seen = new Set<string>();
  const out: FileDiff[] = [];
  for (const f of files) {
    const path = pathOf(f);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(f);
  }
  return out;
}

function staged(input: { staged: readonly FileDiff[] }): FileDiff[] {
  return dedupe(input.staged);
}

function tracked(input: { unstaged: readonly FileDiff[] }): FileDiff[] {
  return dedupe(input.unstaged).filter((f) => f.status !== "untracked");
}

function untracked(input: { unstaged: readonly FileDiff[] }): FileDiff[] {
  return dedupe(input.unstaged).filter((f) => f.status === "untracked");
}

function renameOf(file: FileDiff): string | null {
  if (!file.oldPath || !file.newPath) return null;
  return file.oldPath === file.newPath ? null : file.oldPath;
}

/// What an untracked file's diff needs said next to it.
///
/// Every line is an addition because there is nothing to diff against — the
/// file is not in the index — and a 400-line file rendered as 400 green lines
/// is indistinguishable from a 400-line rewrite unless something says which it
/// is. Returned as a sentence rather than rendered here so the pure module
/// stays pure and the wording has one home.
export function untrackedExplanation(file: FileDiff): string {
  const n = file.additions;
  return `New file — git has no previous version to compare against, so all ${n} line${
    n === 1 ? "" : "s"
  } are shown as added.`;
}

/// The rows a virtualized list renders.
///
/// Flattened here rather than in the component because the flattening is what
/// makes the list windowable at all, and because "which row is this" is the
/// kind of arithmetic that is worth being able to test without a DOM.
///
/// A collapsed file is exactly one row. That is the property the whole design
/// rests on: a worktree with four hundred changed files is four hundred header
/// rows plus three section rows, and not one hunk is built until a file is
/// opened.
export type CombinedRow =
  | { kind: "section"; section: CombinedSection; count: number; key: string }
  | { kind: "file"; entry: CombinedEntry; expanded: boolean; key: string }
  | { kind: "body"; entry: CombinedEntry; state: CombinedState; stateIndex: number; key: string };

export function combinedRows(
  diff: CombinedDiff,
  isExpanded: (path: string) => boolean,
): CombinedRow[] {
  const rows: CombinedRow[] = [];
  for (const group of diff.groups) {
    rows.push({
      kind: "section",
      section: group.section,
      count: group.entries.length,
      key: `section:${group.section}`,
    });
    for (const entry of group.entries) {
      const expanded = isExpanded(entry.path);
      rows.push({ kind: "file", entry, expanded, key: `file:${entry.path}` });
      if (!expanded) continue;
      entry.states.forEach((state, i) => {
        rows.push({
          kind: "body",
          entry,
          state,
          stateIndex: i,
          key: `body:${entry.path}:${state.section}`,
        });
      });
    }
  }
  return rows;
}
