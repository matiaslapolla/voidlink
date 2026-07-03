import type { GraphCommit } from "@/types/history";

/// A drawn segment in the gutter, expressed in column coordinates. It spans
/// the gap between one row and the next: `top` is the column at the upper
/// row, `bottom` the column at the lower row. Equal columns render as a
/// vertical; different columns render as a one-row diagonal (the classic
/// railroad "kink").
export interface LaneSegment {
  top: number;
  bottom: number;
  /// The lane's colour index (its column at the top), used so a lane keeps
  /// a stable colour as it shifts across columns.
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
export function computeLanes(commits: GraphCommit[]): GraphLayout {
  const n = commits.length;
  // Snapshot of lane occupancy leaving each row (i.e. entering the next).
  const laneStates: (string | null)[][] = new Array(n);
  // Columns at each row whose lane originated from *this* commit's dot
  // (its parents) — those edges start at the dot, not straight down.
  const dotOrigin: Set<number>[] = new Array(n);
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

    const origin = new Set<number>();
    c.parentOids.forEach((p, pi) => {
      const existing = after.indexOf(p);
      if (existing !== -1) {
        // A lane already heads to this parent (another child reached it
        // first) — merge into it. The connector still starts at our dot.
        origin.add(existing);
        return;
      }
      if (pi === 0) {
        after[col] = p;
        origin.add(col);
      } else {
        const k = firstFree(after);
        if (k === after.length) after.push(null);
        after[k] = p;
        origin.add(k);
      }
    });

    cols[i] = col;
    dotOrigin[i] = origin;
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
        // Where the lane connects at the top of the gap: its own column,
        // unless it just sprang from this commit's dot.
        const top = dotOrigin[i].has(k) ? cols[i] : k;
        // Where it connects at the bottom: converge onto the next dot if
        // that's the commit we're waiting for, else stay in its column.
        const bottom = oid === nextOid ? nextCol : k;
        segments.push({ top, bottom, lane: k });
      }
    }
    rows[i] = { commit: commits[i], col: cols[i], segments };
  }

  return { rows, maxCols: Math.max(1, maxCols) };
}
