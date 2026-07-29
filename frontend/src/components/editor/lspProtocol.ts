/// The LSP wire types and their translation into Monaco's.
///
/// **Why this is hand-rolled and not `monaco-languageclient`.** context7's
/// `/typefox/monaco-languageclient` docs are unambiguous on the point: every
/// entry path — including the one it calls "classic mode" — goes through
/// `MonacoVscodeApiWrapper` from `@codingame/monaco-vscode-api`, and its own
/// troubleshooting page tells you to import the editor as
/// `@codingame/monaco-vscode-api/…/monaco-vscode-editor-api` *instead of*
/// `monaco-editor`. That package is a VS Code Web API shim: it replaces the
/// `monaco-editor` module, brings its own worker factory, its own theme and
/// configuration services, and its own `MonacoEnvironment` handling. VoidLink
/// has all four already — `monaco.ts` owns the single `MonacoEnvironment`
/// assignment for six Monaco surfaces, and `monacoTheme.ts` derives themes from
/// this app's CSS tokens. Adopting the shim means rewriting those and taking on
/// a several-megabyte dependency, and its only transport is
/// `vscode-ws-jsonrpc` over a WebSocket, which is not how a Tauri app talks to
/// a child process. So: a provider layer, written against Monaco's public
/// `languages.register*` API, which is roughly this file plus `lspProviders.ts`.
///
/// **Everything here is pure and DOM-free.** The vitest environment is `node`
/// and importing `monaco-editor` there would fail, so the Monaco *types* are
/// imported type-only (erased at build) and the Monaco *enum values* are
/// written out as numeric literals, each annotated with where it came from.
/// `lspProtocol.test.ts` pins the ones that matter.
///
/// **The off-by-one is the whole job.** LSP positions are 0-based in both axes;
/// Monaco's are 1-based in both. Every range crossing this boundary shifts, and
/// a single missed `+1` is a hover that highlights the wrong word and a
/// diagnostic squiggle one character left of the error. There is exactly one
/// pair of functions that does the shift, `toMonacoPosition` / `toLspPosition`,
/// and everything else composes them.

import type * as Monaco from "monaco-editor";

// ─── Wire types ──────────────────────────────────────────────────────────────
//
// A deliberate subset: the requests this bridge actually issues. Fields the
// providers do not read are omitted rather than typed `unknown`, so adding a
// feature means adding its fields here and being told where they are missing.

export interface LspPosition {
  /// 0-based.
  line: number;
  /// 0-based, in UTF-16 code units under the default position encoding —
  /// which is the same unit Monaco's columns use, so no re-encoding is needed.
  character: number;
}

export interface LspRange {
  start: LspPosition;
  /// Exclusive, like Monaco's end column.
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
}

export interface LspMarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export type LspDocumentation = string | LspMarkupContent;

/// `MarkedString` is deprecated in the specification and still emitted by
/// servers in the field, so hover contents can be any of four shapes.
export type LspHoverContents =
  | string
  | LspMarkupContent
  | { language: string; value: string }
  | Array<string | LspMarkupContent | { language: string; value: string }>;

export interface LspHover {
  contents: LspHoverContents;
  range?: LspRange;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/// LSP 3.17 `InsertReplaceEdit`. Monaco can express both spans, but only
/// through `CompletionItemRanges`, so it is worth carrying.
export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
}

export interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  /// 1-based `Text` … 25 `TypeParameter`. **Not** Monaco's numbering — see
  /// `COMPLETION_KIND`.
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: LspDocumentation;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /// 1 = PlainText, 2 = Snippet.
  insertTextFormat?: number;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  /// Opaque; round-tripped verbatim to `completionItem/resolve`.
  data?: unknown;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspDiagnostic {
  range: LspRange;
  /// 1 = Error, 2 = Warning, 3 = Information, 4 = Hint. **Not** Monaco's
  /// `MarkerSeverity` — see `MARKER_SEVERITY`.
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
  /// 1 = Unnecessary, 2 = Deprecated. Same numbering as Monaco's `MarkerTag`.
  tags?: number[];
}

export interface LspPublishDiagnostics {
  uri: string;
  version?: number;
  diagnostics: LspDiagnostic[];
}

export interface LspParameterInformation {
  label: string | [number, number];
  documentation?: LspDocumentation;
}

export interface LspSignatureInformation {
  label: string;
  documentation?: LspDocumentation;
  parameters?: LspParameterInformation[];
  activeParameter?: number;
}

export interface LspSignatureHelp {
  signatures: LspSignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  /// 1-based `File` … 26 `TypeParameter`. Monaco's is the same order, 0-based.
  kind: number;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/// The flat shape a server may answer `textDocument/documentSymbol` with
/// instead. `typescript-language-server` returns the hierarchical form, but
/// the specification permits either and a server is allowed to change its mind
/// per request.
export interface LspSymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: LspLocation;
}

// ─── Enum tables ─────────────────────────────────────────────────────────────
//
// Monaco's enum values, transcribed from
// `node_modules/monaco-editor/esm/vs/editor/editor.api.d.ts` at 0.55.1. They
// are literals rather than reads off the namespace because this module must
// import Monaco type-only: the test environment is `node`, and evaluating
// `monaco-editor` there touches the DOM.

/// LSP `CompletionItemKind` → Monaco `CompletionItemKind`.
///
/// This table is the one that cannot be computed. Monaco's enum is 0-based
/// *and reordered*: LSP `Text` is 1 and Monaco `Text` is 18, LSP `Method` is 1
/// less than Monaco's `Method` of 0. An arithmetic shortcut here shows a
/// function icon on every keyword.
const COMPLETION_KIND: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 28, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

/// Monaco's `Property` (9): the least wrong icon for a kind we do not know,
/// which is what a server sending a kind from a newer specification looks like.
const COMPLETION_KIND_FALLBACK = 9;

/// LSP `DiagnosticSeverity` → Monaco `MarkerSeverity`.
///
/// Monaco's values are a bitmask (Hint 1, Info 2, Warning 4, Error 8) running
/// in the *opposite* direction to LSP's ordinal (Error 1 … Hint 4). Passing an
/// LSP severity through unchanged turns every error into a hint, which is
/// invisible.
const MARKER_SEVERITY: Record<number, number> = {
  1: 8, // Error
  2: 4, // Warning
  3: 2, // Information → Info
  4: 1, // Hint
};

/// A diagnostic with no severity is an error by specification.
const MARKER_SEVERITY_FALLBACK = 8;

/// LSP `SymbolKind` (1-based) → Monaco `SymbolKind` (0-based). Same order, so
/// this one *is* arithmetic — asserted in the test rather than assumed.
export function symbolKind(lspKind: number): Monaco.languages.SymbolKind {
  const shifted = lspKind - 1;
  // Monaco's enum runs 0…25. Anything else lands on `Variable` (12) rather
  // than producing a kind Monaco will render as a blank icon.
  const safe = shifted >= 0 && shifted <= 25 ? shifted : 12;
  return safe as Monaco.languages.SymbolKind;
}

export function completionKind(lspKind: number | undefined): Monaco.languages.CompletionItemKind {
  if (lspKind === undefined) return COMPLETION_KIND_FALLBACK as Monaco.languages.CompletionItemKind;
  return (COMPLETION_KIND[lspKind] ??
    COMPLETION_KIND_FALLBACK) as Monaco.languages.CompletionItemKind;
}

export function markerSeverity(lspSeverity: number | undefined): Monaco.MarkerSeverity {
  if (lspSeverity === undefined) return MARKER_SEVERITY_FALLBACK as Monaco.MarkerSeverity;
  return (MARKER_SEVERITY[lspSeverity] ?? MARKER_SEVERITY_FALLBACK) as Monaco.MarkerSeverity;
}

// ─── Positions ───────────────────────────────────────────────────────────────

/// LSP → Monaco. The only `+1` in the module.
export function toMonacoPosition(p: LspPosition): { lineNumber: number; column: number } {
  return { lineNumber: p.line + 1, column: p.character + 1 };
}

/// Monaco → LSP. `Math.max(0, …)` because Monaco's minimum is 1 and a caller
/// that hands over a 0 (a default-constructed position, a stale cursor) would
/// otherwise send a negative line the server is entitled to reject.
export function toLspPosition(p: { lineNumber: number; column: number }): LspPosition {
  return { line: Math.max(0, p.lineNumber - 1), character: Math.max(0, p.column - 1) };
}

export function toMonacoRange(r: LspRange): Monaco.IRange {
  const start = toMonacoPosition(r.start);
  const end = toMonacoPosition(r.end);
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
  };
}

export function toLspRange(r: Monaco.IRange): LspRange {
  return {
    start: toLspPosition({ lineNumber: r.startLineNumber, column: r.startColumn }),
    end: toLspPosition({ lineNumber: r.endLineNumber, column: r.endColumn }),
  };
}

// ─── URIs ────────────────────────────────────────────────────────────────────

/// Absolute path for a `file://` URI, or `null` for anything else.
///
/// rust-analyzer answers `textDocument/definition` with URIs pointing into
/// `~/.cargo/registry` and, for built-in types, into the sysroot; those are
/// real files and opening them is correct. What is *not* a file is
/// `jdt://`-style virtual documents from other servers, and `null` is how a
/// caller is told to skip a result rather than opening a path named `jdt:`.
export function pathFromUri(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const withoutScheme = uri.slice("file://".length);
  // `file:///a/b` → authority is empty, path is `/a/b`. A non-empty authority
  // is a UNC path, which this app does not support.
  const slash = withoutScheme.indexOf("/");
  if (slash !== 0) return null;
  let path: string;
  try {
    path = decodeURIComponent(withoutScheme);
  } catch {
    // A malformed escape. Better to skip the result than to open a path
    // containing a literal `%2`.
    return null;
  }
  // Windows: `file:///C:/x` decodes to `/C:/x`.
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
}

/// `file://` URI for an absolute path, matching what `monaco.Uri.file()`
/// produces so the model URI and the URI sent to the server are the same string.
///
/// `encodeURIComponent` escapes `/` too, so the path is encoded segment by
/// segment. Written out rather than delegated to `Uri` because this module is
/// the one the tests import, and `Uri` is not importable in a node environment.
export function uriFromPath(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const withLeadingSlash = normalised.startsWith("/") ? normalised : `/${normalised}`;
  const encoded = withLeadingSlash
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/");
  return `file://${encoded}`;
}

// ─── Documentation and hovers ────────────────────────────────────────────────

/// LSP documentation as a Monaco markdown string, or `undefined` when empty.
///
/// A `plaintext` markup is wrapped in a fenced block rather than passed
/// through: server docs contain `*`, `_` and `<` constantly, and rendering
/// those as markdown mangles half of rust-analyzer's type signatures.
export function toMarkdown(doc: LspDocumentation | undefined): Monaco.IMarkdownString | undefined {
  if (doc === undefined) return undefined;
  if (typeof doc === "string") return doc ? { value: doc } : undefined;
  if (!doc.value) return undefined;
  return doc.kind === "markdown"
    ? { value: doc.value }
    : { value: "```\n" + doc.value + "\n```" };
}

/// Hover contents, in all four shapes servers send them, as Monaco's array of
/// markdown strings. Empty entries are dropped so an empty hover renders as no
/// hover rather than as an empty box.
export function toHoverContents(contents: LspHoverContents): Monaco.IMarkdownString[] {
  const parts = Array.isArray(contents) ? contents : [contents];
  const out: Monaco.IMarkdownString[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      if (part) out.push({ value: part });
      continue;
    }
    if ("kind" in part) {
      const md = toMarkdown(part);
      if (md) out.push(md);
      continue;
    }
    // The deprecated `MarkedString` object form: a code block in `language`.
    if (part.value) out.push({ value: "```" + part.language + "\n" + part.value + "\n```" });
  }
  return out;
}

export function toMonacoHover(hover: LspHover): Monaco.languages.Hover | null {
  const contents = toHoverContents(hover.contents);
  if (contents.length === 0) return null;
  return hover.range ? { contents, range: toMonacoRange(hover.range) } : { contents };
}

// ─── Completion ──────────────────────────────────────────────────────────────

function isInsertReplace(
  edit: LspTextEdit | LspInsertReplaceEdit,
): edit is LspInsertReplaceEdit {
  return "insert" in edit;
}

/// LSP `CompletionItem` → Monaco `CompletionItem`.
///
/// `defaultRange` is the word range under the cursor, which the caller computes
/// from the model. Monaco requires a range on every item; LSP makes `textEdit`
/// optional and expects the client to fall back to "replace the word being
/// typed", so the fallback is not optional here either — an item with no range
/// is silently dropped by Monaco's suggest widget.
export function toMonacoCompletionItem(
  item: LspCompletionItem,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const edit = item.textEdit;
  const range: Monaco.languages.CompletionItem["range"] = edit
    ? isInsertReplace(edit)
      ? { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) }
      : toMonacoRange(edit.range)
    : defaultRange;

  // Precedence per the specification: the edit's text wins, then `insertText`,
  // then the label. A server that sends a `textEdit` and a different
  // `insertText` means the edit.
  const insertText = edit?.newText ?? item.insertText ?? item.label;

  const out: Monaco.languages.CompletionItem = {
    label: item.labelDetails
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label,
    kind: completionKind(item.kind),
    insertText,
    range,
  };

  // `insertTextFormat: 2` is Snippet. Monaco expresses that as a bitmask rule
  // (`InsertAsSnippet` = 4) rather than a format field.
  if (item.insertTextFormat === 2) {
    out.insertTextRules = 4 as Monaco.languages.CompletionItemInsertTextRule;
  }
  if (item.detail) out.detail = item.detail;
  const documentation = toMarkdown(item.documentation);
  if (documentation) out.documentation = documentation;
  if (item.sortText) out.sortText = item.sortText;
  if (item.filterText) out.filterText = item.filterText;
  if (item.preselect) out.preselect = true;
  if (item.commitCharacters?.length) out.commitCharacters = [...item.commitCharacters];
  // Both spellings mean the same thing; `deprecated` predates `tags`.
  if (item.deprecated || item.tags?.includes(1)) {
    out.tags = [1 as Monaco.languages.CompletionItemTag];
  }
  if (item.additionalTextEdits?.length) {
    out.additionalTextEdits = item.additionalTextEdits.map(toEditOperation);
  }
  return out;
}

// ─── Edits ───────────────────────────────────────────────────────────────────

/// An LSP text edit as the `{ range, text }` shape both Monaco's formatting
/// providers and `pushEditOperations` take.
export function toEditOperation(edit: LspTextEdit): { range: Monaco.IRange; text: string } {
  return { range: toMonacoRange(edit.range), text: edit.newText };
}

export function toMonacoTextEdits(edits: LspTextEdit[] | null | undefined): Monaco.languages.TextEdit[] {
  if (!edits) return [];
  return edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/// LSP `Diagnostic` → Monaco marker.
///
/// The zero-width case matters: a server reporting "expected `;` here" sends a
/// range whose start equals its end, and Monaco draws nothing for a marker with
/// `endColumn === startColumn`. Widening by one column is what makes those
/// visible, and is what VS Code does.
export function toMarker(diagnostic: LspDiagnostic): Monaco.editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range);
  const empty =
    range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;

  const marker: Monaco.editor.IMarkerData = {
    severity: markerSeverity(diagnostic.severity),
    message: diagnostic.message,
    startLineNumber: range.startLineNumber,
    startColumn: range.startColumn,
    endLineNumber: range.endLineNumber,
    endColumn: empty ? range.endColumn + 1 : range.endColumn,
  };
  if (diagnostic.source) marker.source = diagnostic.source;
  if (diagnostic.code !== undefined) marker.code = String(diagnostic.code);
  // LSP's `DiagnosticTag` and Monaco's `MarkerTag` happen to agree
  // (Unnecessary = 1, Deprecated = 2), so this is a filter, not a mapping.
  const tags = diagnostic.tags?.filter((t) => t === 1 || t === 2);
  if (tags?.length) marker.tags = tags as Monaco.MarkerTag[];
  return marker;
}

// ─── Signature help ──────────────────────────────────────────────────────────

export function toMonacoSignatureHelp(help: LspSignatureHelp): Monaco.languages.SignatureHelp {
  return {
    signatures: help.signatures.map((sig) => {
      const out: Monaco.languages.SignatureInformation = {
        label: sig.label,
        parameters: (sig.parameters ?? []).map((p) => {
          const param: Monaco.languages.ParameterInformation = { label: p.label };
          const doc = toMarkdown(p.documentation);
          if (doc) param.documentation = doc;
          return param;
        }),
      };
      const doc = toMarkdown(sig.documentation);
      if (doc) out.documentation = doc;
      // Per-signature `activeParameter` overrides the top-level one when
      // present, which is how a server disambiguates overloads.
      if (sig.activeParameter !== undefined) out.activeParameter = sig.activeParameter;
      return out;
    }),
    // Monaco requires both indices; LSP makes both optional and defines the
    // default as 0.
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
  };
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

/// Whether a `textDocument/documentSymbol` answer is the flat form.
export function isSymbolInformation(
  s: LspDocumentSymbol | LspSymbolInformation,
): s is LspSymbolInformation {
  return "location" in s;
}

/// Either documentSymbol shape → Monaco's hierarchical one.
///
/// The flat form is left flat rather than reconstructed into a tree from
/// `containerName`: that reconstruction is ambiguous whenever two symbols share
/// a name, and a flat outline is a truthful outline. The breadcrumb copes.
export function toMonacoDocumentSymbols(
  symbols: Array<LspDocumentSymbol | LspSymbolInformation>,
): Monaco.languages.DocumentSymbol[] {
  return symbols.map((s) => {
    if (isSymbolInformation(s)) {
      const range = toMonacoRange(s.location.range);
      return {
        name: s.name,
        detail: s.containerName ?? "",
        kind: symbolKind(s.kind),
        tags: [],
        range,
        selectionRange: range,
      };
    }
    return {
      name: s.name,
      detail: s.detail ?? "",
      kind: symbolKind(s.kind),
      tags: [],
      range: toMonacoRange(s.range),
      selectionRange: toMonacoRange(s.selectionRange),
      children: s.children?.length ? toMonacoDocumentSymbols(s.children) : undefined,
    };
  });
}

// ─── Locations ───────────────────────────────────────────────────────────────

/// The three shapes `textDocument/definition` can answer with, flattened to
/// `{ path, range }` pairs. Non-`file://` targets are dropped.
///
/// Returns paths rather than `Monaco.Location`s because building one needs
/// `monaco.Uri`, which this module cannot import; `lspProviders.ts` does that
/// last step where the namespace is already in hand.
export function toTargets(
  result: LspLocation | LspLocation[] | LspLocationLink[] | null | undefined,
): Array<{ path: string; range: Monaco.IRange }> {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: Array<{ path: string; range: Monaco.IRange }> = [];
  for (const entry of list) {
    const uri = "targetUri" in entry ? entry.targetUri : entry.uri;
    const range =
      "targetUri" in entry ? (entry.targetSelectionRange ?? entry.targetRange) : entry.range;
    const path = pathFromUri(uri);
    if (path) out.push({ path, range: toMonacoRange(range) });
  }
  return out;
}
