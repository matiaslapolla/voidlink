/// The provenance note, mounted.
///
/// The inference is proven in `provenance.test.ts`. What only a mounted test
/// reaches is the honesty contract, which is a rendering property and not a
/// logical one: that the hedge, the resolution of the claim and the `inferred`
/// marker are all in the **visible** text rather than behind a hover — and that
/// no evidence renders as nothing at all rather than as an "unknown" strip
/// above every diff in the repository.
import { describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { ProvenanceNote } from "./ProvenanceNote";
import type { Provenance } from "./provenance";

const FILE_CLAIM: Provenance = {
  agent: "Refactorer",
  scope: "file",
  basis: "worktree-mtime",
  at: 1_700_000_000_000,
  window: { from: 1_699_999_000_000, to: 1_700_001_000_000 },
  runId: "r1",
};

describe("ProvenanceNote", () => {
  it("hedges, and says the claim is about the file rather than the lines", () => {
    render(() => <ProvenanceNote provenance={FILE_CLAIM} />);
    const row = screen.getByText(/Probably/).closest("p")!;
    expect(row.textContent).toContain("Refactorer");
    // Both of these are load-bearing and both are visible text: a chip reading
    // only "Refactorer" is read as a fact, and one that omits the scope is read
    // as being about the hunks underneath it.
    expect(row.textContent).toContain("this whole file, not these lines");
    expect(row.textContent).toContain("inferred");
  });

  it("says commit, not file, for a commit-level claim", () => {
    render(() => (
      <ProvenanceNote
        provenance={{ agent: "Reviewer", scope: "commit", basis: "commit", at: 1, commitOid: "abc" }}
      />
    ));
    expect(screen.getByText(/this whole commit, not these lines/)).toBeInTheDocument();
  });

  it("carries the full reasoning in text, not only in a tooltip", () => {
    render(() => <ProvenanceNote provenance={FILE_CLAIM} />);
    // A `title` needs a pointer. This claim must not reach a keyboard or
    // screen-reader user in its short form only.
    const explanation = screen.getAllByText(/not from authorship/);
    expect(explanation.length).toBeGreaterThan(0);
    expect(screen.getByText(/Probably/).closest("p")).toHaveAttribute(
      "title",
      expect.stringContaining("Inferred"),
    );
  });

  it("renders nothing when the log knows nothing", () => {
    const { container } = render(() => <ProvenanceNote provenance={null} />);
    expect(container.textContent).toBe("");
  });
});
