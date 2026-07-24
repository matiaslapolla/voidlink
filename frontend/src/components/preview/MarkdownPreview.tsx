import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { fsApi } from "@/api/fs";
import { editorController } from "@/components/editor/editorController";
import { renderMarkdown } from "@/components/preview/markdown";

interface MarkdownPreviewProps {
  filePath: string;
  class?: string;
}

/// Live markdown preview. If the file is open in the editor we mirror its
/// in-memory model (so the preview reflects unsaved edits, Zed-style); if
/// the file isn't open we fall back to reading from disk on mount.
export function MarkdownPreview(props: MarkdownPreviewProps) {
  const [html, setHtml] = createSignal("");

  function renderFrom(source: string) {
    setHtml(renderMarkdown(source));
  }

  onMount(() => {
    let modelDispose: { dispose: () => void } | null = null;
    let alive = true;

    const attach = () => {
      const model = editorController.getModel(props.filePath);
      if (model) {
        renderFrom(model.getValue());
        modelDispose = model.onDidChangeContent(() => {
          if (!alive) return;
          renderFrom(model.getValue());
        });
        return true;
      }
      return false;
    };

    if (!attach()) {
      // Model not loaded yet — read once from disk, then retry attach so
      // future edits via the editor still drive the preview live.
      void fsApi.readFile(props.filePath).then((text) => {
        if (!alive) return;
        renderFrom(text);
        attach();
      }).catch((e) => {
        if (!alive) return;
        setHtml(
          `<p style="color:var(--destructive)">Failed to read ${escapeHtml(
            props.filePath,
          )}: ${escapeHtml(String(e))}</p>`,
        );
      });
    }

    // The editor model can be created after we mount (user opened the
    // file *after* opening the preview tab). Poll briefly until attach
    // succeeds; cheap and bounded by user action.
    const retryInterval = setInterval(() => {
      if (modelDispose) { clearInterval(retryInterval); return; }
      if (attach()) clearInterval(retryInterval);
    }, 500);

    onCleanup(() => {
      alive = false;
      modelDispose?.dispose();
      clearInterval(retryInterval);
    });
  });

  // Re-render when filePath prop changes (defensive — the component is
  // mounted per-tab today, so this is mostly future-proofing).
  createEffect(() => { void props.filePath; });

  return (
    <div class={`markdown-preview h-full overflow-y-auto bg-background ${props.class ?? ""}`}>
      <div class="markdown-body mx-auto max-w-[860px] px-10 py-8 text-[14px] leading-[1.7] text-foreground" innerHTML={html()} />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]!));
}
