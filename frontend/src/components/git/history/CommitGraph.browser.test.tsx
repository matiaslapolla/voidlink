/// The commit graph's *paint*, mounted in a real browser.
///
/// `lanes.test.ts` proves the lane-routing algorithm — which column a commit's
/// dot sits in, which segments connect it to its parents — as pure data. It
/// has never been proven that `CommitGraph.tsx` actually paints a row and a
/// gutter dot where that algorithm says: the rows are absolutely positioned
/// `<div>`s, the gutter is an absolutely positioned `<svg>` overlay drawn
/// separately, and above `VIRTUALIZE_ABOVE` (60) rows only a windowed slice of
/// each exists in the DOM at all (GRAPH-P4). None of that is checkable in
/// jsdom: `getBoundingClientRect` returns zeroes for every element, so a row
/// and a gutter dot both sitting at `(0, 0)` would look identical to them
/// sitting at their real, correct, *different* positions — and jsdom has no
/// `overflow` clipping or `scrollTop` layout at all, so windowing could never
/// be observed doing anything.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { mockTauri } from "@/test/tauri";
import type { GraphCommit } from "@/types/history";
import { CommitGraph } from "./CommitGraph";

/// A linear single-lane chain, newest first — `chain(5)` is
/// `c0 -> c1 -> c2 -> c3 -> c4`, each the sole parent of the one before it.
/// One lane keeps the gutter's x coordinate constant across every row, which
/// is what lets the alignment test below check "the dot is under the row"
/// without also re-deriving the lane router's column math.
function chain(n: number): GraphCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    oid: `commit-${i}`,
    shortOid: `c${i}`,
    summary: `commit ${i}`,
    authorName: "Test",
    authorTime: 0,
    commitTime: 0,
    parentOids: i + 1 < n ? [`commit-${i + 1}`] : [],
    refs: [],
    isHead: false,
  }));
}

function mount(commits: GraphCommit[], heightPx?: number) {
  mockTauri({
    git_commit_graph: () => commits,
  });
  const utils = render(() => (
    <div style={heightPx ? { height: `${heightPx}px` } : undefined}>
      <CommitGraph repoPath="/repo" />
    </div>
  ));
  return utils;
}

describe("paint: rows and gutter agree on where a row is", () => {
  it("rows are stacked at real, distinct, evenly-spaced screen positions", async () => {
    mount(chain(8));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(8));

    const rows = screen.getAllByRole("option");
    const tops = rows.map((r) => r.getBoundingClientRect().top);
    const rowHeight = tops[1] - tops[0];

    // The load-bearing assertion: a real row height. In jsdom this is `0 - 0`
    // and the test would pass having proven nothing.
    expect(rowHeight).toBeGreaterThan(10);

    // Every row lands exactly `rowHeight` below the last — the fixed-height
    // absolute positioning `CommitGraph` uses (`y = index * ROW_H`), read back
    // off real layout rather than asserted from the source. A 2px tolerance
    // absorbs subpixel rounding, not a wrong row.
    for (let i = 0; i < tops.length; i++) {
      expect(Math.abs(tops[i] - tops[0] - i * rowHeight)).toBeLessThan(2);
    }
  });

  it("a gutter dot renders centred on its own row, not just at (0, 0)", async () => {
    const { container } = mount(chain(6));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(6));

    const rows = screen.getAllByRole("option");
    // Scoped to the gutter overlay specifically (`pointer-events-none` is
    // unique to it in this tree) — the header's `GitCommitHorizontal` icon is
    // itself an SVG built from a `<circle>`, and an unscoped query counts it
    // as a seventh dot.
    const gutter = container.querySelector("svg.pointer-events-none") as SVGSVGElement;
    // `isHead` is false on every fixture commit, so exactly one <circle> per
    // row — no head ring to filter out — in the same top-to-bottom order the
    // rows render in.
    const dots = Array.from(gutter.querySelectorAll("circle"));
    expect(dots).toHaveLength(6);

    const containerLeft = container.getBoundingClientRect().left;

    dots.forEach((dot, i) => {
      const dotRect = dot.getBoundingClientRect();
      const rowRect = rows[i].getBoundingClientRect();
      const dotCenterY = dotRect.top + dotRect.height / 2;
      const rowCenterY = rowRect.top + rowRect.height / 2;
      // The SVG overlay and the row list are two separate DOM subtrees kept
      // in sync only by both computing `index * ROW_H`. If they ever drifted
      // — a windowing edge case, an off-by-one in `gutterRange` — this is the
      // assertion that would catch it and a coordinate-free jsdom test could
      // not.
      expect(Math.abs(dotCenterY - rowCenterY)).toBeLessThan(3);
      // Single lane: every dot sits at the same real x, and — the part
      // getBoundingClientRect-returns-zero can't fake — measurably to the
      // right of the container's own edge, where the gutter's left padding
      // put it.
      expect(dotRect.left - containerLeft).toBeGreaterThan(5);
    });
  });
});

describe("windowing above 60 rows (GRAPH-P4)", () => {
  it("renders every row when the list is short", async () => {
    mount(chain(12), 500);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(12));
    // Below VIRTUALIZE_ABOVE, `CommitGraph` takes the unwindowed branch. This
    // is the control: the windowed test below only means something set
    // against "everything renders when nothing is windowed".
    expect(screen.getByText("c0")).toBeInTheDocument();
    expect(screen.getByText("c11")).toBeInTheDocument();
  });

  it("mounts only a slice of a long history, and the slice tracks real scroll position", async () => {
    const commits = chain(300);
    const { container } = mount(commits, 500);

    await waitFor(() => expect(screen.getByText("c0")).toBeInTheDocument());

    // A real scroll container: fixed height from the wrapper above, `flex-1`
    // and `overflow-auto` from `CommitGraph`'s own classes, compiled for real
    // by the Tailwind plugin this project loads. None of that clips or
    // scrolls in jsdom, which is exactly why this file cannot live in the
    // `render` project.
    const scrollEl = container.querySelector(".overflow-auto") as HTMLDivElement;
    expect(scrollEl).toBeTruthy();

    const initialRows = screen.getAllByRole("option").length;
    // Overscan is 12 rows either side of a ~17-row viewport (500px / 30px
    // rows) — comfortably under half of 300, and comfortably over zero.
    expect(initialRows).toBeGreaterThan(5);
    expect(initialRows).toBeLessThan(100);
    expect(screen.queryByText("c299")).not.toBeInTheDocument();

    // Scroll deep into the list and let the virtualizer's own scroll listener
    // — not this test — decide what is now visible.
    scrollEl.scrollTop = 200 * 30;
    scrollEl.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(screen.getByText("c200")).toBeInTheDocument());
    // The row that used to be at the top is gone: proof the earlier rows were
    // actually unmounted, not merely scrolled out of a viewport nothing here
    // is clipping.
    expect(screen.queryByText("c0")).not.toBeInTheDocument();

    // The newly-mounted row's *real* offset inside the virtualizer's content
    // box still equals `index * rowHeight` — windowing changed which rows
    // exist, not the coordinate system they exist in.
    const row200 = screen.getByText("c200").closest('[role="option"]') as HTMLElement;
    const rowHeight = row200.getBoundingClientRect().height;
    const itemWrapper = row200.parentElement as HTMLElement; // the translateY(...) div
    const listBox = itemWrapper.parentElement as HTMLElement; // the full-height content box
    const offset = itemWrapper.getBoundingClientRect().top - listBox.getBoundingClientRect().top;
    expect(Math.abs(offset - 200 * rowHeight)).toBeLessThan(2);
  });
});
