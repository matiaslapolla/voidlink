/// Monaco's one-time setup, in one place.
///
/// The editor window creates several Monaco instances — the code editor, a diff
/// editor per diff tab, four editors per merge tab — and every one of them needs
/// `MonacoEnvironment` configured *before* Monaco first touches a worker. Doing
/// that assignment in more than one module is how you end up with the language
/// workers silently failing to resolve under Vite, so it happens here, once,
/// behind a memoised import that everything else awaits.

import type * as Monaco from "monaco-editor";
import type { EditorSettings } from "@/store/settings";

let loading: Promise<typeof Monaco> | null = null;

/// Import Monaco, configuring its worker resolution on the first call.
///
/// The `new Worker(new URL(...), { type: "module" })` shape is load-bearing:
/// Vite statically analyses exactly that pattern to emit the worker chunks, so
/// the URLs cannot be built dynamically or hoisted into a lookup table.
export function loadMonaco(): Promise<typeof Monaco> {
  if (loading) return loading;
  loading = (async () => {
    (window as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "json")
          return new Worker(
            new URL("monaco-editor/esm/vs/language/json/json.worker.js", import.meta.url),
            { type: "module" },
          );
        if (label === "css" || label === "scss" || label === "less")
          return new Worker(
            new URL("monaco-editor/esm/vs/language/css/css.worker.js", import.meta.url),
            { type: "module" },
          );
        if (label === "html" || label === "handlebars" || label === "razor")
          return new Worker(
            new URL("monaco-editor/esm/vs/language/html/html.worker.js", import.meta.url),
            { type: "module" },
          );
        if (label === "typescript" || label === "javascript")
          return new Worker(
            new URL("monaco-editor/esm/vs/language/typescript/ts.worker.js", import.meta.url),
            { type: "module" },
          );
        return new Worker(
          new URL("monaco-editor/esm/vs/editor/editor.worker.js", import.meta.url),
          { type: "module" },
        );
      },
    };
    return import("monaco-editor");
  })();
  return loading;
}

/// The parts of the editor surface that are VoidLink's, not the user's.
///
/// Chrome, not preference: the overview ruler border and the in-ruler cursor
/// are Monaco decorations that fight the app's own gutter idiom, and
/// `automaticLayout` is load-bearing for the splitter. Nothing here is exposed
/// in Settings, which is why it is separate from the derived options rather
/// than being defaults inside them.
const EDITOR_CHROME = {
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  padding: { top: 8, bottom: 8 },
  automaticLayout: true,
} as const satisfies Monaco.editor.IEditorOptions;

/// Monaco options derived from the store, shared by every surface in the
/// editor window — the code editor, the diff panes and the merge panes — so
/// they read as one typeface and rhythm.
///
/// Pure, and deliberately so: this is the whole settings→Monaco contract in one
/// function, testable without a DOM, and the only place a setting name meets a
/// Monaco option name. Callers spread it into `create` and pass the same object
/// to `updateOptions` when the store changes, which is what makes every setting
/// apply live.
///
/// Note the two exceptions that are *not* here: `tabSize` and `insertSpaces`
/// are model options in Monaco, not editor options, so they go through
/// `modelOptions` below. Passing them to `updateOptions` silently does nothing.
export function editorOptions(
  s: EditorSettings,
): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  return {
    ...EDITOR_CHROME,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    fontLigatures: s.fontLigatures,
    wordWrap: s.wordWrap,
    wordWrapColumn: s.wordWrapColumn,
    wrappingIndent: s.wrappingIndent,
    minimap: { enabled: s.minimap },
    stickyScroll: { enabled: s.stickyScroll },
    bracketPairColorization: { enabled: s.bracketPairColorization },
    renderWhitespace: s.renderWhitespace,
    renderFinalNewline: s.renderFinalNewline,
    rulers: [...s.rulers],
    guides: {
      indentation: s.indentGuides,
      highlightActiveIndentation: s.indentGuides,
      bracketPairs: s.bracketPairGuides,
    },
    lineNumbers: s.lineNumbers,
    renderLineHighlight: s.renderLineHighlight,
    folding: s.folding,
    foldingStrategy: s.foldingStrategy,
    showFoldingControls: s.showFoldingControls,
    cursorStyle: s.cursorStyle,
    cursorBlinking: s.cursorBlinking,
    cursorSurroundingLines: s.cursorSurroundingLines,
    multiCursorModifier: s.multiCursorModifier,
    smoothScrolling: s.smoothScrolling,
    scrollBeyondLastLine: s.scrollBeyondLastLine,
    mouseWheelZoom: s.mouseWheelZoom,
    scrollbar: {
      verticalScrollbarSize: s.scrollbarVerticalSize,
      horizontalScrollbarSize: s.scrollbarHorizontalSize,
    },
    suggestOnTriggerCharacters: s.suggestOnTriggerCharacters,
    // Monaco's default is the object below, *not* the bare boolean: `true`
    // would also suggest inside comments and string literals, which is a
    // different editor. The setting is one switch over `other` alone.
    quickSuggestions: {
      other: s.quickSuggestions ? "on" : "off",
      comments: "off",
      strings: "off",
    },
    acceptSuggestionOnEnter: s.acceptSuggestionOnEnter,
    snippetSuggestions: s.snippetSuggestions,
    inlayHints: { enabled: s.inlayHints ? "on" : "off" },
    parameterHints: { enabled: s.parameterHints },
    occurrencesHighlight: s.occurrencesHighlight,
    selectionHighlight: s.selectionHighlight,
    unicodeHighlight: {
      ambiguousCharacters: s.unicodeHighlight,
      invisibleCharacters: s.unicodeHighlight,
    },
    autoClosingBrackets: s.autoClosingBrackets,
    autoSurround: s.autoSurround,
    linkedEditing: s.linkedEditing,
    // `detectIndentation` is an `IGlobalEditorOptions` field, so it rides along
    // here; making it apply to an *already open* model additionally needs the
    // `model.detectIndentation` call in `applyModelSettings`.
    detectIndentation: s.detectIndentation,
  };
}

/// The settings Monaco keeps on the *model* rather than the editor. Applied
/// per model on creation and on every settings change; see the note in
/// `editorOptions`.
export function modelOptions(s: EditorSettings): Monaco.editor.ITextModelUpdateOptions {
  return {
    tabSize: s.tabSize,
    insertSpaces: s.insertSpaces,
    trimAutoWhitespace: s.trimAutoWhitespace,
  };
}

/// Push the model half of the settings into one live model.
///
/// The only thing here that `modelOptions` cannot express: `detectIndentation`
/// is not a model *option*, it is a model *method*, and Monaco only calls it
/// when a model is created. Calling it here is what makes the setting apply to
/// the buffers already open instead of only to the next file you touch — the
/// "a setting that only takes effect on reload is a bug" rule, kept honest.
///
/// Ordering matters: the explicit tab size goes in first as the fallback the
/// detection starts from, then detection overwrites it when it finds evidence.
export function applyModelSettings(model: Monaco.editor.ITextModel, s: EditorSettings) {
  model.updateOptions(modelOptions(s));
  if (s.detectIndentation) model.detectIndentation(s.insertSpaces, s.tabSize);
}

/// Extension → Monaco language id. Exported as a constant rather than kept
/// inside `inferLanguage` because the per-language settings overrides need the
/// *set of ids*, and deriving it from the same table is what stops the picker
/// offering a language no buffer in this app can ever be in.
const EXTENSION_LANGUAGES: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", jsonc: "json",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html",
    xml: "xml", svg: "xml",
    rs: "rust",
    toml: "ini",       // Monaco has no TOML; INI tokenizer is the closest match
    yaml: "yaml", yml: "yaml",
    md: "markdown",
    py: "python",
    sh: "shell", bash: "shell",
    go: "go",
    java: "java",
    c: "c", cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp",
    cs: "csharp",
    sql: "sql",
    graphql: "graphql", gql: "graphql",
    dockerfile: "dockerfile",
    rb: "ruby",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    r: "r",
    lua: "lua",
    powershell: "powershell", ps1: "powershell",
};

/// Every language id a buffer in this app can be in, sorted, with `plaintext`
/// first because it is the fallback rather than a choice.
export const MONACO_LANGUAGE_IDS: readonly string[] = [
  "plaintext",
  ...[...new Set(Object.values(EXTENSION_LANGUAGES))].sort(),
];

/// Monaco's built-in language id for a path's extension. Unknown extensions
/// fall back to plaintext rather than guessing.
export function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGES[ext] ?? "plaintext";
}
