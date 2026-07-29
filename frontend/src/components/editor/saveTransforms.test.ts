import { describe, expect, it } from "vitest";
import {
  applySaveTransforms,
  insertFinalNewline,
  trimTrailingWhitespace,
} from "./saveTransforms";

describe("trimTrailingWhitespace", () => {
  it("strips spaces and tabs from the end of every line", () => {
    expect(trimTrailingWhitespace("a  \nb\t\nc")).toBe("a\nb\nc");
  });

  it("collapses a whitespace-only line to empty", () => {
    expect(trimTrailingWhitespace("a\n   \nb")).toBe("a\n\nb");
  });

  it("leaves leading and interior whitespace alone", () => {
    expect(trimTrailingWhitespace("  indented  ")).toBe("  indented");
    expect(trimTrailingWhitespace("a  b  ")).toBe("a  b");
  });

  it("preserves CRLF terminators", () => {
    // Converting line endings on save turns a one-line edit into a whole-file
    // diff, which is worse than the trailing space it was trying to fix.
    expect(trimTrailingWhitespace("a  \r\nb  \r\n")).toBe("a\r\nb\r\n");
  });

  it("is a no-op on already-clean text", () => {
    const clean = "fn main() {\n    println!(\"hi\");\n}\n";
    expect(trimTrailingWhitespace(clean)).toBe(clean);
  });
});

describe("insertFinalNewline", () => {
  it("adds one when the file does not end in a terminator", () => {
    expect(insertFinalNewline("a\nb")).toBe("a\nb\n");
  });

  it("adds none when the file already ends in one", () => {
    expect(insertFinalNewline("a\nb\n")).toBe("a\nb\n");
  });

  it("does not touch an empty buffer", () => {
    // The user just emptied the file. Writing a newline back in is a change
    // they did not ask for.
    expect(insertFinalNewline("")).toBe("");
  });

  it("matches the terminator the file already uses", () => {
    expect(insertFinalNewline("a\r\nb")).toBe("a\r\nb\r\n");
  });
});

describe("applySaveTransforms", () => {
  const both = { trimTrailingWhitespace: true, insertFinalNewline: true };

  it("trims before adding the final newline", () => {
    // Order is load-bearing: trimming last would eat the newline just added
    // on a buffer whose last line is blank-but-indented.
    expect(applySaveTransforms("a\nb   ", both)).toBe("a\nb\n");
    expect(applySaveTransforms("a\n   ", both)).toBe("a\n");
  });

  it("applies only what is enabled", () => {
    expect(
      applySaveTransforms("a  \nb", { trimTrailingWhitespace: true, insertFinalNewline: false }),
    ).toBe("a\nb");
    expect(
      applySaveTransforms("a  \nb", { trimTrailingWhitespace: false, insertFinalNewline: true }),
    ).toBe("a  \nb\n");
  });

  it("is the identity when both are off — the shipped default", () => {
    const messy = "a  \n\tb\t\n   ";
    expect(
      applySaveTransforms(messy, { trimTrailingWhitespace: false, insertFinalNewline: false }),
    ).toBe(messy);
  });
});
