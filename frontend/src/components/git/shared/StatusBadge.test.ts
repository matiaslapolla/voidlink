import { describe, expect, it } from "vitest";
import { statusLetter, statusToneClass } from "./StatusBadge";

describe("statusLetter", () => {
  it("maps additions to A", () => {
    expect(statusLetter("added")).toMatchObject({ letter: "A", tone: "success" });
    // Untracked deliberately shares A with added — in a changes list an
    // untracked file is the thing you are about to add.
    expect(statusLetter("untracked")).toMatchObject({ letter: "A", tone: "success" });
  });

  it("maps modifications to M", () => {
    expect(statusLetter("modified")).toMatchObject({ letter: "M", tone: "info" });
    expect(statusLetter("typechange")).toMatchObject({ letter: "M", tone: "info" });
  });

  it("maps deletions to D", () => {
    expect(statusLetter("deleted")).toMatchObject({ letter: "D", tone: "destructive" });
  });

  it("maps renames and copies", () => {
    expect(statusLetter("renamed")).toMatchObject({ letter: "R", tone: "info" });
    expect(statusLetter("copied")).toMatchObject({ letter: "C", tone: "info" });
  });

  it("maps conflicts to U, not C", () => {
    expect(statusLetter("conflicted")).toMatchObject({ letter: "U", tone: "warning" });
    expect(statusLetter("unmerged")).toMatchObject({ letter: "U", tone: "warning" });
  });

  it("degrades an unknown status instead of throwing", () => {
    expect(statusLetter("ignored")).toMatchObject({ letter: "?", tone: "muted" });
    // The raw word still reaches the tooltip, so a new libgit2 status is at
    // least legible while nobody has mapped it yet.
    expect(statusLetter("ignored").label).toBe("ignored");
    expect(statusLetter("").label).toBe("Unknown");
  });

  it("gives every status a full-word label for the tooltip", () => {
    for (const s of [
      "added",
      "untracked",
      "modified",
      "typechange",
      "deleted",
      "renamed",
      "copied",
      "conflicted",
      "unmerged",
    ]) {
      expect(statusLetter(s).label.length).toBeGreaterThan(1);
    }
  });

  it("resolves each tone to a semantic token class", () => {
    expect(statusToneClass("success")).toBe("text-success");
    expect(statusToneClass("destructive")).toBe("text-destructive");
    expect(statusToneClass("info")).toBe("text-info");
    expect(statusToneClass("warning")).toBe("text-warning");
    expect(statusToneClass("muted")).toBe("text-muted-foreground");
  });
});
