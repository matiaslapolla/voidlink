/// Staging and discarding one hunk, mounted.
///
/// The renderer deliberately knows nothing about staged-versus-unstaged: the
/// caller decides whether the action stages or unstages and hands down the
/// label, the icon direction and the handler. That indirection is the whole
/// reason this needs a mounted test — nothing about it is checkable from
/// `HunkActions`' type alone, and a control wired to the wrong hunk index
/// stages the wrong lines silently.
///
/// This is jsdom on purpose. The *visibility* of these controls is a cascade
/// fact — they are `opacity-0` until the hunk is hovered — and that half lives
/// in `SplitDiffRenderer.browser.test.tsx`, where there is a stylesheet to
/// read it from. Everything here would pass with `getBoundingClientRect`
/// returning zeroes, so it belongs where it is cheap.
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { DiffHunk, FileDiff } from "@/types/git";

import { DiffRenderer, type HunkActions } from "./SplitDiffRenderer";

function hunk(name: string, start: number): DiffHunk {
  return {
    header: `@@ -${start},2 +${start},2 @@ ${name}`,
    oldStart: start,
    oldLines: 2,
    newStart: start,
    newLines: 2,
    lines: [
      { origin: " ", content: `context ${name}`, oldLineno: start, newLineno: start },
      { origin: "+", content: `added ${name}`, oldLineno: null, newLineno: start + 1 },
      { origin: "-", content: `removed ${name}`, oldLineno: start + 1, newLineno: null },
    ],
  };
}

const TWO_HUNKS: FileDiff = {
  oldPath: "src/parse.rs",
  newPath: "src/parse.rs",
  status: "modified",
  isBinary: false,
  additions: 2,
  deletions: 2,
  hunks: [hunk("first", 10), hunk("second", 90)],
} as FileDiff;

function mount(hunkActions?: HunkActions, mode: "inline" | "split" = "inline") {
  return render(() => <DiffRenderer file={TWO_HUNKS} mode={mode} hunkActions={hunkActions} />);
}

/// The toolbar of the hunk whose header names `name`. Both hunks offer
/// identically-labelled controls, so every assertion about "which hunk" has to
/// be scoped to one of them — which is also the only way to catch a control
/// wired to a fixed index.
function toolbarOf(name: string): HTMLElement {
  return screen.getByText(new RegExp(`@@ .* ${name}$`)).parentElement!;
}

describe("what the caller opted into", () => {
  /// Absence is the default. The compare view diffs two refs and has no index
  /// to stage into, so it passes no actions and must get no buttons — a
  /// "Stage hunk" button there would be an offer the surface cannot honour.
  it("offers no stage or discard control when the caller passed none", () => {
    mount();
    expect(screen.queryByRole("button", { name: /stage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /discard/i })).not.toBeInTheDocument();
    // …but the controls that need nothing from the caller are still there.
    expect(screen.getAllByRole("button", { name: /copy hunk as markdown/i })).toHaveLength(2);
  });

  it("offers stage without discard when only stage was given", () => {
    mount({ onStageHunk: vi.fn() });
    expect(screen.getAllByRole("button", { name: "Stage hunk" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Discard hunk" })).not.toBeInTheDocument();
  });

  /// The renderer does not know which direction it is going; the caller names
  /// it. A staged-side diff passes "Unstage hunk", and the label is the *only*
  /// thing telling the user what the button will do.
  it("says what the caller called it", () => {
    mount({ onStageHunk: vi.fn(), stageLabel: "Unstage hunk", stageReverse: true });
    expect(screen.getAllByRole("button", { name: "Unstage hunk" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Stage hunk" })).not.toBeInTheDocument();
  });
});

describe("acting on one hunk", () => {
  /// The index is the contract. `git_stage_hunk` takes a position into
  /// `file.hunks`, so a button wired to the wrong one applies the wrong lines
  /// to the index and reports success.
  it("passes the index of the hunk whose button was clicked", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn();
    mount({ onStageHunk });

    await user.click(within(toolbarOf("second")).getByRole("button", { name: "Stage hunk" }));
    expect(onStageHunk).toHaveBeenCalledExactlyOnceWith(1);

    await user.click(within(toolbarOf("first")).getByRole("button", { name: "Stage hunk" }));
    expect(onStageHunk).toHaveBeenLastCalledWith(0);
  });

  it("sends a discard to the discard handler, not to the stage one", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn();
    const onDiscardHunk = vi.fn();
    mount({ onStageHunk, onDiscardHunk });

    await user.click(within(toolbarOf("first")).getByRole("button", { name: "Discard hunk" }));
    expect(onDiscardHunk).toHaveBeenCalledExactlyOnceWith(0);
    expect(onStageHunk).not.toHaveBeenCalled();
  });

  it("offers the same controls in the split layout", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn();
    mount({ onStageHunk }, "split");

    await user.click(within(toolbarOf("second")).getByRole("button", { name: "Stage hunk" }));
    expect(onStageHunk).toHaveBeenCalledExactlyOnceWith(1);
  });
});

/// Staging a hunk rewrites the index, and the diff underneath the button
/// changes as a result. A second click while the first is still out applies a
/// hunk index that no longer means what it meant when it was read.
describe("the in-flight gate", () => {
  it("refuses a second click until the first has returned", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const onStageHunk = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mount({ onStageHunk });

    const button = within(toolbarOf("first")).getByRole("button", { name: "Stage hunk" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());

    release?.();
    await waitFor(() => expect(button).toBeEnabled());
    expect(onStageHunk).toHaveBeenCalledTimes(1);
  });

  /// The gate is per hunk, because the two actions are independent: staging
  /// hunk 1 has no reason to lock hunk 2 out.
  it("locks only the hunk that is busy", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn(() => new Promise<void>(() => {}));
    mount({ onStageHunk });

    await user.click(within(toolbarOf("first")).getByRole("button", { name: "Stage hunk" }));
    await waitFor(() =>
      expect(within(toolbarOf("first")).getByRole("button", { name: "Stage hunk" })).toBeDisabled(),
    );
    expect(within(toolbarOf("second")).getByRole("button", { name: "Stage hunk" })).toBeEnabled();
  });

  /// Stage and discard share one `running` signal inside a hunk, which is the
  /// right call: they are two ways to resolve the same lines and running both
  /// at once is never what the user meant.
  it("locks discard while a stage on the same hunk is out", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn(() => new Promise<void>(() => {}));
    const onDiscardHunk = vi.fn();
    mount({ onStageHunk, onDiscardHunk });

    await user.click(within(toolbarOf("first")).getByRole("button", { name: "Stage hunk" }));
    await waitFor(() =>
      expect(within(toolbarOf("first")).getByRole("button", { name: "Discard hunk" })).toBeDisabled(),
    );
    expect(onDiscardHunk).not.toHaveBeenCalled();
  });
});

/// Line selection, which is `git add -p`'s line mode drawn on the same rows
/// the hunk buttons already sit above.
///
/// The file header's warning applies twice over here: a row wired to the wrong
/// *line* index stages a line the user did not pick, and unlike a wrong hunk
/// index the result still looks like a plausible diff afterwards. Every
/// assertion below is therefore about which index came back, scoped to which
/// hunk it came from.
describe("picking lines inside a hunk", () => {
  /// The default. A caller that passes no `onLineClick` gets rows that are not
  /// buttons — no role, no tab stop, no cursor — because the compare view has
  /// no index to stage into and a clickable line there would be an offer the
  /// surface cannot honour.
  it("leaves rows inert when the caller did not opt in", () => {
    mount({ onStageHunk: vi.fn() });
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("makes only the changed lines pickable, never context", () => {
    mount({ onStageHunk: vi.fn(), onLineClick: vi.fn() });
    const rows = screen.getAllByRole("checkbox");
    // Two hunks × (one addition + one deletion). The context line in each is
    // not a choice: it is present on both sides already.
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Added line: added first",
      "Removed line: removed first",
      "Added line: added second",
      "Removed line: removed second",
    ]);
  });

  /// The contract: the index is a position in *that hunk's* `lines` array, and
  /// the hunk index says which hunk. Both halves have to be right, and the
  /// second hunk is the one that catches a handler closed over hunk 0.
  it("reports the hunk and the line index of the row that was clicked", async () => {
    const user = userEvent.setup();
    const onLineClick = vi.fn();
    mount({ onStageHunk: vi.fn(), onLineClick });

    await user.click(screen.getByRole("checkbox", { name: "Added line: added second" }));
    expect(onLineClick).toHaveBeenCalledExactlyOnceWith(1, 1, false);

    await user.click(screen.getByRole("checkbox", { name: "Removed line: removed first" }));
    expect(onLineClick).toHaveBeenLastCalledWith(0, 2, false);
  });

  it("passes the shift modifier through, because ranges depend on it", async () => {
    const user = userEvent.setup();
    const onLineClick = vi.fn();
    mount({ onStageHunk: vi.fn(), onLineClick });

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("checkbox", { name: "Removed line: removed first" }));
    await user.keyboard("{/Shift}");
    expect(onLineClick).toHaveBeenCalledExactlyOnceWith(0, 2, true);
  });

  it("marks the selected rows and only those", () => {
    mount({
      onStageHunk: vi.fn(),
      onLineClick: vi.fn(),
      selection: { hunkIndex: 1, lines: [1] },
    });
    const checked = screen
      .getAllByRole("checkbox")
      .filter((r) => r.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveAttribute("aria-label", "Added line: added second");
  });

  /// A row is reachable without a pointer. Space is the checkbox key, and the
  /// role this row claims is what promises it works.
  it("picks a line from the keyboard", async () => {
    const user = userEvent.setup();
    const onLineClick = vi.fn();
    mount({ onStageHunk: vi.fn(), onLineClick });

    const row = screen.getByRole("checkbox", { name: "Added line: added first" });
    row.focus();
    await user.keyboard(" ");
    expect(onLineClick).toHaveBeenCalledExactlyOnceWith(0, 1, false);
  });
});

/// With lines picked, the hunk buttons stop meaning "this hunk" and start
/// meaning "these lines" — and they have to *say* so, because the two actions
/// differ by exactly the lines the user spent the last few clicks choosing.
describe("what the buttons say once lines are picked", () => {
  it("counts the picked lines instead of naming the hunk", () => {
    mount({
      onStageHunk: vi.fn(),
      onDiscardHunk: vi.fn(),
      onLineClick: vi.fn(),
      selection: { hunkIndex: 0, lines: [1, 2] },
    });
    expect(screen.getByRole("button", { name: "Stage 2 lines" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard 2 lines" })).toBeInTheDocument();
  });

  it("singularises one line", () => {
    mount({ onStageHunk: vi.fn(), onLineClick: vi.fn(), selection: { hunkIndex: 0, lines: [1] } });
    expect(screen.getByRole("button", { name: "Stage 1 line" })).toBeInTheDocument();
  });

  it("keeps the caller's verb when it is unstaging", () => {
    mount({
      onStageHunk: vi.fn(),
      stageLabel: "Unstage hunk",
      stageReverse: true,
      onLineClick: vi.fn(),
      selection: { hunkIndex: 0, lines: [1] },
    });
    expect(screen.getByRole("button", { name: "Unstage 1 line" })).toBeInTheDocument();
  });

  /// The other hunk's buttons are unchanged. A selection is in one hunk, and
  /// a second hunk offering "Stage 2 lines" would be offering to stage lines
  /// that are not in it.
  it("leaves the other hunk's buttons meaning the whole hunk", () => {
    mount({ onStageHunk: vi.fn(), onLineClick: vi.fn(), selection: { hunkIndex: 0, lines: [1] } });
    expect(
      within(toolbarOf("second")).getByRole("button", { name: "Stage hunk" }),
    ).toBeInTheDocument();
    expect(within(toolbarOf("first")).getByRole("button", { name: "Stage 1 line" })).toBeInTheDocument();
  });

  it("still sends the hunk index, and only the hunk index, to the handler", async () => {
    const user = userEvent.setup();
    const onStageHunk = vi.fn();
    mount({ onStageHunk, onLineClick: vi.fn(), selection: { hunkIndex: 0, lines: [1] } });

    await user.click(within(toolbarOf("first")).getByRole("button", { name: "Stage 1 line" }));
    expect(onStageHunk).toHaveBeenCalledExactlyOnceWith(0);
  });

  /// A twenty-line shift-select needs one way out, not twenty.
  it("offers a clear-selection control, and only while there is one", async () => {
    const user = userEvent.setup();
    const onClearSelection = vi.fn();
    const { unmount } = mount({
      onStageHunk: vi.fn(),
      onLineClick: vi.fn(),
      onClearSelection,
      selection: { hunkIndex: 0, lines: [1, 2] },
    });
    await user.click(screen.getByRole("button", { name: "Clear line selection" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
    unmount();

    mount({ onStageHunk: vi.fn(), onLineClick: vi.fn(), onClearSelection });
    expect(screen.queryByRole("button", { name: "Clear line selection" })).not.toBeInTheDocument();
  });
});
