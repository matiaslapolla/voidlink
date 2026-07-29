import { describe, expect, it } from "vitest";
import { cursorLabel, eolLabel, indentLabel, languageLabel } from "./editorStatus";

describe("languageLabel", () => {
  it("uses the human name where the machine id is not one", () => {
    expect(languageLabel("typescript")).toBe("TypeScript");
    expect(languageLabel("csharp")).toBe("C#");
    expect(languageLabel("cpp")).toBe("C++");
    expect(languageLabel("plaintext")).toBe("Plain text");
  });

  /// The map exists for the ids capitalisation gets wrong. Everything else —
  /// including languages this repo has never seen — must still render, because
  /// an empty language chip reads as "no file open".
  it("capitalises anything it has no opinion about", () => {
    expect(languageLabel("rust")).toBe("Rust");
    expect(languageLabel("go")).toBe("Go");
    expect(languageLabel("brainfuck")).toBe("Brainfuck");
  });
});

describe("cursorLabel", () => {
  it("is bare line:column with no selection", () => {
    expect(cursorLabel({ line: 12, column: 4, selected: 0, selectedLines: 1 })).toBe("12:4");
  });

  it("counts characters for a selection inside one line", () => {
    expect(cursorLabel({ line: 12, column: 4, selected: 18, selectedLines: 1 })).toBe(
      "12:4 (18 selected)",
    );
  });

  /// Character counts stop being useful once a selection spans lines — nobody
  /// wants to know a block is 4,102 characters, they want to know it is 87
  /// lines.
  it("counts lines for a multi-line selection", () => {
    expect(cursorLabel({ line: 12, column: 4, selected: 4102, selectedLines: 87 })).toBe(
      "12:4 (87 lines selected)",
    );
  });
});

describe("indentLabel", () => {
  /// Two different claims: how many spaces get inserted, versus how wide a tab
  /// renders. Collapsing them into one phrasing is how "Spaces: 4" ends up on
  /// a tab-indented file.
  it("distinguishes inserted spaces from rendered tab width", () => {
    expect(indentLabel({ insertSpaces: true, tabSize: 2 })).toBe("Spaces: 2");
    expect(indentLabel({ insertSpaces: false, tabSize: 4 })).toBe("Tab size: 4");
  });
});

describe("eolLabel", () => {
  it("maps Monaco's two EOL values", () => {
    expect(eolLabel("\n")).toBe("LF");
    expect(eolLabel("\r\n")).toBe("CRLF");
  });
});
