/// The diff renderer's *layout*, mounted in a real browser.
///
/// `diffRows.test.tsx` proves how a hunk's lines become rows as pure data and
/// `HunkNotes.test.tsx` proves the review-note wiring in jsdom. Three things
/// about this component are not data and not wiring — they are the cascade,
/// and each of them would pass in jsdom while being broken on screen:
///
///   * **The hunk toolbar is `opacity-0` until you hover the hunk.** jsdom
///     applies no stylesheet, so a render test can click a control that a real
///     user cannot see. It cannot tell "hidden until hover" from "hidden
///     always" from "never hidden".
///   * **The hunk header is `sticky top-0`.** jsdom implements no sticky
///     positioning and no scrolling at all, so a header that had lost its
///     `sticky` class would sit at exactly the same zeroed coordinates as one
///     that still had it.
///   * **The split view's two columns have to stay in step.** A row is a flex
///     pair whose halves are held at half the row by `flex-1 min-w-0` — the
///     pair of classes that stops one 2000-character line from shoving the
///     right-hand column off screen and desynchronising every line beneath it.
///     With every rect zeroed, "aligned" and "catastrophically misaligned" are
///     the same measurement.
///
/// Every assertion here was checked against a deliberately broken component,
/// which is the only way to know a geometry test is measuring anything: the
/// `min-w-0 overflow-hidden` on the *inner* content span turned out to be
/// removable with all eight still green, so this file names `flex-1` and the
/// cell's own `min-w-0` as what actually holds the layout rather than
/// repeating the class list back at itself.
///
/// The scroll container here is the one `DiffTabView` really wraps this
/// component in (`h-full overflow-auto scrollbar-thin font-mono text-body
/// leading-[1.5]`), copied rather than invented: a sticky test against a
/// container the app does not use would prove sticky works in general, not
/// that it works here.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
/// The browser project's own `userEvent`, not `@testing-library/user-event`.
/// The latter dispatches synthetic pointer events, which move no real cursor
/// and therefore never trigger CSS `:hover` — a hover test built on it would
/// pass or fail for reasons unrelated to the stylesheet. This one goes through
/// Playwright and moves the actual mouse.
import { userEvent } from "vitest/browser";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";

import { DiffRenderer } from "./SplitDiffRenderer";

const CONTAINER_HEIGHT = 300;

function line(
  origin: DiffLine["origin"],
  content: string,
  old_: number | null,
  new_: number | null,
): DiffLine {
  return { origin, content, oldLineno: old_, newLineno: new_ };
}

/// A hunk of `pairs` replaced lines. Each pair's two sides share no word, so
/// `diffWordsWithSpace` yields exactly one segment a side and the content is
/// findable as a single text node — the word-level shading is
/// `diffRows.test.tsx`'s subject, not this file's.
function hunk(name: string, pairs: number, start = 1): DiffHunk {
  const lines: DiffLine[] = [];
  for (let i = 0; i < pairs; i++) {
    lines.push(line("-", `${name}old${i}`, start + i, null));
    lines.push(line("+", `${name}new${i}`, null, start + i));
  }
  return {
    header: `@@ -${start},${pairs} +${start},${pairs} @@ ${name}`,
    oldStart: start,
    oldLines: pairs,
    newStart: start,
    newLines: pairs,
    lines,
  };
}

function file(hunks: DiffHunk[]): FileDiff {
  return {
    oldPath: "src/parse.rs",
    newPath: "src/parse.rs",
    status: "modified",
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks,
  } as FileDiff;
}

/// Mount inside the exact scroll container `DiffTabView` provides. Returns the
/// scroll element, because every assertion below is relative to it.
function mount(
  f: FileDiff,
  mode: "inline" | "split",
  props: Partial<Parameters<typeof DiffRenderer>[0]> = {},
) {
  const { container } = render(() => (
    <div
      style={{ height: `${CONTAINER_HEIGHT}px` }}
      class="overflow-auto scrollbar-thin font-mono text-body leading-[1.5]"
    >
      <DiffRenderer file={f} mode={mode} {...props} />
    </div>
  ));
  const scroll = container.firstElementChild as HTMLDivElement;
  return { container, scroll };
}

/// The `sticky` bar a header span lives in: span → the `flex-1` bar → the
/// sticky row. Walked rather than selected by class, so the test breaks on the
/// structure changing rather than on a restyle.
function headerBar(headerText: string): HTMLElement {
  return screen.getByText(headerText).parentElement!.parentElement!;
}

describe("the hunk toolbar is hidden until you reach for it", () => {
  /// `opacity-0 group-hover:opacity-100 focus-within:opacity-100`. Three
  /// states, one of which is the resting one, and jsdom sees none of them.
  it("is invisible at rest and appears under a real hover", async () => {
    const onStageHunk = vi.fn();
    mount(file([hunk("one", 3)]), "inline", { hunkActions: { onStageHunk } });

    const stage = screen.getByRole("button", { name: "Stage hunk" });
    const toolbar = stage.parentElement!;

    // The load-bearing reading. In jsdom this is `""` — no stylesheet, no
    // computed opacity, and therefore no way to state this fact at all.
    expect(getComputedStyle(toolbar).opacity).toBe("0");

    await userEvent.hover(screen.getByText(/@@ .* one$/));
    await vi.waitFor(() => expect(Number(getComputedStyle(toolbar).opacity)).toBeGreaterThan(0.9));
  });

  /// The same controls have to be reachable without a pointer, which is what
  /// `focus-within` is for. A hover-only reveal is a keyboard dead end.
  it("appears when a control inside it takes focus", async () => {
    const onStageHunk = vi.fn();
    mount(file([hunk("one", 3)]), "inline", { hunkActions: { onStageHunk } });

    const stage = screen.getByRole("button", { name: "Stage hunk" });
    const toolbar = stage.parentElement!;
    expect(getComputedStyle(toolbar).opacity).toBe("0");

    stage.focus();
    await vi.waitFor(() => expect(Number(getComputedStyle(toolbar).opacity)).toBeGreaterThan(0.9));
  });

  /// …and it still *fires* while it is invisible, because a click that lands
  /// on an `opacity-0` element is a click on a live control. The visibility
  /// and the wiring are two separate facts and only the first is geometry.
  it("is still clickable once revealed", async () => {
    const onStageHunk = vi.fn();
    mount(file([hunk("one", 3)]), "inline", { hunkActions: { onStageHunk } });

    await userEvent.click(screen.getByRole("button", { name: "Stage hunk" }));
    expect(onStageHunk).toHaveBeenCalledWith(0);
  });
});

describe("sticky hunk headers", () => {
  /// The header carries the `@@ … @@` context — the file position and the
  /// enclosing function — and a long hunk is exactly the case where you stop
  /// being able to remember which one you are in. Pinning it is the whole
  /// point, and nothing short of a real scroll can observe it.
  it("pins the header to the top of the scroll area as its hunk scrolls past", async () => {
    const { scroll } = mount(file([hunk("one", 60)]), "inline");
    const bar = headerBar("@@ -1,60 +1,60 @@ one");

    const restingTop = bar.getBoundingClientRect().top;
    const containerTop = scroll.getBoundingClientRect().top;
    // At rest the header is at the very top anyway, so the control for this
    // test is that the container has real height and really scrolls.
    expect(Math.abs(restingTop - containerTop)).toBeLessThan(2);
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight + 100);

    scroll.scrollTop = 400;
    await vi.waitFor(() => {
      // Still flush with the container's top after scrolling 400px into the
      // hunk. Without `sticky` it would be 400px above it and off screen.
      expect(Math.abs(bar.getBoundingClientRect().top - containerTop)).toBeLessThan(2);
    });
    // And it is genuinely mid-hunk now: rows that started below the fold are
    // level with the header.
    expect(scroll.scrollTop).toBe(400);
  });

  /// Two hunks, one sticky slot. The second header does not stack on top of
  /// the first — it pushes it out, which is what makes a long file readable
  /// rather than accumulating a pile of pinned bars.
  it("hands the pinned slot from one hunk's header to the next", async () => {
    const { scroll } = mount(file([hunk("one", 60), hunk("two", 60, 200)]), "inline");
    const first = headerBar("@@ -1,60 +1,60 @@ one");
    const second = headerBar("@@ -200,60 +200,60 @@ two");
    const containerTop = scroll.getBoundingClientRect().top;

    // Deep enough that the second header has arrived at the top and the first
    // has been pushed above it.
    scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
    await vi.waitFor(() => {
      expect(Math.abs(second.getBoundingClientRect().top - containerTop)).toBeLessThan(2);
    });
    // The first header is above the container — displaced, not stacked.
    expect(first.getBoundingClientRect().bottom).toBeLessThanOrEqual(containerTop + 2);
  });
});

describe("split alignment", () => {
  /// The two halves of a replaced line are two separate DOM subtrees inside
  /// one flex row. Their staying level is what makes the side-by-side view
  /// readable, and it is a fact about layout: `flex-1` on both cells and
  /// `whitespace-pre` on the row.
  it("keeps the two sides of every pair on the same line", () => {
    mount(file([hunk("one", 8)]), "split");

    for (let i = 0; i < 8; i++) {
      const left = screen.getByText(`oneold${i}`).getBoundingClientRect();
      const right = screen.getByText(`onenew${i}`).getBoundingClientRect();
      expect(Math.abs(left.top - right.top)).toBeLessThan(2);
      expect(Math.abs(left.height - right.height)).toBeLessThan(2);
      // Left really is on the left — the assertion that separates a working
      // split view from one whose columns collapsed on top of each other.
      expect(left.right).toBeLessThanOrEqual(right.left + 1);
    }
  });

  /// `flex-1` on both cells, which is what makes each column *half the row*
  /// rather than as wide as whatever happens to be in it. Asserted against the
  /// row's own width and not merely against each other: two cells that both
  /// sized to their content would also be "the same width" as each other on a
  /// row whose two sides happen to be similar, and that is the reading this
  /// test was passing under before it was falsified.
  it("gives each column half the row, not the width of its own content", () => {
    mount(file([hunk("one", 4)]), "split");

    const leftCell = screen.getByText("oneold0").parentElement!.parentElement!;
    const rightCell = screen.getByText("onenew0").parentElement!.parentElement!;
    const row = leftCell.parentElement!.getBoundingClientRect();
    const left = leftCell.getBoundingClientRect();
    const right = rightCell.getBoundingClientRect();

    expect(row.width).toBeGreaterThan(200);
    // Half the row each, less the 1px divider. A 4px tolerance absorbs
    // subpixel rounding, not a column that took two thirds.
    expect(Math.abs(left.width - row.width / 2)).toBeLessThan(4);
    expect(Math.abs(right.width - row.width / 2)).toBeLessThan(4);
    expect(right.left - left.right).toBeGreaterThan(0);
  });

  /// The finding this file exists for. One pathological line — minified
  /// output, a base64 blob, a generated bundle — is `min-w-0 overflow-hidden`'s
  /// entire job: without them the flex cell refuses to shrink below its
  /// content, the row grows to thousands of pixels, and every line beneath it
  /// is measured against a row box that no longer matches its neighbours.
  it("survives a 2000-character line without pushing the right column off", () => {
    const long = hunk("one", 5);
    // Replace one pair's left side with something absurd, keeping it a single
    // word so it cannot wrap even if `whitespace-pre` were lost.
    long.lines[4] = line("-", "X".repeat(2000), 3, null);
    long.lines[5] = line("+", "onenew2", null, 3);
    mount(file([long]), "split");

    const before = screen.getByText("onenew1").getBoundingClientRect();
    const beside = screen.getByText("onenew2").getBoundingClientRect();
    const after = screen.getByText("onenew3").getBoundingClientRect();

    // The right column's left edge does not move for the row with the monster
    // line in it. This is the assertion that fails the moment the cell is
    // allowed to size to its content.
    expect(Math.abs(beside.left - before.left)).toBeLessThan(2);
    expect(Math.abs(after.left - before.left)).toBeLessThan(2);

    // …and the rows below it are still evenly spaced, i.e. the long row did
    // not grow taller either.
    const rowHeight = beside.top - before.top;
    expect(rowHeight).toBeGreaterThan(2);
    expect(Math.abs(after.top - beside.top - rowHeight)).toBeLessThan(2);
  });
});
