import type { GraphCommit } from "@/types/history";

/// A drawn segment in the gutter, expressed in column coordinates. It spans
/// the gap between one row and the next: `top` is the column at the upper
/// row, `bottom` the column at the lower row. Equal columns render as a
/// vertical; different columns render as a one-row diagonal (the classic
/// railroad "kink").
export interface LaneSegment {
  top: number;
  bottom: number;
  /// The lane's colour index: the column the lane itself occupies.
  ///
  /// Not `top`, and deliberately so — a connector drawn from a merge commit's
  /// dot into an existing lane has a `top` of the dot's column but belongs to
  /// the lane it is joining, and should be stroked in that lane's colour. A
  /// lane never changes column once allocated (the trim below only ever drops
  /// trailing nulls), so this is stable for the lane's whole life.
  lane: number;
}

/// Per-commit layout result: the column its dot sits in, plus the segments
/// drawn in the gap *below* this row (down to the next row).
export interface GraphRow {
  commit: GraphCommit;
  col: number;
  segments: LaneSegment[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /// Number of columns in use — drives the gutter width.
  maxCols: number;
  /// Lanes still carrying an unreached parent after the last row.
  ///
  /// Non-empty means the window ends mid-history: those lines continue into
  /// commits we did not fetch. The last row used to emit no segments at all
  /// (`if (i < n - 1)`), so every in-flight lane simply stopped one row early
  /// with nothing distinguishing "history ends here" from "we asked for 200".
  /// The UI draws these to the bottom edge and fades them.
  truncatedLanes: number[];
}

/// Find the first free (null) lane slot, or the end of the array.
function firstFree(lanes: (string | null)[]): number {
  const idx = lanes.indexOf(null);
  return idx === -1 ? lanes.length : idx;
}

/// Single-pass lane router over commits ordered child-before-parent
/// (topological). For each commit we:
///   1. find the column its dot occupies (an incoming lane waiting on its
///      oid, or a fresh lane for a branch tip),
///   2. hand the commit's column to its first parent and allocate lanes for
///      any additional parents (merges), reusing a lane already routed to
///      that parent,
///   3. record the lane state so a second pass can draw the gutter.
///
/// `lanes[k]` holds the oid the k-th column is *waiting to reach*. Because a
/// parent keeps its assigned column until it is itself reached, the column
/// we route a parent to is exactly where its dot will later render — so
/// edges connect correctly across the whole DAG.
///
/// One thing this deliberately does *not* promise: that the first parent
/// inherits the commit's own column. When some other child already opened a
/// lane to that parent, the commit connects sideways into that lane instead,
/// because two columns waiting on the same oid would draw the same commit
/// twice. So the mainline is usually vertical and is not guaranteed to be.
export function computeLanes(commits: GraphCommit[]): GraphLayout {
  const n = commits.length;
  // Snapshot of lane occupancy leaving each row (i.e. entering the next).
  const laneStates: (string | null)[][] = new Array(n);

  // A commit's dot relates to a column below it in one of two ways, and
  // collapsing them into a single set is what used to break every fork point
  // in every repository.
  //
  //   `sprang`  — the lane in this column was created by this dot. Nothing was
  //               flowing through that column above this row, so the gap holds
  //               exactly one segment and it starts at the dot.
  //
  //   `joined`  — the lane was already there, routed to the same parent by an
  //               earlier child, and this dot *also* connects into it. The gap
  //               needs *two* segments: the pass-through that was already
  //               flowing down that column, plus the connector from this dot.
  //
  // Emitting one segment for a `joined` column overwrote the pass-through with
  // the connector, so the earlier child's edge to the shared parent simply
  // stopped in mid-air at this row. Against this repository's own history that
  // was 12 broken edges in 155 rows.
  const sprang: Set<number>[] = new Array(n);
  const joined: Set<number>[] = new Array(n);
  const cols: number[] = new Array(n);

  let lanes: (string | null)[] = [];
  let maxCols = 0;

  for (let i = 0; i < n; i++) {
    const c = commits[i];

    // 1. Column of this commit's dot.
    let col = lanes.indexOf(c.oid);
    if (col === -1) {
      // Branch tip not yet referenced by any child — open a new lane.
      col = firstFree(lanes);
      if (col === lanes.length) lanes.push(null);
    }

    // 2. Clear every lane that was waiting on this commit (merges converge
    //    here) then route the parents.
    const after = lanes.slice();
    for (let k = 0; k < after.length; k++) {
      if (after[k] === c.oid) after[k] = null;
    }

    const sprangHere = new Set<number>();
    const joinedHere = new Set<number>();
    c.parentOids.forEach((p, pi) => {
      const existing = after.indexOf(p);
      if (existing !== -1) {
        // A lane already heads to this parent — another child reached it
        // first, or an earlier entry in our own parent list did (a merge can
        // legitimately list the same oid twice). Connect into it rather than
        // opening a second lane to the same commit.
        //
        // `sprangHere` wins: if *we* created that lane a moment ago it is not
        // a pass-through, and recording it as joined would draw the connector
        // twice on top of itself.
        if (!sprangHere.has(existing)) joinedHere.add(existing);
        return;
      }
      if (pi === 0) {
        // The first parent continues this dot's own column, which is what
        // keeps a linear history drawing as one straight line.
        //
        // Except when the branch above already claimed it — the `existing`
        // path returned above. The mainline then bends into that lane instead
        // of staying vertical, which is not a bug to fix but a fact to state:
        // two children of one parent cannot both keep their column, and the
        // one that got there first owns it. The connector is drawn either way
        // (see `joined`), so the edge is complete; it is diagonal rather than
        // straight. Trying to move a claimed lane sideways instead would
        // strand the earlier child's already-emitted segments in the old
        // column — a broken edge, which is strictly worse than a kink.
        after[col] = p;
        sprangHere.add(col);
      } else {
        const k = firstFree(after);
        if (k === after.length) after.push(null);
        after[k] = p;
        sprangHere.add(k);
      }
    });

    cols[i] = col;
    sprang[i] = sprangHere;
    joined[i] = joinedHere;
    laneStates[i] = after;
    maxCols = Math.max(maxCols, lanes.length, after.length);

    // Trim trailing nulls so lane arrays stay compact for the next row.
    while (after.length > 0 && after[after.length - 1] === null) after.pop();
    lanes = after;
  }

  // 3. Second pass: turn lane states into drawable segments per gap.
  const rows: GraphRow[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const segments: LaneSegment[] = [];
    if (i < n - 1) {
      const state = laneStates[i];
      const nextOid = commits[i + 1].oid;
      const nextCol = cols[i + 1];
      for (let k = 0; k < state.length; k++) {
        const oid = state[k];
        if (oid == null) continue;
        // Where the lane connects at the bottom: converge onto the next dot if
        // that's the commit we're waiting for, else stay in its column.
        const bottom = oid === nextOid ? nextCol : k;
        if (sprang[i].has(k)) {
          // Created by this dot, so there is nothing above to pass through.
          segments.push({ top: cols[i], bottom, lane: k });
        } else {
          // The lane's own continuation. It flows through this row whether or
          // not our dot has anything to do with it.
          segments.push({ top: k, bottom, lane: k });
          // …and, if our dot also feeds this lane, the connector into it. Both
          // land on the same `bottom`, which is what makes them read as a
          // merge rather than as two unrelated lines.
          if (joined[i].has(k)) {
            segments.push({ top: cols[i], bottom, lane: k });
          }
        }
      }
    } else {
      // The last row. Every lane still occupied here is waiting on a parent
      // outside the window, so its line genuinely continues — it is drawn to
      // the bottom edge rather than stopped, and reported in `truncatedLanes`
      // so the UI can fade it and say the history is cut off.
      //
      // A lane the *last dot itself* created gets its segment from the dot, so
      // the line leaves the dot rather than materialising beside it.
      for (let k = 0; k < laneStates[i].length; k++) {
        if (laneStates[i][k] == null) continue;
        segments.push({ top: sprang[i].has(k) ? cols[i] : k, bottom: k, lane: k });
      }
    }
    rows[i] = { commit: commits[i], col: cols[i], segments };
  }

  const truncatedLanes: number[] = [];
  if (n > 0) {
    const last = laneStates[n - 1];
    for (let k = 0; k < last.length; k++) {
      if (last[k] != null) truncatedLanes.push(k);
    }
  }

  return { rows, maxCols: Math.max(1, maxCols), truncatedLanes };
}

/// Which rows the gutter has to draw, given the window the virtualizer is
/// showing. Inclusive, clamped, and **one row wider on each side**.
///
/// The widening is the whole reason this is a named function with tests rather
/// than two `Math.max` calls inline. A lane segment is drawn *from* row `i` *to*
/// row `i+1`, so a gutter that drew exactly the visible rows would be missing
/// the edge entering the top of the viewport and the one leaving the bottom —
/// the graph would appear severed at both ends, and only while scrolling, which
/// is the hardest kind of rendering bug to catch by looking.
///
/// Pure and exported because jsdom has no layout engine and therefore cannot
/// exercise the virtualizer at all: this is the part of the windowing that can
/// be proven without a browser.
export function gutterRange(
  rowCount: number,
  firstVisible: number,
  lastVisible: number,
): [number, number] {
  if (rowCount <= 0) return [0, -1];
  return [
    Math.max(0, firstVisible - 1),
    Math.min(rowCount - 1, lastVisible + 1),
  ];
}
