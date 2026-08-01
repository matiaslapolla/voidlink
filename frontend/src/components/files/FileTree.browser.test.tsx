/// The file tree's windowed list, mounted in a real browser.
///
/// This is the last of the four `@tanstack/solid-virtual` surfaces and the one
/// with the most to prove, because it is the only one that *measures* rather
/// than estimating: `ref={virtualizer.measureElement}` on every row means the
/// virtualizer reads each mounted row's real height back and corrects its
/// offsets from it. In jsdom every one of those reads is `0`, so the
/// virtualizer is told the whole list is zero pixels tall and renders nothing
/// — which is exactly why `src/test/layout.ts` exists, and exactly why the
/// stubs it installs cannot make an assertion about *where* a row landed mean
/// anything (its own header says so).
///
/// There is no `VIRTUALIZE_ABOVE` escape hatch here as there is in
/// `CommitGraph` and `GitSidebar`'s `VirtualFileList`: this list is always
/// windowed, so "the rows that are not on screen do not exist" is the resting
/// state of the component rather than a mode it enters.
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@solidjs/testing-library";
import { mockTauri } from "@/test/tauri";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import type { FsEntry } from "@/api/fs";

import { FileTree } from "./FileTree";

const ROOT = "/repo";
const VIEWPORT = 400;

function entry(name: string, isDir = false): FsEntry {
  return {
    name,
    path: `${ROOT}/${name}`,
    isDir,
    size: 0,
    modified: null,
    ignored: false,
  };
}

/// `n` flat files, zero-padded so their names sort the way their indices do —
/// the tree sorts by name, and a test that asserted on "file 200" would
/// otherwise be asserting against `file-2`.
function files(n: number): FsEntry[] {
  return Array.from({ length: n }, (_, i) => entry(`f${String(i).padStart(4, "0")}.ts`));
}

function mount(entries: FsEntry[]) {
  mockTauri({
    fs_list_dir: entries,
    // Read once on mount to resolve the trunk for "Compare with …".
    git_list_branches: [],
  });
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <div style={{ height: `${VIEWPORT}px`, display: "flex", "flex-direction": "column" }}>
        <FileTree root={ROOT} />
      </div>
    </AppStoreContext.Provider>
  ));
  return { container, store };
}

/// The scroll element. `flex-1 min-h-0 overflow-y-auto` — three classes that
/// together are the entire reason this list clips and scrolls at all, and
/// which the browser project's Tailwind plugin compiles for real.
function scrollElementOf(container: HTMLElement): HTMLDivElement {
  return container.querySelector(".overflow-y-auto") as HTMLDivElement;
}

describe("windowing", () => {
  /// The control. A short list mounts entirely, so the long-list assertion
  /// below means "windowed" rather than "the fixture never rendered".
  it("mounts every row of a short list", async () => {
    const { container } = mount(files(8));
    await waitFor(() => expect(screen.getByText("f0000.ts")).toBeInTheDocument());
    expect(screen.getByText("f0007.ts")).toBeInTheDocument();

    const scroll = scrollElementOf(container);
    // Nothing to scroll: the list is shorter than its viewport.
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 2);
  });

  it("mounts only a slice of a 500-file directory", async () => {
    const { container } = mount(files(500));
    await waitFor(() => expect(screen.getByText("f0000.ts")).toBeInTheDocument());

    const scroll = scrollElementOf(container);
    expect(scroll.clientHeight).toBeGreaterThan(100);
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight * 5);

    // A ~16-row viewport plus 12 rows of overscan either side. Comfortably
    // under 500, comfortably over zero — the two ways windowing breaks.
    const mounted = screen.getAllByRole("button").length;
    expect(mounted).toBeGreaterThan(5);
    expect(mounted).toBeLessThan(120);
    expect(screen.queryByText("f0499.ts")).not.toBeInTheDocument();
  });

  /// The virtualizer's own scroll listener decides what exists — this test
  /// only moves `scrollTop`, which is a thing jsdom has no layout for and
  /// therefore cannot trigger.
  it("swaps the mounted slice as the list is really scrolled", async () => {
    const { container } = mount(files(500));
    await waitFor(() => expect(screen.getByText("f0000.ts")).toBeInTheDocument());
    const scroll = scrollElementOf(container);

    const rowHeight = screen.getByText("f0001.ts").getBoundingClientRect().top -
      screen.getByText("f0000.ts").getBoundingClientRect().top;
    // The tell. In jsdom this is `0 - 0`.
    expect(rowHeight).toBeGreaterThan(10);

    scroll.scrollTop = 300 * rowHeight;
    scroll.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(screen.getByText("f0300.ts")).toBeInTheDocument());
    // The row that used to be at the top was genuinely unmounted, not merely
    // scrolled out of a viewport nothing is clipping.
    expect(screen.queryByText("f0000.ts")).not.toBeInTheDocument();
  });

  /// `measureElement` is what separates this list from the other three: the
  /// virtualizer reads each mounted row's real height back rather than
  /// trusting its `estimateSize` of 24. If that read ever returned zero — which
  /// is exactly what jsdom returns — every offset would collapse and the rows
  /// would stack on top of each other at the top of the spacer.
  ///
  /// Deliberately *not* asserted as `index × rowHeight`: with dynamic
  /// measurement an offset is the running sum of measured heights for the
  /// rows already seen and estimates for the rest, so a deep row is a few
  /// hundred pixels off that product by design. The invariant that does hold
  /// is that the mounted rows are stacked, in order, one real row height
  /// apart — and that is also the one a collapsed measurement breaks.
  it("stacks the mounted rows one real row height apart, deep in the list", async () => {
    const { container } = mount(files(500));
    await waitFor(() => expect(screen.getByText("f0000.ts")).toBeInTheDocument());
    const scroll = scrollElementOf(container);

    const rowHeight = screen.getByText("f0000.ts").closest("button")!.getBoundingClientRect().height;
    expect(rowHeight).toBeGreaterThan(10);

    scroll.scrollTop = 300 * rowHeight;
    scroll.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(screen.getByText("f0305.ts")).toBeInTheDocument());

    const tops = ["f0301.ts", "f0302.ts", "f0303.ts", "f0304.ts", "f0305.ts"].map(
      (name) => screen.getByText(name).getBoundingClientRect().top,
    );
    const spacing = tops[1] - tops[0];
    for (let i = 1; i < tops.length; i++) {
      expect(tops[i] - tops[i - 1]).toBeCloseTo(spacing, 1);
    }
    // Within a pixel of the row's own measured height — the ~0.5px between
    // them is `estimateSize`'s 24 against a real 23.5, which is the whole
    // reason `measureElement` is on these rows.
    expect(Math.abs(spacing - rowHeight)).toBeLessThan(1.5);

    // …and the row we scrolled to really is on screen, rather than the
    // virtualizer having mounted it somewhere outside the clip.
    const box = screen.getByText("f0303.ts").getBoundingClientRect();
    const view = scroll.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(view.top - rowHeight);
    expect(box.bottom).toBeLessThanOrEqual(view.bottom + rowHeight);
  });

  /// The spacer's height is what keeps the native scrollbar thumb
  /// proportional — the comment above it in `FileTree.tsx` says exactly that.
  /// A thumb sized to the mounted slice rather than the list is how a
  /// virtualized pane tells the user a 500-file directory has twenty files in
  /// it.
  it("sizes the spacer to the whole list, not to the mounted slice", async () => {
    const { container } = mount(files(500));
    await waitFor(() => expect(screen.getByText("f0000.ts")).toBeInTheDocument());

    const scroll = scrollElementOf(container);
    const spacer = scroll.firstElementChild as HTMLElement;
    const rowHeight = screen.getByText("f0000.ts").closest("button")!.getBoundingClientRect().height;

    expect(spacer.getBoundingClientRect().height).toBeGreaterThan(400 * rowHeight);
    // …and the scroll container really is clipping it.
    expect(scroll.clientHeight).toBeLessThan(spacer.getBoundingClientRect().height / 5);
  });
});

describe("row layout", () => {
  /// Depth is expressed as `padding-left: calc(20px + depth * 12px)`, which is
  /// the only thing distinguishing a nested file from a top-level one on
  /// screen. It is arithmetic in a `calc()`, so jsdom returns the string and
  /// never the pixels.
  it("indents a nested file further than a top-level one", async () => {
    mockTauri({
      fs_list_dir: (args: Record<string, unknown>) =>
        args.path === ROOT
          ? [entry("src", true), entry("README.md")]
          : [
              {
                name: "deep.ts",
                path: `${ROOT}/src/deep.ts`,
                isDir: false,
                size: 0,
                modified: null,
                ignored: false,
              },
            ],
      git_list_branches: [],
    });
    const store = createAppStore({ persist: false });
    render(() => (
      <AppStoreContext.Provider value={store}>
        <div style={{ height: `${VIEWPORT}px`, display: "flex", "flex-direction": "column" }}>
          <FileTree root={ROOT} />
        </div>
      </AppStoreContext.Provider>
    ));

    await waitFor(() => expect(screen.getByText("README.md")).toBeInTheDocument());
    const folder = screen.getByText("src").closest("button")!;
    folder.click();
    await waitFor(() => expect(screen.getByText("deep.ts")).toBeInTheDocument());

    const shallow = screen.getByText("README.md").getBoundingClientRect().left;
    const deep = screen.getByText("deep.ts").getBoundingClientRect().left;
    // One level of nesting is 12px. Measured, not asserted from the class.
    expect(deep - shallow).toBeCloseTo(12, 0);
  });
});
