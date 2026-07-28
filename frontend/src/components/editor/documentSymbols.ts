/// The bridge between Monaco's document-symbol contract and VoidLink's outline.
///
/// Two directions, and they are not the same job:
///
///   *Out* — `installOutlineProvider` hands the `outline.ts` parser to Monaco as
///   a real `DocumentSymbolProvider`, so Monaco's own features (sticky scroll,
///   the outline model behind ⇧⌘O's built-in) see symbols for Rust, Go, Python
///   and Markdown, which it otherwise has none for.
///
///   *In* — `documentOutline` is how VoidLink's breadcrumb and symbol picker
///   ask "what symbols does this model have?". Monaco has no public API for
///   *querying* its provider registry (`registerDocumentSymbolProvider` returns
///   a disposable and nothing else), so we keep our own list of the sources we
///   registered and ask them directly. Wave 5's language servers register
///   through `registerSymbolSource` and are preferred automatically, at which
///   point the regex parser stops being consulted for those languages.
///
/// Monaco's *chrome* is not imported anywhere here — no breadcrumb widget, no
/// outline pane. MASTER §11.5 names Monaco-drift as this module's identity
/// risk, and the symbol data is the part worth taking.

import type * as Monaco from "monaco-editor";
import {
  OUTLINE_LANGUAGES,
  parseOutline,
  type OutlineKind,
  type OutlineNode,
} from "./outline";

/// Something that can answer "what symbols are in this model?". The shape is
/// Monaco's so an LSP-backed provider is registrable as-is, in both directions,
/// without a second adapter.
export type SymbolSource = (
  model: Monaco.editor.ITextModel,
) => Monaco.languages.DocumentSymbol[] | Promise<Monaco.languages.DocumentSymbol[] | null> | null;

interface RegisteredSource {
  languages: readonly string[];
  source: SymbolSource;
}

/// Newest last. `documentOutline` walks this backwards, so a language server
/// registered after boot wins over the fallback without either knowing about
/// the other.
const sources: RegisteredSource[] = [];

/// Register a symbol source with Monaco *and* with the query path above.
///
/// The Wave 5 seam: an LSP client calls this instead of
/// `monaco.languages.registerDocumentSymbolProvider` directly, and both the
/// editor's own features and VoidLink's breadcrumb pick it up at once.
export function registerSymbolSource(
  monaco: typeof Monaco,
  languages: readonly string[],
  source: SymbolSource,
): Monaco.IDisposable {
  const entry: RegisteredSource = { languages, source };
  sources.push(entry);
  const disposable = monaco.languages.registerDocumentSymbolProvider([...languages], {
    displayName: "VoidLink",
    provideDocumentSymbols: (model) => source(model),
  });
  return {
    dispose() {
      const i = sources.indexOf(entry);
      if (i >= 0) sources.splice(i, 1);
      disposable.dispose();
    },
  };
}

let fallbackInstalled = false;

/// Give Monaco the regex outline for the languages it has no provider for.
///
/// Idempotent: called from every editor group's init, and a second
/// registration would mean Monaco's own outline listing every symbol twice.
export function installOutlineProvider(monaco: typeof Monaco) {
  if (fallbackInstalled) return;
  fallbackInstalled = true;
  monaco.languages.registerDocumentSymbolProvider([...OUTLINE_LANGUAGES], {
    displayName: "VoidLink outline",
    provideDocumentSymbols: (model) =>
      toDocumentSymbols(monaco, parseOutline(model.getLanguageId(), model.getValue())),
  });
}

/// The symbols in `model`, as VoidLink's own tree.
///
/// A registered source wins; an empty answer from one falls through to the next,
/// because a language server that is still indexing returns `[]` and a
/// breadcrumb that empties itself for ten seconds on every file open is worse
/// than one showing approximate symbols.
export async function documentOutline(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
): Promise<OutlineNode[]> {
  const languageId = model.getLanguageId();
  for (let i = sources.length - 1; i >= 0; i--) {
    if (!sources[i].languages.includes(languageId)) continue;
    try {
      const symbols = await sources[i].source(model);
      if (symbols && symbols.length > 0) return fromDocumentSymbols(monaco, symbols);
    } catch (e) {
      // A provider that throws must not take the breadcrumb with it.
      console.debug("[outline] provider failed for", languageId, e);
    }
  }
  return parseOutline(languageId, model.getValue());
}

// ── Kind mapping ───────────────────────────────────────────────────────────
//
// One table, read both ways. `variable` is the landing spot for every LSP kind
// VoidLink's outline has no word for, which is correct: the breadcrumb shows
// the name, and inventing eight more kinds to distinguish an LSP `Field` from
// an LSP `Property` would buy nothing any surface renders.

function kindTable(monaco: typeof Monaco): Record<OutlineKind, Monaco.languages.SymbolKind> {
  const K = monaco.languages.SymbolKind;
  return {
    class: K.Class,
    interface: K.Interface,
    enum: K.Enum,
    function: K.Function,
    method: K.Method,
    module: K.Module,
    struct: K.Struct,
    constant: K.Constant,
    variable: K.Variable,
    section: K.Namespace,
  };
}

function outlineKindOf(monaco: typeof Monaco, kind: Monaco.languages.SymbolKind): OutlineKind {
  const table = kindTable(monaco);
  for (const [name, value] of Object.entries(table)) {
    if (value === kind) return name as OutlineKind;
  }
  return "variable";
}

export function toDocumentSymbols(
  monaco: typeof Monaco,
  nodes: readonly OutlineNode[],
): Monaco.languages.DocumentSymbol[] {
  const table = kindTable(monaco);
  return nodes.map((node) => ({
    name: node.name,
    detail: node.detail,
    kind: table[node.kind],
    tags: [],
    range: {
      startLineNumber: node.line,
      startColumn: 1,
      endLineNumber: node.endLine,
      endColumn: Number.MAX_SAFE_INTEGER,
    },
    selectionRange: {
      startLineNumber: node.line,
      startColumn: node.column,
      endLineNumber: node.line,
      endColumn: node.column + node.name.length,
    },
    children: node.children.length ? toDocumentSymbols(monaco, node.children) : undefined,
  }));
}

export function fromDocumentSymbols(
  monaco: typeof Monaco,
  symbols: readonly Monaco.languages.DocumentSymbol[],
): OutlineNode[] {
  return symbols.map((s) => ({
    name: s.name,
    detail: s.detail ?? "",
    kind: outlineKindOf(monaco, s.kind),
    line: s.selectionRange.startLineNumber,
    column: s.selectionRange.startColumn,
    endLine: Math.max(s.range.endLineNumber, s.selectionRange.startLineNumber),
    children: s.children?.length ? fromDocumentSymbols(monaco, s.children) : [],
  }));
}
