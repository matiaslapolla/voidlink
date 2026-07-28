/// Noticing that a file changed on disk under an open tab.
///
/// The old behaviour was that models were never re-read: after a checkout or
/// rebase, every open tab still showed the content loaded when it was first
/// opened, and saving it would silently write stale text back over the new
/// commit. That is the bug this closes.
///
/// Detection is a batched `stat` on two discrete events — window focus, and a
/// git ref change — rather than a filesystem watcher. A watcher means a new
/// dependency and an OS handle per open file, to learn something that is only
/// ever acted on at those two moments. Polling twenty stats when the window
/// regains focus is cheaper in every dimension that matters.
///
/// The comparison itself is pure, which is the part worth testing: an mtime
/// with one-second resolution means a same-second rewrite has to be caught by
/// size, and a file that vanished has to read as changed rather than as
/// unchanged-and-missing.

import type { FileStamp } from "@/api/fs";

export type StampMap = Record<string, FileStamp>;

/// Fold a stat batch into a lookup keyed by path.
export function toStampMap(stamps: readonly FileStamp[]): StampMap {
  const out: StampMap = {};
  for (const s of stamps) out[s.path] = s;
  return out;
}

/// True when two stamps describe different content.
///
/// Size is checked as well as mtime because `modified` has one-second
/// resolution on several filesystems, and a script that rewrites a file twice
/// in the same second is exactly the case a git operation produces.
export function stampChanged(before: FileStamp | undefined, after: FileStamp): boolean {
  if (!before) return false; // First observation is the baseline, not a change.
  if (before.exists !== after.exists) return true;
  if (!after.exists) return false;
  return before.modified !== after.modified || before.size !== after.size;
}

/// Paths whose stamp moved between two observations, in the order given.
export function changedPaths(before: StampMap, after: readonly FileStamp[]): string[] {
  return after.filter((s) => stampChanged(before[s.path], s)).map((s) => s.path);
}

/// What to do about each changed file.
///
/// Clean buffers reload silently — the user has no edits to lose and a modal
/// per file during a rebase is the wrong pattern. Dirty buffers are *not*
/// touched; they get an inline bar offering the choice, per buffer, stacking
/// with nothing. MASTER §7.5.5: pick the lowest interruption level that will
/// actually be seen, and a branch switch touching 200 files must produce at
/// most one notice, never 200.
export interface ChangePlan {
  /// Reload these from disk without asking.
  reload: string[];
  /// Show the inline bar on these. They keep their unsaved edits until the
  /// user picks.
  conflicted: string[];
}

export function planForChanges(
  changed: readonly string[],
  isDirty: (path: string) => boolean,
): ChangePlan {
  const plan: ChangePlan = { reload: [], conflicted: [] };
  for (const path of changed) {
    if (isDirty(path)) plan.conflicted.push(path);
    else plan.reload.push(path);
  }
  return plan;
}
