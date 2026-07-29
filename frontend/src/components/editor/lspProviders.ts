/// Monaco providers backed by a language server.
///
/// Registered **once per server spec**, for the life of the window, against a
/// `resolve()` that answers "which session is live right now, if any". That
/// indirection is the whole reason this file is separate from the bridge: a
/// server that crashes and restarts gets a new session, and re-registering
/// providers per session would leak one registration per crash — after three
/// restarts Monaco would ask three dead clients for completions and show the
/// suggest widget three times.
///
/// `resolve()` returning `null` — no binary, server not started yet, session
/// dead — makes every provider answer "nothing". That is the degradation path:
/// Monaco's own TypeScript worker and the regex outline keep working, because
/// providers compose rather than replace.
///
/// Ranges cross the LSP/Monaco boundary in every function here. None of them
/// does the arithmetic itself; it all goes through `lspProtocol.ts`.

import type * as Monaco from "monaco-editor";
import { registerSymbolSource } from "./documentSymbols";
import type { LspServerSpec } from "./lspServers";
import {
  toMarker,
  toMonacoCompletionItem,
  toMonacoDocumentSymbols,
  toMonacoHover,
  toMonacoSignatureHelp,
  toMonacoTextEdits,
  toLspPosition,
  toLspRange,
  toTargets,
  type LspCompletionItem,
  type LspCompletionList,
  type LspDocumentSymbol,
  type LspHover,
  type LspLocation,
  type LspLocationLink,
  type LspSignatureHelp,
  type LspSymbolInformation,
  type LspTextEdit,
} from "./lspProtocol";

/// What a provider needs from the session it is talking to. Deliberately small:
/// the providers know nothing about processes, restarts or status.
export interface LspSessionHandle {
  /// Issue a request, aborting it if Monaco cancels.
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  /// The `textDocument.uri` for a model, as the server knows it. The session
  /// owns this because it is also what `didOpen` used.
  documentUri(model: Monaco.editor.ITextModel): string;
  /// Capabilities the server announced, so a provider can decline rather than
  /// issue a request the server will answer with MethodNotFound on every
  /// keystroke.
  supports(capability: string): boolean;
  /// Trigger characters the server asked for, defaulted by the caller.
  completionTriggers: readonly string[];
  signatureTriggers: readonly string[];
}

/// Turn Monaco's cancellation token into an `AbortSignal`.
///
/// The two are the same idea with different spellings, and doing the adaptation
/// here is what keeps `lspClient.ts` free of Monaco imports.
function abortOn(token: Monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/// A request whose failure is not worth surfacing.
///
/// Every provider here is speculative — Monaco asks for a hover on mouse move
/// and completions on every keystroke — so a rejection means "show nothing",
/// never "tell the user". Genuine ill health is reported through the client's
/// outcome callback, which feeds the `degraded` status; this is where it stops
/// being a per-call concern.
async function attempt<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch {
    return null;
  }
}

/// The word under `position`, as the range a completion with no `textEdit`
/// should replace. LSP leaves this to the client and Monaco requires it.
function wordRangeAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): Monaco.IRange {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    // The cursor, not the end of the word: typing in the middle of an
    // identifier should complete the prefix, not swallow the suffix.
    endColumn: position.column,
  };
}

/// Register every provider for `spec`. Returns one disposable that unregisters
/// all of them.
export function registerLspProviders(
  monaco: typeof Monaco,
  spec: LspServerSpec,
  resolve: () => LspSessionHandle | null,
): Monaco.IDisposable {
  const languages = [...spec.monacoLanguages];
  const disposables: Monaco.IDisposable[] = [];

  // ── Completion ───────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider(languages, {
      // Monaco only calls the provider on these characters (plus word starts).
      // Read off the session so rust-analyzer's `:` and `.` and
      // typescript-language-server's `<` and `@` all work; the fallback covers
      // a session that has not started yet, since Monaco reads this property
      // at registration time and never again.
      get triggerCharacters() {
        return [...(resolve()?.completionTriggers ?? [".", ":", "<", '"', "'", "/", "@"])];
      },
      async provideCompletionItems(model, position, _context, token) {
        const session = resolve();
        if (!session?.supports("completionProvider")) return { suggestions: [] };
        const result = await attempt(
          session.request<LspCompletionList | LspCompletionItem[] | null>(
            "textDocument/completion",
            {
              textDocument: { uri: session.documentUri(model) },
              position: toLspPosition(position),
            },
            abortOn(token),
          ),
        );
        if (!result) return { suggestions: [] };
        const items = Array.isArray(result) ? result : result.items;
        const incomplete = Array.isArray(result) ? false : result.isIncomplete;
        const defaultRange = wordRangeAt(model, position);
        return {
          suggestions: items.map((item) => toMonacoCompletionItem(item, defaultRange)),
          // Load-bearing: with `incomplete` unset Monaco filters the first
          // response client-side forever, and rust-analyzer's completions are
          // prefix-dependent — it must be re-asked on each character.
          incomplete,
        };
      },
    }),
  );

  // ── Hover ────────────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerHoverProvider(languages, {
      async provideHover(model, position, token) {
        const session = resolve();
        if (!session?.supports("hoverProvider")) return null;
        const hover = await attempt(
          session.request<LspHover | null>(
            "textDocument/hover",
            {
              textDocument: { uri: session.documentUri(model) },
              position: toLspPosition(position),
            },
            abortOn(token),
          ),
        );
        return hover ? toMonacoHover(hover) : null;
      },
    }),
  );

  // ── Signature help ───────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerSignatureHelpProvider(languages, {
      get signatureHelpTriggerCharacters() {
        return [...(resolve()?.signatureTriggers ?? ["(", ","])];
      },
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(model, position, token) {
        const session = resolve();
        if (!session?.supports("signatureHelpProvider")) return null;
        const help = await attempt(
          session.request<LspSignatureHelp | null>(
            "textDocument/signatureHelp",
            {
              textDocument: { uri: session.documentUri(model) },
              position: toLspPosition(position),
            },
            abortOn(token),
          ),
        );
        if (!help || help.signatures.length === 0) return null;
        return {
          value: toMonacoSignatureHelp(help),
          // Monaco owns the widget's lifetime and calls this when it closes.
          // Nothing to release — the value is a plain object.
          dispose() {},
        };
      },
    }),
  );

  // ── Definition ───────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerDefinitionProvider(languages, {
      async provideDefinition(model, position, token) {
        const session = resolve();
        if (!session?.supports("definitionProvider")) return null;
        const result = await attempt(
          session.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(
            "textDocument/definition",
            {
              textDocument: { uri: session.documentUri(model) },
              position: toLspPosition(position),
            },
            abortOn(token),
          ),
        );
        return toTargets(result).map((t) => ({
          uri: monaco.Uri.file(t.path),
          range: t.range,
        }));
      },
    }),
  );

  // ── References ───────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerReferenceProvider(languages, {
      async provideReferences(model, position, context, token) {
        const session = resolve();
        if (!session?.supports("referencesProvider")) return null;
        const result = await attempt(
          session.request<LspLocation[] | null>(
            "textDocument/references",
            {
              textDocument: { uri: session.documentUri(model) },
              position: toLspPosition(position),
              context: { includeDeclaration: context.includeDeclaration },
            },
            abortOn(token),
          ),
        );
        return toTargets(result).map((t) => ({
          uri: monaco.Uri.file(t.path),
          range: t.range,
        }));
      },
    }),
  );

  // ── Document symbols ─────────────────────────────────────────────────────
  //
  // Through `registerSymbolSource`, not `registerDocumentSymbolProvider`: that
  // is the seam the outline was built against, and going through it registers
  // with Monaco *and* makes VoidLink's breadcrumb and ⇧⌘O prefer the server's
  // symbols over the regex parser automatically (newest source wins).
  disposables.push(
    registerSymbolSource(monaco, languages, async (model) => {
      const session = resolve();
      if (!session?.supports("documentSymbolProvider")) return null;
      const result = await attempt(
        session.request<Array<LspDocumentSymbol | LspSymbolInformation> | null>(
          "textDocument/documentSymbol",
          { textDocument: { uri: session.documentUri(model) } },
        ),
      );
      return result ? toMonacoDocumentSymbols(result) : null;
    }),
  );

  // ── Formatting ───────────────────────────────────────────────────────────
  //
  // This is also what makes `formatOnSave` real: `editorController.save` runs
  // `editor.action.formatDocument`, which was a no-op until a provider existed.
  disposables.push(
    monaco.languages.registerDocumentFormattingEditProvider(languages, {
      displayName: spec.id,
      async provideDocumentFormattingEdits(model, options, token) {
        const session = resolve();
        if (!session?.supports("documentFormattingProvider")) return [];
        const edits = await attempt(
          session.request<LspTextEdit[] | null>(
            "textDocument/formatting",
            {
              textDocument: { uri: session.documentUri(model) },
              options: {
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
              },
            },
            abortOn(token),
          ),
        );
        return toMonacoTextEdits(edits);
      },
    }),
  );

  disposables.push(
    monaco.languages.registerDocumentRangeFormattingEditProvider(languages, {
      displayName: spec.id,
      async provideDocumentRangeFormattingEdits(model, range, options, token) {
        const session = resolve();
        if (!session?.supports("documentRangeFormattingProvider")) return [];
        const edits = await attempt(
          session.request<LspTextEdit[] | null>(
            "textDocument/rangeFormatting",
            {
              textDocument: { uri: session.documentUri(model) },
              range: toLspRange(range),
              options: {
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
              },
            },
            abortOn(token),
          ),
        );
        return toMonacoTextEdits(edits);
      },
    }),
  );

  return {
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}

/// Publish a server's diagnostics onto a model.
///
/// The owner string is the server id, so two servers cannot clear each other's
/// markers and Monaco's own TypeScript worker (owner `typescript`) keeps its
/// own — which is what lets both sets show at once rather than one replacing
/// the other on every publish.
export function applyDiagnostics(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  owner: string,
  diagnostics: Parameters<typeof toMarker>[0][],
) {
  monaco.editor.setModelMarkers(model, owner, diagnostics.map(toMarker));
}
