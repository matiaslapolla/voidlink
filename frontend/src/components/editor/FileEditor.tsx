import { createSignal, createEffect, on, onCleanup, Show, For, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { createHighlighter, type Highlighter } from "shiki";
import { Image, Code } from "lucide-solid";
import { useTheme } from "@/store/theme";
import { useEditorSettings } from "@/store/editor-settings";
import { gitApi, type BlameLineInfo } from "@/api/git";
import { useLayout } from "@/store/LayoutContext";
import {
  getDiagnosticsForFile,
  notifyFileOpened,
  notifyFileClosed,
  getHoverInfo,
  gotoDefinition,
  detectLspServers,
  initialized as lspInitialized,
} from "@/store/lsp-state";
import type { LspDiagnostic } from "@/api/lsp";

interface FileEditorProps {
  filePath: string | null;
  tabId: string;
  workspaceId: string;
  repoPath?: string | null;
}

// ─── Language detection ─────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript",
  cjs: "javascript", mts: "typescript", cts: "typescript",
  rs: "rust", py: "python", go: "go", json: "json", jsonc: "json",
  toml: "toml", yaml: "yaml", yml: "yaml", md: "markdown", mdx: "mdx",
  html: "html", htm: "html", css: "css", scss: "scss", less: "css",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  dockerfile: "dockerfile", xml: "xml", svg: "xml",
  vue: "vue", svelte: "svelte",
  c: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp", hxx: "cpp",
  java: "java", kt: "kotlin", kts: "kotlin",
  swift: "swift", rb: "ruby", php: "php", lua: "lua", zig: "zig",
  ex: "elixir", exs: "elixir", erl: "erlang",
  dart: "dart", r: "r", jl: "julia",
  graphql: "graphql", gql: "graphql",
  tf: "hcl", hcl: "hcl",
  prisma: "prisma",
  proto: "proto",
  txt: "text", log: "text", env: "text",
  makefile: "make", mk: "make",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const SVG_EXT = "svg";

function getExtFromPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function getLangFromPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  const lower = name.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === "makefile" || lower === "gnumakefile") return "make";
  if (lower === ".gitignore" || lower === ".dockerignore") return "text";
  if (lower.endsWith(".lock")) return "text";
  if (lower === "cargo.toml" || lower === "pyproject.toml") return "toml";
  const ext = getExtFromPath(path);
  return EXT_TO_LANG[ext] || "text";
}

// ─── Shiki highlighter (singleton, lazy) ────────────────────────────────────

let highlighterPromise: Promise<Highlighter> | null = null;

// Common languages to pre-load for instant highlighting
const PRELOAD_LANGS = [
  "typescript", "tsx", "javascript", "jsx", "rust", "python", "go",
  "json", "toml", "yaml", "markdown", "html", "css", "scss", "sql",
  "bash", "xml", "c", "cpp",
] as const;

/** Map app theme IDs → Shiki theme names */
const THEME_TO_SHIKI: Record<string, string> = {
  dark: "github-dark-default",
  light: "github-light-default",
  "github-dark": "github-dark-default",
  "github-light": "github-light-default",
  monokai: "monokai",
  "solarized-dark": "solarized-dark",
  "solarized-light": "solarized-light",
  nord: "nord",
  dracula: "dracula",
  "one-dark": "one-dark-pro",
};

const ALL_SHIKI_THEMES = [...new Set(Object.values(THEME_TO_SHIKI))] as const;

function getShikiHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...ALL_SHIKI_THEMES],
      langs: [...PRELOAD_LANGS],
    });
  }
  return highlighterPromise;
}

function getShikiTheme(appThemeId: string, themeMode: string): string {
  return THEME_TO_SHIKI[appThemeId] ?? (themeMode === "dark" ? "github-dark-default" : "github-light-default");
}

// ─── Image viewer ───────────────────────────────────────────────────────────

function ImageViewer(props: { filePath: string }) {
  const [dataUrl, setDataUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const mimeType = () => {
    const ext = getExtFromPath(props.filePath);
    const map: Record<string, string> = {
      png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
      gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
      ico: "image/x-icon", avif: "image/avif",
    };
    return map[ext] || "image/png";
  };

  createEffect(
    on(
      () => props.filePath,
      async (path) => {
        setError(null);
        setDataUrl(null);
        try {
          const b64 = await invoke<string>("read_file_base64", { path });
          setDataUrl(`data:${mimeType()};base64,${b64}`);
        } catch (e) {
          setError(String(e));
        }
      },
    ),
  );

  return (
    <div class="flex items-center justify-center h-full p-8 overflow-auto">
      <Show when={error()}>
        <span class="text-xs text-destructive">{error()}</span>
      </Show>
      <Show when={dataUrl()}>
        {(url) => (
          <img
            src={url()}
            alt={props.filePath.split("/").pop()}
            class="max-w-full max-h-full object-contain rounded-md shadow-lg border border-border"
            draggable={false}
          />
        )}
      </Show>
    </div>
  );
}

// ─── SVG viewer ─────────────────────────────────────────────────────────────

function SvgViewer(props: { filePath: string; content: string }) {
  const [mode, setMode] = createSignal<"preview" | "source">("preview");

  return (
    <div class="flex flex-col h-full">
      <div class="flex items-center gap-1 px-3 py-1 border-b border-border/50 shrink-0">
        <button
          onClick={() => setMode("preview")}
          class={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
            mode() === "preview" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Image class="w-3 h-3" />
          Preview
        </button>
        <button
          onClick={() => setMode("source")}
          class={`flex items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
            mode() === "source" ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Code class="w-3 h-3" />
          Source
        </button>
      </div>
      <div class="flex-1 overflow-auto">
        <Show
          when={mode() === "preview"}
          fallback={<CodeView filePath={props.filePath} content={props.content} />}
        >
          <div class="flex items-center justify-center h-full p-8">
            <div
              class="max-w-full max-h-full [&_svg]:max-w-full [&_svg]:max-h-[70vh]"
              innerHTML={props.content}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}

// ─── Code view with line numbers and git info ──────────────────────────────

function CodeView(props: {
  filePath: string;
  content: string;
  repoPath?: string | null;
  workspaceId?: string;
  editBuffer: string;
  onEdit: (text: string) => void;
  scrollToLine?: number;
}) {
  const [lines, setLines] = createSignal<string[]>([]);
  const [lineChanges, setLineChanges] = createSignal<Map<number, string>>(new Map());
  const [blameData, setBlameData] = createSignal<BlameLineInfo[]>([]);
  const [hoveredLine, setHoveredLine] = createSignal<number | null>(null);
  const [hoverInfo, setHoverInfo] = createSignal<string | null>(null);
  const [hoverPos, setHoverPos] = createSignal<{ x: number; y: number } | null>(null);
  const { mode, theme: themeId } = useTheme();
  const editorSettings = useEditorSettings();
  const [, actions] = useLayout();

  let textareaRef: HTMLTextAreaElement | undefined;
  let highlightRef: HTMLDivElement | undefined;
  let gutterRef: HTMLDivElement | undefined;
  let scrollContainerRef: HTMLDivElement | undefined;

  // LSP diagnostics for this file
  const diagnostics = createMemo(() => getDiagnosticsForFile(props.filePath));

  // Notify LSP on file open
  createEffect(
    on(
      () => [props.filePath, props.content, props.repoPath] as const,
      ([filePath, content, repoPath]) => {
        if (!filePath || !content || !repoPath) return;
        if (!lspInitialized()) detectLspServers();
        notifyFileOpened(filePath, content, repoPath);
      },
    ),
  );

  // LSP hover handler
  let hoverTimeout: ReturnType<typeof setTimeout> | undefined;
  const handleHover = async (e: MouseEvent) => {
    clearTimeout(hoverTimeout);
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const es = editorSettings();
    const relY = e.clientY - rect.top - 12;
    const relX = e.clientX - rect.left - 16;
    const line = Math.floor(relY / (es.fontSize * es.lineHeight));
    const char = Math.floor(relX / (es.fontSize * 0.6));

    if (line < 0 || char < 0) {
      setHoverInfo(null);
      setHoverPos(null);
      return;
    }

    hoverTimeout = setTimeout(async () => {
      const result = await getHoverInfo(props.filePath, line, char);
      if (result) {
        setHoverInfo(result);
        setHoverPos({ x: relX, y: relY });
      } else {
        setHoverInfo(null);
        setHoverPos(null);
      }
    }, 300);
  };

  // Ctrl+Click go-to-definition
  const handleGotoDefinition = async (e: MouseEvent) => {
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const es = editorSettings();
    const relY = e.clientY - rect.top - 12;
    const relX = e.clientX - rect.left - 16;
    const line = Math.floor(relY / (es.fontSize * es.lineHeight));
    const char = Math.floor(relX / (es.fontSize * 0.6));

    if (line < 0 || char < 0) return;

    const loc = await gotoDefinition(props.filePath, line, char);
    if (loc) {
      if (props.workspaceId) actions.openFile(props.workspaceId, loc.uri);
    }
  };

  // Fetch git diff line info
  createEffect(
    on(
      () => [props.filePath, props.repoPath] as const,
      async ([filePath, repoPath]) => {
        if (!repoPath || !filePath) {
          setLineChanges(new Map());
          setBlameData([]);
          return;
        }
        try {
          const changes = await gitApi.diffFileLines(repoPath, filePath);
          const map = new Map<number, string>();
          for (const c of changes) map.set(c.line, c.changeType);
          setLineChanges(map);
        } catch {
          setLineChanges(new Map());
        }
        try {
          const blame = await gitApi.blameFile(repoPath, filePath);
          setBlameData(blame);
        } catch {
          setBlameData([]);
        }
      },
    ),
  );

  const getBlameForLine = (lineNo: number): BlameLineInfo | undefined => {
    return blameData().find(
      (b) => lineNo >= b.startLine && lineNo < b.startLine + b.numLines,
    );
  };

  const formatBlameDate = (ts: number) => {
    const d = new Date(ts * 1000);
    const now = Date.now();
    const diff = now - d.getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  // Highlight the edit buffer (debounced for performance while typing)
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      [() => props.editBuffer, themeId, mode],
      ([text, currentThemeId, currentMode]) => {
        if (!text) {
          setLines([]);
          return;
        }
        clearTimeout(highlightTimer);
        highlightTimer = setTimeout(async () => {
          try {
            const hl = await getShikiHighlighter();
            const lang = getLangFromPath(props.filePath);
            const shikiTheme = getShikiTheme(currentThemeId, currentMode);

            const loadedLangs = hl.getLoadedLanguages();
            if (!loadedLangs.includes(lang as any) && lang !== "text") {
              try {
                await hl.loadLanguage(lang as any);
              } catch { /* fallback to text */ }
            }

            const effectiveLang = hl.getLoadedLanguages().includes(lang as any) ? lang : "text";
            const tokens = hl.codeToTokens(text, { lang: effectiveLang, theme: shikiTheme });

            const htmlLines = tokens.tokens.map((lineTokens) => {
              if (lineTokens.length === 0) return "&nbsp;";
              return lineTokens
                .map((token) => {
                  const escaped = token.content
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;");
                  if (token.color) {
                    return `<span style="color:${token.color}">${escaped}</span>`;
                  }
                  return escaped;
                })
                .join("");
            });
            setLines(htmlLines);
          } catch {
            setLines(text.split("\n").map((l) =>
              l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "&nbsp;"
            ));
          }
        }, 100);
      },
    ),
  );

  // Scroll to target line after content renders
  createEffect(
    on(
      () => [lines().length, props.scrollToLine] as const,
      ([count, target]) => {
        if (!target || count === 0 || !scrollContainerRef) return;
        requestAnimationFrame(() => {
          const es = editorSettings();
          const lineHeight = es.fontSize * es.lineHeight;
          const top = Math.max(0, (target - 1)) * lineHeight;
          scrollContainerRef!.scrollTop = top;
          if (gutterRef) gutterRef.scrollTop = top;
        });
      },
    ),
  );

  const lineCount = createMemo(() => lines().length);
  const gutterWidth = createMemo(() => Math.max(3, String(lineCount()).length));

  const changeColor = (lineNo: number) => {
    const change = lineChanges().get(lineNo);
    if (change === "added") return "bg-success/60";
    if (change === "modified") return "bg-info/60";
    if (change === "deleted") return "bg-destructive/60";
    return "";
  };

  // Sync scroll between textarea and highlight layer + gutter
  const handleScroll = () => {
    if (!scrollContainerRef) return;
    const { scrollTop, scrollLeft } = scrollContainerRef;
    if (textareaRef) {
      textareaRef.scrollTop = scrollTop;
      textareaRef.scrollLeft = scrollLeft;
    }
    if (highlightRef) {
      highlightRef.scrollTop = scrollTop;
      highlightRef.scrollLeft = scrollLeft;
    }
    if (gutterRef) {
      gutterRef.scrollTop = scrollTop;
    }
  };

  // Also sync when textarea scrolls (e.g. from cursor movement)
  const handleTextareaScroll = () => {
    if (!textareaRef) return;
    const { scrollTop, scrollLeft } = textareaRef;
    if (scrollContainerRef) {
      scrollContainerRef.scrollTop = scrollTop;
      scrollContainerRef.scrollLeft = scrollLeft;
    }
    if (highlightRef) {
      highlightRef.scrollTop = scrollTop;
      highlightRef.scrollLeft = scrollLeft;
    }
    if (gutterRef) {
      gutterRef.scrollTop = scrollTop;
    }
  };

  // Handle tab key in textarea
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = textareaRef!;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const val = ta.value;
      const newVal = val.substring(0, start) + "  " + val.substring(end);
      props.onEdit(newVal);
      // Restore cursor position after SolidJS re-renders
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div class="editor-code-view flex h-full overflow-hidden">
      {/* Gutter: line numbers + git change indicators */}
      <div
        ref={gutterRef}
        class="editor-gutter shrink-0 z-10 select-none flex border-r border-border/30 overflow-hidden"
      >
        <div
          class="text-right pr-2 pl-3 pt-3 pb-3"
          style={{ "min-width": `${gutterWidth() * 0.6 + 1.4}rem` }}
        >
          <For each={lines()}>
            {(_, idx) => {
              const lineNo = () => idx() + 1;
              return (
                <div
                  class="editor-line-number relative group cursor-default"
                  style={{ "font-size": `${editorSettings().fontSize}px`, "line-height": editorSettings().lineHeight, "font-family": editorSettings().fontFamily }}
                  onMouseEnter={() => setHoveredLine(lineNo())}
                  onMouseLeave={() => setHoveredLine(null)}
                >
                  {lineNo()}
                  <Show when={hoveredLine() === lineNo() && getBlameForLine(lineNo())}>
                    {(_) => {
                      const blame = getBlameForLine(lineNo())!;
                      return (
                        <div class="absolute right-full top-0 mr-1 z-50 whitespace-nowrap bg-popover border border-border rounded px-2 py-1 text-[10px] shadow-lg pointer-events-none">
                          <span class="text-muted-foreground">{blame.commitSha}</span>
                          {" "}
                          <span class="text-foreground font-medium">{blame.author}</span>
                          {" "}
                          <span class="text-muted-foreground">{formatBlameDate(blame.timestamp)}</span>
                          {" "}
                          <span class="text-muted-foreground/70 italic max-w-[200px] truncate inline-block align-bottom">{blame.summary}</span>
                        </div>
                      );
                    }}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
        <div class="w-[3px] pt-3 pb-3 mr-0.5">
          <For each={lines()}>
            {(_, idx) => (
              <div
                class={`${changeColor(idx() + 1)}`}
                style={{ "line-height": editorSettings().lineHeight, "font-size": `${editorSettings().fontSize}px`, height: `${editorSettings().lineHeight}em` }}
                title={lineChanges().get(idx() + 1) ?? ""}
              />
            )}
          </For>
        </div>
      </div>

      {/* Code area: highlight backdrop + textarea overlay */}
      <div
        ref={scrollContainerRef}
        class="flex-1 relative overflow-auto scrollbar-thin"
        onScroll={handleScroll}
      >
        {/* Syntax-highlighted backdrop */}
        <div
          ref={highlightRef}
          class="absolute inset-0 pt-3 pb-3 pl-4 pr-4 pointer-events-none overflow-hidden"
          aria-hidden="true"
        >
          <pre class="m-0 p-0">
            <code style={{ "font-family": editorSettings().fontFamily, "font-size": `${editorSettings().fontSize}px`, "line-height": editorSettings().lineHeight }}>
              <For each={lines()}>
                {(html) => <div class="editor-line whitespace-pre" innerHTML={html} />}
              </For>
            </code>
          </pre>
        </div>

        {/* Editable textarea overlay */}
        <textarea
          ref={textareaRef}
          class="editor-textarea absolute inset-0 w-full h-full pt-3 pb-3 pl-4 pr-4 bg-transparent text-transparent resize-none outline-none border-none overflow-auto whitespace-pre"
          style={{ "caret-color": "var(--foreground)", "font-family": editorSettings().fontFamily, "font-size": `${editorSettings().fontSize}px`, "line-height": editorSettings().lineHeight }}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          value={props.editBuffer}
          onInput={(e) => props.onEdit(e.currentTarget.value)}
          onScroll={handleTextareaScroll}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) handleGotoDefinition(e);
          }}
          onMouseMove={(e) => {
            if (e.ctrlKey || e.metaKey) handleHover(e);
            else { setHoverInfo(null); setHoverPos(null); }
          }}
          onMouseLeave={() => { setHoverInfo(null); setHoverPos(null); }}
        />

        {/* Diagnostic underlines overlay */}
        <Show when={diagnostics().length > 0}>
          <div class="absolute inset-0 pt-3 pl-4 pointer-events-none" aria-hidden="true">
            <For each={diagnostics()}>
              {(diag) => {
                const top = () => `${diag.range_start_line * editorSettings().lineHeight}em`;
                const sevColor = () => {
                  if (diag.severity === 1) return "var(--destructive)";
                  if (diag.severity === 2) return "var(--warning)";
                  if (diag.severity === 3) return "var(--info)";
                  return "var(--muted-foreground)";
                };
                return (
                  <div
                    class="absolute h-[1.6em] flex items-end pointer-events-none"
                    style={{ top: top(), left: `${diag.range_start_char * 0.72}ch` }}
                    title={`${diag.source ? `[${diag.source}] ` : ""}${diag.message}`}
                  >
                    <div
                      class="border-b-2 border-dotted"
                      style={{
                        width: `${Math.max(1, diag.range_end_char - diag.range_start_char) * 0.72}ch`,
                        "border-color": sevColor(),
                      }}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Show>

        {/* Hover popup */}
        <Show when={hoverInfo() && hoverPos()}>
          <div
            class="absolute z-50 max-w-[400px] rounded-md border border-border bg-popover shadow-lg px-3 py-2 text-xs font-mono whitespace-pre-wrap pointer-events-none"
            style={{
              top: `${hoverPos()!.y + 20}px`,
              left: `${hoverPos()!.x}px`,
            }}
          >
            {hoverInfo()}
          </div>
        </Show>
      </div>

      {/* Diagnostic summary (bottom) */}
      <Show when={diagnostics().length > 0}>
        <div class="shrink-0 border-t border-border/30 px-3 py-1 flex items-center gap-3 text-[10px]">
          <Show when={diagnostics().filter((d) => d.severity === 1).length > 0}>
            <span class="text-destructive">
              {diagnostics().filter((d) => d.severity === 1).length} error(s)
            </span>
          </Show>
          <Show when={diagnostics().filter((d) => d.severity === 2).length > 0}>
            <span class="text-warning">
              {diagnostics().filter((d) => d.severity === 2).length} warning(s)
            </span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

export function FileEditor(props: FileEditorProps) {
  const [content, setContent] = createSignal<string | null>(null);
  const [editBuffer, setEditBuffer] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [layout, layoutActions] = useLayout();
  const dirty = () => content() != null && editBuffer() !== content();

  const scrollToLine = createMemo(() => {
    const ws = layout.centerTabsByWorkspace[props.workspaceId];
    if (!ws) return undefined;
    const tab = ws.tabs.find((t) => t.id === props.tabId);
    return tab?.meta.scrollToLine;
  });

  // Auto-pin the tab when file is modified
  createEffect(() => {
    if (dirty() && props.tabId && props.workspaceId) {
      layoutActions.pinTab(props.workspaceId, props.tabId);
    }
  });

  const ext = () => props.filePath ? getExtFromPath(props.filePath) : "";
  const isImage = () => IMAGE_EXTS.has(ext());
  const isSvg = () => ext() === SVG_EXT;

  // Load file content
  createEffect(
    on(
      () => props.filePath,
      async (path) => {
        if (!path) {
          setContent(null);
          setError(null);
          return;
        }
        if (IMAGE_EXTS.has(getExtFromPath(path))) {
          setContent(null);
          setError(null);
          setLoading(false);
          return;
        }
        setLoading(true);
        setError(null);
        setContent(null);
        try {
          const text = await invoke<string>("read_file_content", { path });
          setContent(text);
          setEditBuffer(text);
        } catch (e) {
          setError(String(e));
        } finally {
          setLoading(false);
        }
      },
    ),
  );

  // Save file (Ctrl+S)
  const saveFile = async () => {
    if (!props.filePath || !dirty()) return;
    setSaving(true);
    try {
      await invoke("write_file_content", { path: props.filePath, content: editBuffer() });
      setContent(editBuffer());
    } catch (e) {
      console.error("Save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  // Keyboard shortcut
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <div class="editor-container flex flex-col h-full overflow-hidden">
      {/* Content area */}
      <div class="editor-content flex-1 overflow-hidden">
        <Show when={loading()}>
          <div class="flex items-center justify-center h-32">
            <span class="text-xs text-muted-foreground animate-pulse">Loading...</span>
          </div>
        </Show>

        <Show when={error()}>
          <div class="flex items-center justify-center h-32 px-4">
            <span class="text-xs text-destructive">{error()}</span>
          </div>
        </Show>

        {/* Image files */}
        <Show when={!loading() && !error() && isImage() && props.filePath}>
          <ImageViewer filePath={props.filePath!} />
        </Show>

        {/* SVG files */}
        <Show when={!loading() && !error() && isSvg() && content() != null}>
          <SvgViewer filePath={props.filePath!} content={content()!} />
        </Show>

        {/* Text/code files */}
        <Show when={!loading() && !error() && !isImage() && !isSvg() && content() != null}>
          <CodeView
            filePath={props.filePath!}
            content={content()!}
            editBuffer={editBuffer()}
            onEdit={setEditBuffer}
            repoPath={props.repoPath}
            workspaceId={props.workspaceId}
            scrollToLine={scrollToLine()}
          />
        </Show>
      </div>

      {/* Status bar: dirty/saving indicator */}
      <Show when={!isImage() && !isSvg() && content() != null}>
        <div class="shrink-0 border-t border-border/30 px-3 py-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
          <Show when={saving()}>
            <span class="text-info animate-pulse">Saving...</span>
          </Show>
          <Show when={dirty() && !saving()}>
            <span class="text-warning">Modified</span>
            <span class="opacity-50">Ctrl+S to save</span>
          </Show>
          <Show when={!dirty() && !saving()}>
            <span class="opacity-50">Saved</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}
