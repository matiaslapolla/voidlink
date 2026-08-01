/// Annotated diffs. The interesting half is `anchorNotes` — a note whose hunk
/// has moved must be reported as detached, never silently dropped and never
/// re-pointed at a different hunk, which would look correct and be wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.fn();
vi.mock("@/store/journal", () => ({ record: (e: unknown) => record(e) }));
vi.mock("@/store/layout/persistence", () => ({
  STORAGE_KEYS: { reviewNotes: "voidlink-review-notes" },
  readJson: <T,>(_key: string, fallback: T) => fallback,
  writeJson: () => {},
}));

import {
  addReviewNote,
  anchorNotes,
  openReviewNotes,
  removeReviewNote,
  resetReviewNotes,
  resolveReviewNote,
  reviewNotesForFile,
  reviewNotesPrompt,
  reviveReviewNotes,
  type ReviewNote,
} from "./reviewNotes";

const REPO = "/repos/api";
const HUNK = "@@ -12,7 +12,9 @@ fn parse";

function note(partial: Partial<ReviewNote> = {}): ReviewNote {
  return {
    id: "n1",
    repo: REPO,
    filePath: "src/parse.rs",
    hunkHeader: HUNK,
    body: "Use the existing helper here",
    createdAt: 0,
    resolved: false,
    ...partial,
  };
}

beforeEach(() => {
  resetReviewNotes();
  record.mockReset();
});

afterEach(() => resetReviewNotes());

describe("adding", () => {
  it("stores the note against its file and hunk, and records it", () => {
    const id = addReviewNote({
      repo: REPO,
      filePath: "src/parse.rs",
      hunkHeader: HUNK,
      body: "  Use the existing helper  ",
    });

    expect(id).toBeTruthy();
    const [stored] = reviewNotesForFile(REPO, "src/parse.rs");
    expect(stored.body).toBe("Use the existing helper");
    expect(stored.hunkHeader).toBe(HUNK);
    expect(record.mock.calls[0][0]).toMatchObject({
      kind: "review.note.added",
      repo: REPO,
      subject: "src/parse.rs",
    });
  });

  it("refuses an empty body", () => {
    expect(
      addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "  \n " }),
    ).toBeNull();
    expect(reviewNotesForFile(REPO, "a.rs")).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps repositories apart", () => {
    addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "mine" });
    addReviewNote({ repo: "/other", filePath: "a.rs", hunkHeader: HUNK, body: "theirs" });
    expect(reviewNotesForFile(REPO, "a.rs").map((n) => n.body)).toEqual(["mine"]);
  });
});

describe("resolving", () => {
  /// Deleting on resolve would make "what have I already said about this file"
  /// unanswerable halfway through a review.
  it("keeps a resolved note but takes it out of what the agent sees", () => {
    const id = addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "x" })!;
    resolveReviewNote(REPO, id);

    expect(reviewNotesForFile(REPO, "a.rs")).toHaveLength(1);
    expect(openReviewNotes(REPO)).toHaveLength(0);
    expect(record.mock.calls[1][0]).toMatchObject({ kind: "review.note.resolved" });
  });

  it("records a reopen distinctly", () => {
    const id = addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "x" })!;
    resolveReviewNote(REPO, id);
    resolveReviewNote(REPO, id, false);
    expect(record.mock.calls.map((c) => c[0].kind)).toEqual([
      "review.note.added",
      "review.note.resolved",
      "review.note.reopened",
    ]);
  });

  it("writes nothing when the note is already in that state", () => {
    const id = addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "x" })!;
    record.mockReset();
    resolveReviewNote(REPO, id, false);
    expect(record).not.toHaveBeenCalled();
  });

  it("removes a note outright when asked", () => {
    const id = addReviewNote({ repo: REPO, filePath: "a.rs", hunkHeader: HUNK, body: "x" })!;
    removeReviewNote(REPO, id);
    expect(reviewNotesForFile(REPO, "a.rs")).toEqual([]);
  });
});

describe("anchorNotes", () => {
  it("matches a note to the hunk whose header it was written against", () => {
    const { byHunk, detached } = anchorNotes([note()], ["@@ -1,3 +1,3 @@", HUNK]);
    expect(byHunk.get(1)?.map((n) => n.id)).toEqual(["n1"]);
    expect(detached).toEqual([]);
  });

  /// The whole point. Editing above a hunk rewrites its header; the note must
  /// survive as the file's, visibly unanchored.
  it("detaches a note whose hunk is no longer in the diff", () => {
    const { byHunk, detached } = anchorNotes([note()], ["@@ -40,2 +40,2 @@ fn other"]);
    expect(byHunk.size).toBe(0);
    expect(detached.map((n) => n.id)).toEqual(["n1"]);
  });

  /// Re-pointing at a different hunk by index would look correct and be wrong,
  /// which is worse than losing the note.
  it("never re-points a detached note at a neighbouring hunk", () => {
    const { byHunk } = anchorNotes([note()], ["@@ -1,1 +1,1 @@", "@@ -9,9 +9,9 @@"]);
    expect(byHunk.get(0)).toBeUndefined();
    expect(byHunk.get(1)).toBeUndefined();
  });

  /// Generated files really do produce identical `@@` lines. Showing the note
  /// against both is a smaller lie than picking one.
  it("shows a note against every hunk with an identical header", () => {
    const { byHunk } = anchorNotes([note()], [HUNK, HUNK]);
    expect([...byHunk.keys()]).toEqual([0, 1]);
  });

  it("groups several notes on one hunk", () => {
    const { byHunk } = anchorNotes([note({ id: "a" }), note({ id: "b" })], [HUNK]);
    expect(byHunk.get(0)?.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("handles a file with no hunks at all", () => {
    const { detached } = anchorNotes([note()], []);
    expect(detached).toHaveLength(1);
  });
});

describe("reviewNotesPrompt", () => {
  it("is null when there is nothing to say", () => {
    expect(reviewNotesPrompt([])).toBeNull();
  });

  /// Without the instruction line a CLI reads the notes as background and
  /// answers *about* them, when what the user meant was "do this".
  it("tells the agent the notes are instructions, not background", () => {
    const prompt = reviewNotesPrompt([note()])!;
    expect(prompt).toMatch(/instructions about what to change, not as background/i);
  });

  it("groups by file and quotes the note verbatim under its hunk", () => {
    const prompt = reviewNotesPrompt([
      note({ id: "a", filePath: "src/a.rs", body: "Use the helper" }),
      note({ id: "b", filePath: "src/a.rs", body: "And rename this" }),
      note({ id: "c", filePath: "src/b.rs", body: "Delete it" }),
    ])!;
    expect(prompt).toContain("### src/a.rs");
    expect(prompt).toContain("### src/b.rs");
    expect(prompt).toContain("> Use the helper");
    expect(prompt).toContain(`On \`${HUNK}\``);
  });

  it("quotes every line of a multi-line note", () => {
    const prompt = reviewNotesPrompt([note({ body: "one\ntwo" })])!;
    expect(prompt).toContain("> one\n> two");
  });

  /// A detached note still reaches the agent, and says why it cannot point at
  /// a hunk — otherwise the agent is told about a location that does not exist.
  it("says a detached note lost its hunk rather than inventing one", () => {
    const prompt = reviewNotesPrompt([note({ hunkHeader: "" })])!;
    expect(prompt).toMatch(/the hunk it was written against has since changed/i);
  });
});

describe("reviveReviewNotes", () => {
  it("reads back what was written", () => {
    const revived = reviveReviewNotes({
      [REPO]: [{ id: "n", filePath: "a.rs", hunkHeader: HUNK, body: "x", createdAt: 3 }],
    });
    expect(revived[REPO][0]).toMatchObject({ body: "x", repo: REPO, resolved: false });
  });

  it("drops entries that cannot be shown anywhere", () => {
    const revived = reviveReviewNotes({
      [REPO]: [
        { filePath: "a.rs", body: "  " },
        { body: "orphan with no file" },
        null,
        { id: "ok", filePath: "a.rs", body: "keep me" },
      ],
    });
    expect(revived[REPO].map((n) => n.body)).toEqual(["keep me"]);
  });

  it("survives a blob that is not the shape it expects", () => {
    expect(reviveReviewNotes(null)).toEqual({});
    expect(reviveReviewNotes({ [REPO]: "nope" })).toEqual({});
  });
});
