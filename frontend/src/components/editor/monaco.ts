/// Monaco's one-time setup, in one place.
///
/// The editor window creates several Monaco instances — the code editor, a diff
/// editor per diff tab, four editors per merge tab — and every one of them needs
/// `MonacoEnvironment` configured *before* Monaco first touches a worker. Doing
/// that assignment in more than one module is how you end up with the language
/// workers silently failing to resolve under Vite, so it happens here, once,
/// behind a memoised import that everything else awaits.

import type * as Monaco from "monaco-editor";

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

/// Editor options every surface in the editor window shares, so the code
/// editor, the diff panes and the merge panes read as one typeface and rhythm.
export const SHARED_EDITOR_OPTIONS = {
  fontSize: 13,
  fontFamily: "'Geist Mono Variable', 'Geist Mono', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "line",
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  padding: { top: 8, bottom: 8 },
  automaticLayout: true,
} as const satisfies Monaco.editor.IEditorOptions;

/// Monaco's built-in language id for a path's extension. Unknown extensions
/// fall back to plaintext rather than guessing.
export function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
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
  return map[ext] ?? "plaintext";
}
