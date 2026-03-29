import { createSignal, Show } from "solid-js";
import { marked } from "marked";
import { gitAgentApi } from "@/api/git-agent";
import type { PrDescription } from "@/types/git";

interface PrPreviewProps {
  repoPath: string;
  base: string;
  head: string;
  onSubmit: (title: string, body: string) => void;
  onCancel: () => void;
}

export function PrPreview(props: PrPreviewProps) {
  const [pr, setPr] = createSignal<PrDescription | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [editTitle, setEditTitle] = createSignal("");
  const [editBody, setEditBody] = createSignal("");
  const [editing, setEditing] = createSignal(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const desc = await gitAgentApi.generatePrDescription(props.repoPath, props.base, props.head);
      setPr(desc);
      setEditTitle(desc.title);
      setEditBody(desc.body);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = () => {
    props.onSubmit(editTitle(), editBody());
  };

  const renderedBody = () => {
    const body = editing() ? editBody() : pr()?.body ?? "";
    return { __html: marked.parse(body) as string };
  };

  return (
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold">PR Description</h3>
        <Show when={!pr() && !loading()}>
          <button
            onClick={() => void load()}
            class="text-xs rounded border border-border px-2 py-1 hover:bg-accent/60"
          >
            Generate
          </button>
        </Show>
      </div>

      <Show when={loading()}>
        <p class="text-sm text-muted-foreground">Generating PR description…</p>
      </Show>

      <Show when={error()}>
        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error()}
        </div>
      </Show>

      <Show when={pr()}>
        <div class="space-y-3">
          {/* Title */}
          <div>
            <label class="block text-xs text-muted-foreground mb-1">Title</label>
            <input
              value={editTitle()}
              onInput={(e) => setEditTitle(e.currentTarget.value)}
              class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
            />
          </div>

          {/* Body — toggle between preview and edit */}
          <div>
            <div class="flex items-center justify-between mb-1">
              <label class="text-xs text-muted-foreground">Body</label>
              <button
                onClick={() => setEditing((p) => !p)}
                class="text-xs text-muted-foreground hover:text-foreground"
              >
                {editing() ? "Preview" : "Edit"}
              </button>
            </div>
            <Show
              when={editing()}
              fallback={
                <div
                  class="prose prose-sm prose-invert max-w-none rounded-md border border-border bg-background/40 px-3 py-2 text-sm max-h-64 overflow-y-auto"
                  innerHTML={renderedBody().__html}
                />
              }
            >
              <textarea
                value={editBody()}
                onInput={(e) => setEditBody(e.currentTarget.value)}
                rows={10}
                class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none font-mono resize-none"
              />
            </Show>
          </div>

          <div class="flex gap-2 pt-1">
            <button
              onClick={handleSubmit}
              class="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm"
            >
              Create PR
            </button>
            <button
              onClick={props.onCancel}
              class="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent/60"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
