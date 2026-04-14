import { createSignal, createEffect, on, Show, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Image, Code } from "lucide-solid";
import { useLayout } from "@/store/LayoutContext";
import { CodeMirrorEditor } from "./CodeMirrorEditor";

interface FileEditorProps {
  filePath: string | null;
  tabId: string;
  workspaceId: string;
  repoPath?: string | null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
const SVG_EXT = "svg";

function getExtFromPath(path: string): string {
  const name = path.split("/").pop() ?? "";
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
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
          fallback={<CodeMirrorEditor filePath={props.filePath} editBuffer={props.content} onEdit={() => {}} readOnly />}
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
          const { content: text } = await invoke<{ content: string; version: number }>("buffer_open", { path });
          setEditBuffer(text);
          setContent(text);
        } catch (e) {
          setError(String(e));
        } finally {
          setLoading(false);
        }
      },
    ),
  );

  // Save file
  const saveFile = async () => {
    if (!props.filePath || !dirty()) return;
    setSaving(true);
    try {
      await invoke("buffer_save", { path: props.filePath, content: editBuffer() });
      setContent(editBuffer());
    } catch (e) {
      console.error("Save failed:", e);
    } finally {
      setSaving(false);
    }
  };

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
          <CodeMirrorEditor
            filePath={props.filePath!}
            editBuffer={editBuffer()}
            onEdit={setEditBuffer}
            onSave={saveFile}
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
