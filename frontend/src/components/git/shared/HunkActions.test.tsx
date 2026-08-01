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
    ],
  };
}

const TWO_HUNKS: FileDiff = {
  oldPath: "src/parse.rs",
  newPath: "src/parse.rs",
  status: "modified",
  isBinary: false,
  additions: 2,
  deletions: 0,
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
