import type * as Monaco from "monaco-editor";
import { fsApi } from "@/api/fs";

type EditorModel = { path: string; model: Monaco.editor.ITextModel; dirty: boolean };
type OpenFilesMeta = { path: string; dirty: boolean };
type ChangeListener = (files: OpenFilesMeta[], activePath: string | null) => void;

class EditorController {
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private models = new Map<string, EditorModel>();
  private openOrder: string[] = [];
  private activePath: string | null = null;
  private listeners = new Set<ChangeListener>();
  private disposeMap = new Map<string, Monaco.IDisposable>();

  // Resolved once init() completes — openFile() awaits this so rapid clicks work.
  private _initResolve!: () => void;
  private _initPromise: Promise<void> = new Promise(r => { this._initResolve = r; });

  async init(container: HTMLElement, theme: "vs-dark" | "vs" = "vs-dark") {
    if (this.editor) return; // already initialised

    // MonacoEnvironment must be configured before Monaco touches workers.
    (window as any).MonacoEnvironment = {
      getWorker(_: unknown, label: string) {
        if (label === "json")
          return new Worker(new URL("monaco-editor/esm/vs/language/json/json.worker", import.meta.url), { type: "module" });
        if (label === "css" || label === "scss" || label === "less")
          return new Worker(new URL("monaco-editor/esm/vs/language/css/css.worker", import.meta.url), { type: "module" });
        if (label === "html" || label === "handlebars" || label === "razor")
          return new Worker(new URL("monaco-editor/esm/vs/language/html/html.worker", import.meta.url), { type: "module" });
        if (label === "typescript" || label === "javascript")
          return new Worker(new URL("monaco-editor/esm/vs/language/typescript/ts.worker", import.meta.url), { type: "module" });
        return new Worker(new URL("monaco-editor/esm/vs/editor/editor.worker", import.meta.url), { type: "module" });
      },
    };

    const monaco = await import("monaco-editor");
    this.monaco = monaco;

    this.editor = monaco.editor.create(container, {
      model: null,
      theme,
      fontSize: 13,
      fontFamily: "'Geist Mono Variable', 'Geist Mono', monospace",
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      padding: { top: 8, bottom: 8 },
      automaticLayout: true,
    });

    this._initResolve();
  }

  async openFile(path: string) {
    await this._initPromise;
    if (!this.monaco || !this.editor) return;

    if (!this.models.has(path)) {
      let content = "";
      try { content = await fsApi.readFile(path); }
      catch (e) { console.warn("EditorController: failed to read", path, e); }

      const uri = this.monaco.Uri.file(path);
      const lang = inferLanguage(path);
      const model = this.monaco.editor.createModel(content, lang, uri);
      const meta: EditorModel = { path, model, dirty: false };
      this.models.set(path, meta);

      let dirtyTimer: ReturnType<typeof setTimeout> | null = null;
      const disposable = model.onDidChangeContent(() => {
        if (dirtyTimer) clearTimeout(dirtyTimer);
        dirtyTimer = setTimeout(() => {
          const m = this.models.get(path);
          if (m && !m.dirty) { m.dirty = true; this.notify(); }
          dirtyTimer = null;
        }, 100);
      });
      this.disposeMap.set(path, disposable);
    }

    if (!this.openOrder.includes(path)) this.openOrder.push(path);
    this.activePath = path;
    this.editor.setModel(this.models.get(path)!.model);
    requestAnimationFrame(() => this.editor?.layout());
    this.editor.focus();
    this.notify();
  }

  async saveActive() { if (this.activePath) await this.save(this.activePath); }

  async save(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    await fsApi.writeFile(path, meta.model.getValue());
    meta.dirty = false;
    this.notify();
  }

  closeFile(path: string) {
    const meta = this.models.get(path);
    if (!meta) return;
    this.disposeMap.get(path)?.dispose();
    this.disposeMap.delete(path);
    meta.model.dispose();
    this.models.delete(path);
    this.openOrder = this.openOrder.filter(p => p !== path);
    if (this.activePath === path) {
      this.activePath = this.openOrder[this.openOrder.length - 1] ?? null;
      if (this.editor) {
        this.editor.setModel(this.activePath ? (this.models.get(this.activePath)?.model ?? null) : null);
      }
    }
    this.notify();
  }

  setActive(path: string) {
    if (!this.editor || !this.models.has(path)) return;
    this.activePath = path;
    this.editor.setModel(this.models.get(path)!.model);
    requestAnimationFrame(() => this.editor?.layout());
    this.editor.focus();
    this.notify();
  }

  getOpenFiles(): OpenFilesMeta[] {
    return this.openOrder.map(p => ({ path: p, dirty: this.models.get(p)?.dirty ?? false }));
  }

  getActivePath() { return this.activePath; }
  layout() { this.editor?.layout(); }

  subscribe(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const files = this.getOpenFiles();
    const active = this.activePath;
    for (const fn of this.listeners) fn(files, active);
  }
}

export const editorController = new EditorController();

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // Only Monaco built-in language IDs — unknown extensions fall back to plaintext.
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
