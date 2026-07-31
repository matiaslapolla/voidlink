/// Annotated diffs, mounted.
///
/// The anchoring logic is proven in `store/reviewNotes.test.ts`. What only a
/// mounted test reaches: that the affordance exists on a working-tree diff and
/// is absent without a repository, that an existing note is visible *without*
/// hovering, and that a note whose anchor moved is labelled rather than shown
/// as if it were about the lines beneath it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import type { FileDiff } from "@/types/git";
import type { ReviewNote } from "@/store/reviewNotes";

let notes: ReviewNote[] = [];
const addReviewNote = vi.fn();
const resolveReviewNote = vi.fn();

vi.mock("@/store/reviewNotes", async () => {
  // The anchoring function is the real one — mocking it would leave the
  // "moved" badge untested against the logic that actually decides it.
  const real = await vi.importActual<typeof import("@/store/reviewNotes")>(
    "@/store/reviewNotes",
  );
  return {
    anchorNotes: real.anchorNotes,
    reviewNotesForFile: () => notes,
    addReviewNote: (o: unknown) => addReviewNote(o),
    resolveReviewNote: (r: unknown, n: unknown) => resolveReviewNote(r, n),
  };
});

import { DiffRenderer } from "./SplitDiffRenderer";

const REPO = "/repos/api";
const HEADER = "@@ -12,7 +12,9 @@ fn parse";

const FILE: FileDiff = {
  oldPath: "src/parse.rs",
  newPath: "src/parse.rs",
  status: "modified",
  isBinary: false,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      header: HEADER,
      oldStart: 12,
      oldLines: 7,
      newStart: 12,
      newLines: 9,
      lines: [
        { origin: " ", content: "fn parse() {", oldLineno: 12, newLineno: 12 },
        { origin: "+", content: "    let x = 1;", oldLineno: null, newLineno: 13 },
      ],
    },
  ],
} as FileDiff;

function note(partial: Partial<ReviewNote> = {}): ReviewNote {
  return {
    id: "n1",
    repo: REPO,
    filePath: "src/parse.rs",
    hunkHeader: HEADER,
    body: "Use the existing helper",
    createdAt: 0,
    resolved: false,
    ...partial,
  };
}

beforeEach(() => {
  notes = [];
  addReviewNote.mockReset().mockReturnValue("new-id");
  resolveReviewNote.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("the affordance", () => {
  it("offers a comment control on a working-tree diff", () => {
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    expect(screen.getByRole("button", { name: /comment on this hunk/i })).toBeInTheDocument();
  });

  /// The compare view diffs two refs; a note written there would have no
  /// working tree to land in. Passing no repo is how a caller opts out.
  it("offers none without a repository", () => {
    render(() => <DiffRenderer file={FILE} mode="inline" />);
    expect(screen.queryByRole("button", { name: /comment on this hunk/i })).not.toBeInTheDocument();
  });
});

describe("writing a note", () => {
  it("submits on Enter and files it against the hunk header", async () => {
    const user = userEvent.setup();
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);

    await user.click(screen.getByRole("button", { name: /comment on this hunk/i }));
    await user.type(
      screen.getByRole("textbox", { name: /comment on this hunk/i }),
      "Use the helper{Enter}",
    );

    expect(addReviewNote).toHaveBeenCalledWith({
      repo: REPO,
      filePath: "src/parse.rs",
      hunkHeader: HEADER,
      body: "Use the helper",
    });
  });

  /// A review comment is one or two sentences, but it must still be possible
  /// to write two lines without the first Enter sending it.
  it("takes Shift+Enter as a newline rather than a submit", async () => {
    const user = userEvent.setup();
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);

    await user.click(screen.getByRole("button", { name: /comment on this hunk/i }));
    await user.type(
      screen.getByRole("textbox", { name: /comment on this hunk/i }),
      "one{Shift>}{Enter}{/Shift}two",
    );
    expect(addReviewNote).not.toHaveBeenCalled();
  });

  it("closes the composer on Escape without writing anything", async () => {
    const user = userEvent.setup();
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);

    await user.click(screen.getByRole("button", { name: /comment on this hunk/i }));
    await user.type(screen.getByRole("textbox", { name: /comment on this hunk/i }), "x{Escape}");
    expect(screen.queryByRole("textbox", { name: /comment on this hunk/i })).not.toBeInTheDocument();
    expect(addReviewNote).not.toHaveBeenCalled();
  });
});

describe("existing notes", () => {
  /// A review left yesterday has to be visible today without hovering the hunk
  /// that carries it.
  it("shows the note and its count without any interaction", () => {
    notes = [note()];
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    expect(screen.getByText("Use the existing helper")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("resolves through its own control", async () => {
    notes = [note()];
    const user = userEvent.setup();
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    await user.click(screen.getByRole("button", { name: /resolve comment/i }));
    expect(resolveReviewNote).toHaveBeenCalledWith(REPO, "n1");
  });

  it("hides a resolved note", () => {
    notes = [note({ resolved: true })];
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    expect(screen.queryByText("Use the existing helper")).not.toBeInTheDocument();
  });

  /// The note is still the file's, and still shown — but a reader must not
  /// believe it is about the lines underneath it.
  it("labels a note whose hunk has since changed", () => {
    notes = [note({ hunkHeader: "@@ -99,1 +99,1 @@ fn gone" })];
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    expect(screen.getByText("Use the existing helper")).toBeInTheDocument();
    expect(screen.getByText("moved")).toBeInTheDocument();
  });

  it("does not label a note that is still anchored", () => {
    notes = [note()];
    render(() => <DiffRenderer file={FILE} mode="inline" repoPath={REPO} />);
    expect(screen.queryByText("moved")).not.toBeInTheDocument();
  });

  it("renders notes in split mode too", () => {
    notes = [note()];
    render(() => <DiffRenderer file={FILE} mode="split" repoPath={REPO} />);
    expect(screen.getByText("Use the existing helper")).toBeInTheDocument();
  });
});
