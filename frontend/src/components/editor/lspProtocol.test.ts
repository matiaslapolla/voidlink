/// The LSP↔Monaco conversions.
///
/// Two kinds of assertion here, and the second is the interesting one:
///
///   1. Behaviour — positions shift by exactly one, a zero-width diagnostic
///      gets a visible marker, a snippet completion carries the snippet rule.
///   2. Drift — `lspProtocol.ts` writes Monaco's enum values out as numeric
///      literals, because the test environment is `node` and importing
///      `monaco-editor` there touches the DOM. Literals rot silently across a
///      Monaco upgrade, so these tests parse the *actual* enums out of
///      `editor.api.d.ts` and check every entry against them. A version bump
///      that renumbers `CompletionItemKind` fails here rather than shipping
///      wrong icons.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  completionKind,
  isSymbolInformation,
  markerSeverity,
  pathFromUri,
  symbolKind,
  toEditOperation,
  toHoverContents,
  toLspPosition,
  toLspRange,
  toMarkdown,
  toMarker,
  toMonacoCompletionItem,
  toMonacoDocumentSymbols,
  toMonacoHover,
  toMonacoPosition,
  toMonacoRange,
  toMonacoSignatureHelp,
  toTargets,
  uriFromPath,
  type LspRange,
} from "./lspProtocol";

// ── The real Monaco enums, read off the shipped type declarations ───────────

const API_D_TS = createRequire(import.meta.url).resolve(
  "monaco-editor/esm/vs/editor/editor.api.d.ts",
);

/// Parse `Name = 0,` members out of the first `enum <name>` block in the file.
function readEnum(name: string): Record<string, number> {
  const source = readFileSync(API_D_TS, "utf8");
  const at = source.search(new RegExp(`enum ${name} \\{`));
  if (at < 0) throw new Error(`no enum ${name} in ${API_D_TS}`);
  const body = source.slice(at, source.indexOf("}", at));
  const out: Record<string, number> = {};
  for (const [, key, value] of body.matchAll(/^\s*(\w+)\s*=\s*(\d+),?\s*$/gm)) {
    out[key] = Number(value);
  }
  return out;
}

const MONACO_COMPLETION_KIND = readEnum("CompletionItemKind");
const MONACO_MARKER_SEVERITY = readEnum("MarkerSeverity");
const MONACO_SYMBOL_KIND = readEnum("SymbolKind");
const MONACO_INSERT_TEXT_RULE = readEnum("CompletionItemInsertTextRule");

/// LSP's own numbering, from the 3.17 specification. Written here rather than
/// imported so the test states both sides of the mapping explicitly.
const LSP_COMPLETION_KIND: Record<string, number> = {
  Text: 1, Method: 2, Function: 3, Constructor: 4, Field: 5, Variable: 6,
  Class: 7, Interface: 8, Module: 9, Property: 10, Unit: 11, Value: 12,
  Enum: 13, Keyword: 14, Snippet: 15, Color: 16, File: 17, Reference: 18,
  Folder: 19, EnumMember: 20, Constant: 21, Struct: 22, Event: 23,
  Operator: 24, TypeParameter: 25,
};

const LSP_SYMBOL_KIND: Record<string, number> = {
  File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5, Method: 6,
  Property: 7, Field: 8, Constructor: 9, Enum: 10, Interface: 11, Function: 12,
  Variable: 13, Constant: 14, String: 15, Number: 16, Boolean: 17, Array: 18,
  Object: 19, Key: 20, Null: 21, EnumMember: 22, Struct: 23, Event: 24,
  Operator: 25, TypeParameter: 26,
};

// ── Positions: the off-by-one that breaks everything downstream ─────────────

describe("positions", () => {
  it("maps the LSP origin to the Monaco origin", () => {
    // The single most consequential assertion in the bridge. LSP counts from
    // 0 in both axes; Monaco counts from 1 in both.
    expect(toMonacoPosition({ line: 0, character: 0 })).toEqual({
      lineNumber: 1,
      column: 1,
    });
    expect(toLspPosition({ lineNumber: 1, column: 1 })).toEqual({
      line: 0,
      character: 0,
    });
  });

  it("round-trips an arbitrary position in both directions", () => {
    const lsp = { line: 41, character: 7 };
    expect(toLspPosition(toMonacoPosition(lsp))).toEqual(lsp);

    const monaco = { lineNumber: 42, column: 8 };
    expect(toMonacoPosition(toLspPosition(monaco))).toEqual(monaco);
  });

  it("never produces a negative LSP coordinate from a degenerate Monaco one", () => {
    // A default-constructed or stale Monaco position can be 0; sending
    // `line: -1` makes a server reject the whole request.
    expect(toLspPosition({ lineNumber: 0, column: 0 })).toEqual({
      line: 0,
      character: 0,
    });
  });

  it("shifts both ends of a range", () => {
    const range: LspRange = {
      start: { line: 2, character: 4 },
      end: { line: 5, character: 0 },
    };
    expect(toMonacoRange(range)).toEqual({
      startLineNumber: 3,
      startColumn: 5,
      endLineNumber: 6,
      endColumn: 1,
    });
    expect(toLspRange(toMonacoRange(range))).toEqual(range);
  });
});

// ── Enum tables ─────────────────────────────────────────────────────────────

describe("completionKind", () => {
  it("maps every LSP kind onto the Monaco enum member of the same name", () => {
    // Monaco's enum is 0-based *and* reordered relative to LSP's — LSP `Text`
    // is 1, Monaco `Text` is 18. Any arithmetic shortcut fails here.
    for (const [name, lspValue] of Object.entries(LSP_COMPLETION_KIND)) {
      expect(MONACO_COMPLETION_KIND[name], `Monaco has no ${name}`).toBeDefined();
      expect(completionKind(lspValue), `LSP ${name}`).toBe(MONACO_COMPLETION_KIND[name]);
    }
  });

  it("is not a plain offset, which is the mistake this table exists to avoid", () => {
    expect(completionKind(LSP_COMPLETION_KIND.Text)).not.toBe(LSP_COMPLETION_KIND.Text - 1);
    expect(completionKind(LSP_COMPLETION_KIND.Snippet)).toBe(MONACO_COMPLETION_KIND.Snippet);
  });

  it("falls back to Property for an absent or unknown kind", () => {
    expect(completionKind(undefined)).toBe(MONACO_COMPLETION_KIND.Property);
    expect(completionKind(999)).toBe(MONACO_COMPLETION_KIND.Property);
  });
});

describe("markerSeverity", () => {
  it("maps LSP severities onto Monaco's bitmask, which runs the other way", () => {
    expect(markerSeverity(1)).toBe(MONACO_MARKER_SEVERITY.Error);
    expect(markerSeverity(2)).toBe(MONACO_MARKER_SEVERITY.Warning);
    expect(markerSeverity(3)).toBe(MONACO_MARKER_SEVERITY.Info);
    expect(markerSeverity(4)).toBe(MONACO_MARKER_SEVERITY.Hint);
  });

  it("treats a severity-less diagnostic as an error, per the specification", () => {
    expect(markerSeverity(undefined)).toBe(MONACO_MARKER_SEVERITY.Error);
  });

  it("does not pass an LSP severity through unchanged", () => {
    // Passing 1 through would make every error a Hint, which draws nothing.
    expect(markerSeverity(1)).not.toBe(1);
  });
});

describe("symbolKind", () => {
  it("maps every LSP symbol kind onto the Monaco member of the same name", () => {
    for (const [name, lspValue] of Object.entries(LSP_SYMBOL_KIND)) {
      expect(MONACO_SYMBOL_KIND[name], `Monaco has no ${name}`).toBeDefined();
      expect(symbolKind(lspValue), `LSP ${name}`).toBe(MONACO_SYMBOL_KIND[name]);
    }
  });

  it("clamps a kind from a newer specification rather than emitting a blank icon", () => {
    expect(symbolKind(99)).toBe(MONACO_SYMBOL_KIND.Variable);
    expect(symbolKind(0)).toBe(MONACO_SYMBOL_KIND.Variable);
  });
});

// ── Completion items ────────────────────────────────────────────────────────

const DEFAULT_RANGE = {
  startLineNumber: 3,
  startColumn: 5,
  endLineNumber: 3,
  endColumn: 9,
};

describe("toMonacoCompletionItem", () => {
  it("uses the word range under the cursor when the server sent no edit", () => {
    // Monaco drops an item with no range; LSP makes `textEdit` optional.
    const item = toMonacoCompletionItem({ label: "println!" }, DEFAULT_RANGE);
    expect(item.range).toEqual(DEFAULT_RANGE);
    expect(item.insertText).toBe("println!");
  });

  it("shifts a textEdit range and takes its text over insertText", () => {
    const item = toMonacoCompletionItem(
      {
        label: "map",
        insertText: "ignored",
        textEdit: {
          range: { start: { line: 9, character: 2 }, end: { line: 9, character: 5 } },
          newText: "map(|x| $0)",
        },
      },
      DEFAULT_RANGE,
    );
    expect(item.range).toEqual({
      startLineNumber: 10,
      startColumn: 3,
      endLineNumber: 10,
      endColumn: 6,
    });
    expect(item.insertText).toBe("map(|x| $0)");
  });

  it("carries both spans of an InsertReplaceEdit", () => {
    const item = toMonacoCompletionItem(
      {
        label: "value",
        textEdit: {
          newText: "value",
          insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
          replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
        },
      },
      DEFAULT_RANGE,
    );
    expect(item.range).toEqual({
      insert: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 },
      replace: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 },
    });
  });

  it("turns insertTextFormat 2 into Monaco's snippet rule", () => {
    const snippet = toMonacoCompletionItem(
      { label: "fn", insertText: "fn $1() {\n\t$0\n}", insertTextFormat: 2 },
      DEFAULT_RANGE,
    );
    expect(snippet.insertTextRules).toBe(MONACO_INSERT_TEXT_RULE.InsertAsSnippet);

    // Plain text must *not* get the rule, or `$0` is eaten as a tab stop.
    const plain = toMonacoCompletionItem(
      { label: "cost", insertText: "cost$0", insertTextFormat: 1 },
      DEFAULT_RANGE,
    );
    expect(plain.insertTextRules).toBeUndefined();
  });

  it("carries detail, sort/filter text, preselect and commit characters", () => {
    const item = toMonacoCompletionItem(
      {
        label: "collect",
        detail: "fn collect<B>() -> B",
        sortText: "0001",
        filterText: "collect",
        preselect: true,
        commitCharacters: ["("],
      },
      DEFAULT_RANGE,
    );
    expect(item.detail).toBe("fn collect<B>() -> B");
    expect(item.sortText).toBe("0001");
    expect(item.filterText).toBe("collect");
    expect(item.preselect).toBe(true);
    expect(item.commitCharacters).toEqual(["("]);
  });

  it("marks deprecation from either the flag or the tag", () => {
    expect(toMonacoCompletionItem({ label: "a", deprecated: true }, DEFAULT_RANGE).tags).toEqual([1]);
    expect(toMonacoCompletionItem({ label: "a", tags: [1] }, DEFAULT_RANGE).tags).toEqual([1]);
    expect(toMonacoCompletionItem({ label: "a" }, DEFAULT_RANGE).tags).toBeUndefined();
  });

  it("shifts the ranges of additional edits too", () => {
    // These are the auto-import edits. A missed shift here inserts the `use`
    // line one line below where it belongs.
    const item = toMonacoCompletionItem(
      {
        label: "HashMap",
        additionalTextEdits: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: "use std::collections::HashMap;\n",
          },
        ],
      },
      DEFAULT_RANGE,
    );
    expect(item.additionalTextEdits?.[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    });
  });

  it("keeps labelDetails as Monaco's structured label", () => {
    const item = toMonacoCompletionItem(
      { label: "push", labelDetails: { detail: "(value)", description: "Vec<T>" } },
      DEFAULT_RANGE,
    );
    expect(item.label).toEqual({ label: "push", detail: "(value)", description: "Vec<T>" });
  });
});

// ── Diagnostics ─────────────────────────────────────────────────────────────

describe("toMarker", () => {
  it("shifts the range and maps the severity", () => {
    const marker = toMarker({
      range: { start: { line: 10, character: 4 }, end: { line: 10, character: 9 } },
      severity: 1,
      message: "cannot find value `foo`",
      source: "rustc",
      code: "E0425",
    });
    expect(marker).toMatchObject({
      startLineNumber: 11,
      startColumn: 5,
      endLineNumber: 11,
      endColumn: 10,
      severity: MONACO_MARKER_SEVERITY.Error,
      message: "cannot find value `foo`",
      source: "rustc",
      code: "E0425",
    });
  });

  it("widens a zero-width range so the squiggle is visible", () => {
    // "expected `;`" is reported at a point. Monaco draws nothing when
    // endColumn equals startColumn.
    const marker = toMarker({
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } },
      message: "expected `;`",
    });
    expect(marker.startColumn).toBe(4);
    expect(marker.endColumn).toBe(5);
  });

  it("does not widen a range that already has width", () => {
    const marker = toMarker({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      message: "x",
    });
    expect(marker.endColumn).toBe(5);
  });

  it("stringifies a numeric code", () => {
    expect(toMarker({ range: r(0, 0, 0, 1), message: "x", code: 2304 }).code).toBe("2304");
  });

  it("keeps the tags LSP and Monaco agree on and drops the rest", () => {
    expect(toMarker({ range: r(0, 0, 0, 1), message: "x", tags: [1, 2, 9] }).tags).toEqual([1, 2]);
    expect(toMarker({ range: r(0, 0, 0, 1), message: "x", tags: [] }).tags).toBeUndefined();
  });
});

function r(sl: number, sc: number, el: number, ec: number): LspRange {
  return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

// ── Hovers and documentation ────────────────────────────────────────────────

describe("hover contents", () => {
  it("passes markdown through and fences plaintext", () => {
    expect(toMarkdown({ kind: "markdown", value: "**bold**" })).toEqual({ value: "**bold**" });
    // A plaintext signature full of `*` and `_` must not be rendered as
    // markdown, or half of it disappears.
    expect(toMarkdown({ kind: "plaintext", value: "fn f(x: *const T)" })).toEqual({
      value: "```\nfn f(x: *const T)\n```",
    });
  });

  it("drops empty documentation instead of rendering an empty box", () => {
    expect(toMarkdown("")).toBeUndefined();
    expect(toMarkdown({ kind: "markdown", value: "" })).toBeUndefined();
    expect(toMarkdown(undefined)).toBeUndefined();
  });

  it("accepts all four shapes servers send hover contents in", () => {
    expect(toHoverContents("plain")).toEqual([{ value: "plain" }]);
    expect(toHoverContents({ kind: "markdown", value: "# h" })).toEqual([{ value: "# h" }]);
    // The deprecated MarkedString object form.
    expect(toHoverContents({ language: "rust", value: "fn f()" })).toEqual([
      { value: "```rust\nfn f()\n```" },
    ]);
    expect(toHoverContents(["a", { kind: "markdown", value: "b" }])).toEqual([
      { value: "a" },
      { value: "b" },
    ]);
  });

  it("returns null for a hover with nothing in it", () => {
    // A server answering with an empty array must not produce an empty popup.
    expect(toMonacoHover({ contents: [] })).toBeNull();
    expect(toMonacoHover({ contents: "" })).toBeNull();
  });

  it("shifts the hover range when there is one", () => {
    const hover = toMonacoHover({ contents: "x", range: r(4, 2, 4, 6) });
    expect(hover?.range).toEqual({
      startLineNumber: 5,
      startColumn: 3,
      endLineNumber: 5,
      endColumn: 7,
    });
  });
});

// ── Signature help ──────────────────────────────────────────────────────────

describe("toMonacoSignatureHelp", () => {
  it("defaults both indices, which LSP allows to be absent and Monaco requires", () => {
    const help = toMonacoSignatureHelp({ signatures: [{ label: "f()" }] });
    expect(help.activeSignature).toBe(0);
    expect(help.activeParameter).toBe(0);
    expect(help.signatures[0].parameters).toEqual([]);
  });

  it("carries parameter labels in both their string and offset forms", () => {
    const help = toMonacoSignatureHelp({
      signatures: [
        { label: "f(a: u32, b: u32)", parameters: [{ label: "a: u32" }, { label: [10, 16] }] },
      ],
      activeSignature: 0,
      activeParameter: 1,
    });
    expect(help.signatures[0].parameters.map((p) => p.label)).toEqual(["a: u32", [10, 16]]);
    expect(help.activeParameter).toBe(1);
  });

  it("keeps a per-signature activeParameter, which disambiguates overloads", () => {
    const help = toMonacoSignatureHelp({
      signatures: [{ label: "f()", activeParameter: 2 }],
      activeParameter: 0,
    });
    expect(help.signatures[0].activeParameter).toBe(2);
  });
});

// ── Symbols ─────────────────────────────────────────────────────────────────

describe("toMonacoDocumentSymbols", () => {
  it("shifts both ranges and recurses into children", () => {
    const symbols = toMonacoDocumentSymbols([
      {
        name: "Editor",
        kind: LSP_SYMBOL_KIND.Class,
        range: r(0, 0, 20, 1),
        selectionRange: r(0, 6, 0, 12),
        children: [
          {
            name: "save",
            kind: LSP_SYMBOL_KIND.Method,
            range: r(4, 2, 8, 3),
            selectionRange: r(4, 6, 4, 10),
          },
        ],
      },
    ]);
    expect(symbols[0].kind).toBe(MONACO_SYMBOL_KIND.Class);
    expect(symbols[0].range.startLineNumber).toBe(1);
    expect(symbols[0].selectionRange.startColumn).toBe(7);
    expect(symbols[0].children?.[0]).toMatchObject({
      name: "save",
      kind: MONACO_SYMBOL_KIND.Method,
    });
    expect(symbols[0].children?.[0].range.startLineNumber).toBe(5);
  });

  it("accepts the flat SymbolInformation form, keeping the container as detail", () => {
    expect(isSymbolInformation({ name: "x", kind: 13, location: { uri: "file:///a", range: r(0, 0, 0, 1) } })).toBe(true);
    const symbols = toMonacoDocumentSymbols([
      {
        name: "COUNT",
        kind: LSP_SYMBOL_KIND.Constant,
        containerName: "config",
        location: { uri: "file:///a.ts", range: r(2, 6, 2, 11) },
      },
    ]);
    expect(symbols[0]).toMatchObject({
      name: "COUNT",
      detail: "config",
      kind: MONACO_SYMBOL_KIND.Constant,
    });
    expect(symbols[0].range.startLineNumber).toBe(3);
    // Flat symbols have one range serving as both.
    expect(symbols[0].selectionRange).toEqual(symbols[0].range);
  });

  it("omits children rather than emitting an empty array", () => {
    const symbols = toMonacoDocumentSymbols([
      { name: "a", kind: 12, range: r(0, 0, 0, 1), selectionRange: r(0, 0, 0, 1), children: [] },
    ]);
    expect(symbols[0].children).toBeUndefined();
  });
});

// ── URIs ────────────────────────────────────────────────────────────────────

describe("uris", () => {
  it("round-trips a path with spaces and non-ASCII characters", () => {
    const path = "/Users/x/My Projects/café/main.rs";
    expect(uriFromPath(path)).toBe("file:///Users/x/My%20Projects/caf%C3%A9/main.rs");
    expect(pathFromUri(uriFromPath(path))).toBe(path);
  });

  it("leaves a plain path's URI unescaped beyond the scheme", () => {
    expect(uriFromPath("/a/b/c.rs")).toBe("file:///a/b/c.rs");
  });

  it("decodes a percent-encoded URI, which is what rust-analyzer sends", () => {
    expect(pathFromUri("file:///Users/x/.cargo/registry/src/a%2Bb/lib.rs")).toBe(
      "/Users/x/.cargo/registry/src/a+b/lib.rs",
    );
  });

  it("rejects a non-file scheme rather than inventing a path", () => {
    expect(pathFromUri("jdt://contents/rt.jar")).toBeNull();
    expect(pathFromUri("untitled:Untitled-1")).toBeNull();
  });

  it("rejects a malformed escape instead of returning a literal %", () => {
    expect(pathFromUri("file:///a/%zz")).toBeNull();
  });
});

// ── Locations ───────────────────────────────────────────────────────────────

describe("toTargets", () => {
  it("accepts a bare Location, an array, and LocationLinks", () => {
    const range = r(7, 4, 7, 9);
    expect(toTargets({ uri: "file:///a.rs", range })).toEqual([
      { path: "/a.rs", range: toMonacoRange(range) },
    ]);
    expect(toTargets([{ uri: "file:///a.rs", range }])).toHaveLength(1);
    expect(
      toTargets([{ targetUri: "file:///a.rs", targetRange: r(0, 0, 9, 0), targetSelectionRange: range }]),
    ).toEqual([{ path: "/a.rs", range: toMonacoRange(range) }]);
  });

  it("prefers the selection range of a LocationLink, falling back to the full one", () => {
    const full = r(0, 0, 9, 0);
    expect(toTargets([{ targetUri: "file:///a.rs", targetRange: full }])).toEqual([
      { path: "/a.rs", range: toMonacoRange(full) },
    ]);
  });

  it("drops targets that are not files instead of opening a bogus path", () => {
    expect(toTargets([{ uri: "jdt://x", range: r(0, 0, 0, 1) }])).toEqual([]);
  });

  it("treats a null answer as no targets", () => {
    expect(toTargets(null)).toEqual([]);
    expect(toTargets(undefined)).toEqual([]);
  });
});

// ── Edits ───────────────────────────────────────────────────────────────────

describe("toEditOperation", () => {
  it("shifts the range and keeps the text verbatim", () => {
    expect(toEditOperation({ range: r(2, 0, 3, 0), newText: "formatted\n" })).toEqual({
      range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      text: "formatted\n",
    });
  });
});
