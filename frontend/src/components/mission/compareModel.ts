/// Comparing the legs of a fan-out.
///
/// ## The question this answers
///
/// A fan-out asks N agents the same question and gets N branches back. The
/// mechanism was the easy half; the hard half is *choosing*, and until this
/// existed choosing meant opening N compare tabs and holding three diffs in your
/// head. That costs more time than the fan-out saved, which is the same as the
/// feature not working.
///
/// Per-leg counts alone do not help. Two legs both reporting "3 files, +40 −12"
/// are in completely different situations depending on whether it is the same
/// three files. So the unit here is the **file**, and the matrix is files × legs.
///
/// ## What it reports, and why those three things
///
///   * **Agreement.** Files every finished leg touched. If three agents
///     independently edited the same file, that file is almost certainly where
///     the change belongs, and a leg that *skipped* it is the one to look at
///     hardest.
///   * **Divergence.** Files only one leg touched. This is where the approaches
///     actually differ, and it is the shortest possible reading list — usually
///     two or three files out of thirty.
///   * **Size**, per leg, which is the tie-breaker rather than the headline. The
///     smallest diff that touches the agreed files is a good default answer, and
///     saying that out loud is more useful than a bar chart of line counts.
///
/// ## What is deliberately absent
///
/// **"Tests passed" is not here.** The plan called for it, and it would be the
/// single most useful column — but nothing in this app runs a leg's tests, and
/// there is no per-project notion of what the test command even is. A column
/// populated by guessing (looking for a `test` script, running it, hoping) would
/// be wrong often enough to make people distrust the columns that are right.
/// Recorded as a gap rather than faked; it wants a real test-runner integration,
/// which is its own piece of work.
///
/// Pure, and tested as such. The comparison is the part of this feature most
/// likely to be quietly wrong, and it is exactly the kind of thing that is
/// miserable to verify through a mounted component.

import { isLegDone, type FanoutRun, type RunLeg } from "@/store/fanout";

/// One leg, reduced to what the comparison needs.
export interface LegColumn {
  legId: string;
  agentName: string;
  branch: string;
  status: RunLeg["status"];
  /// `null` when the leg produced no measurement — it failed, was stopped, or
  /// the stat could not be taken. Distinct from a zero-file stat, which means
  /// "it ran and changed nothing", a genuinely different answer.
  files: number | null;
  additions: number;
  deletions: number;
  /// Files this leg touched, sorted.
  paths: string[];
  /// Files no other measured leg touched.
  uniquePaths: string[];
}

/// One file, and which legs touched it.
export interface FileRow {
  path: string;
  /// Leg ids, in column order.
  touchedBy: string[];
  /// Every measured leg touched it.
  shared: boolean;
}

export interface RunComparison {
  /// Legs with a measurement, in the run's own order. A leg that failed is not
  /// a column: it has nothing to compare, and a column of blanks reads as "this
  /// agent chose to change nothing".
  columns: LegColumn[];
  /// Legs that finished or died without a measurement, kept separately so the
  /// surface can say what happened to them rather than silently omitting them.
  unmeasured: { legId: string; agentName: string; status: RunLeg["status"] }[];
  /// Union of every measured leg's files. Agreement first, then by how many legs
  /// touched the file, then alphabetically — the reading order the section
  /// recommends.
  rows: FileRow[];
  /// Files every measured leg touched.
  sharedCount: number;
  /// Whether there is anything to compare at all: two or more measured legs.
  comparable: boolean;
}

/// Reduce a run to its comparison. Pure.
export function compareRun(run: FanoutRun): RunComparison {
  const columns: LegColumn[] = [];
  const unmeasured: RunComparison["unmeasured"] = [];

  for (const leg of run.legs) {
    if (leg.stat) {
      columns.push({
        legId: leg.id,
        agentName: leg.agentName,
        branch: leg.branch,
        status: leg.status,
        files: leg.stat.files,
        additions: leg.stat.additions,
        deletions: leg.stat.deletions,
        paths: [...leg.stat.paths].sort(),
        uniquePaths: [],
      });
    } else if (isLegDone(leg.status)) {
      unmeasured.push({ legId: leg.id, agentName: leg.agentName, status: leg.status });
    }
    // A leg still running is neither: it will become one or the other, and
    // listing it as "unmeasured" now would read as a verdict on work in flight.
  }

  // How many measured legs touched each path.
  const touched = new Map<string, string[]>();
  for (const column of columns) {
    for (const path of column.paths) {
      const list = touched.get(path);
      if (list) list.push(column.legId);
      else touched.set(path, [column.legId]);
    }
  }

  const measured = columns.length;
  const rows: FileRow[] = [...touched.entries()]
    .map(([path, legIds]) => ({
      path,
      touchedBy: legIds,
      // "Every leg" is only meaningful with more than one. With a single
      // measured leg every file it touched would be trivially "shared", which
      // would highlight the entire diff and mean nothing.
      shared: measured > 1 && legIds.length === measured,
    }))
    .sort(
      (a, b) =>
        Number(b.shared) - Number(a.shared) ||
        b.touchedBy.length - a.touchedBy.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );

  for (const column of columns) {
    column.uniquePaths = rows
      .filter((r) => r.touchedBy.length === 1 && r.touchedBy[0] === column.legId)
      .map((r) => r.path);
  }

  return {
    columns,
    unmeasured,
    rows,
    sharedCount: rows.filter((r) => r.shared).length,
    comparable: measured > 1,
  };
}

/// Files a **majority** of measured legs touched.
///
/// Distinct from `FileRow.shared`, and the distinction is load-bearing rather
/// than a nuance. `shared` means *every* measured leg, which is the honest thing
/// to display — but it is useless as the basis of a recommendation, because it
/// is circular: a leg that skipped a file removes that file from the set, so no
/// leg can ever be penalised for skipping anything. The first version of
/// `suggestedLeg` did exactly that and happily recommended the leg that had done
/// the least work.
///
/// A majority breaks the circle. If two of three agents edited `parser.ts` and
/// the third did not, `parser.ts` is consensus and the third leg is the one that
/// has to justify itself.
export function consensusPaths(comparison: RunComparison): string[] {
  const measured = comparison.columns.length;
  return comparison.rows
    .filter((r) => r.touchedBy.length * 2 > measured)
    .map((r) => r.path);
}

/// The leg worth looking at first, or `null` when the comparison cannot pick
/// one.
///
/// **The smallest measured diff that touches every agreed file.** Not "the
/// smallest", which rewards a leg that did less of the job, and not "the
/// largest", which rewards thrash. Covering the files every other leg also
/// touched is the closest thing to evidence that a leg did the work; among those
/// that did, fewer lines is the better default.
///
/// A *suggestion*, and the surface has to label it as one. Presenting a heuristic
/// over line counts as a judgement about correctness is the same lie as an
/// unmarked inferred attribution, and the same rule applies.
export function suggestedLeg(comparison: RunComparison): string | null {
  if (!comparison.comparable) return null;

  const consensus = consensusPaths(comparison);
  const covering = comparison.columns.filter((c) =>
    consensus.every((path) => c.paths.includes(path)),
  );
  // With no consensus at all, every leg trivially covers the empty set and the
  // choice would come down to size alone — which is not a recommendation, it is
  // a coin toss with a number on it.
  const pool = consensus.length > 0 ? covering : [];
  if (pool.length === 0) return null;

  let best = pool[0];
  for (const c of pool.slice(1)) {
    const size = (x: LegColumn) => x.additions + x.deletions;
    if (size(c) < size(best)) best = c;
  }
  return best.legId;
}

/// One line saying what the comparison found, for the section header.
///
/// Prose rather than three numbers in boxes: the useful output of a comparison
/// is a sentence a person can act on, and "4 files in common, 2 where they
/// differ" is the whole finding.
export function comparisonSummary(comparison: RunComparison): string {
  if (!comparison.comparable) {
    return comparison.columns.length === 1
      ? "Only one leg produced a diff — nothing to compare it against."
      : "No leg produced a diff yet.";
  }
  const differing = comparison.rows.length - comparison.sharedCount;
  const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  if (comparison.sharedCount === 0) {
    return `No file was touched by every leg — the ${comparison.columns.length} approaches do not overlap.`;
  }
  if (differing === 0) {
    return `Every leg touched the same ${files(comparison.sharedCount)}.`;
  }
  return `${files(comparison.sharedCount)} touched by every leg, ${differing} where they differ.`;
}
