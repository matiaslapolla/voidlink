import { createSignal, Show, For } from "solid-js";
import { X, Plus } from "lucide-solid";
import type { ContextItem } from "@/types/context";
import { KIND_ICON, KIND_LABEL } from "@/lib/contextUtils";

interface ContextBuilderTabProps {
  contextItems: ContextItem[];
  tokenEstimate: number;
  onRemoveItem: (itemId: string) => void;
  onAddFreetext: (label: string, content: string) => void;
}

export function ContextBuilderTab(props: ContextBuilderTabProps) {
  const [showAddNote, setShowAddNote] = createSignal(false);
  const [noteLabel, setNoteLabel] = createSignal("");
  const [noteContent, setNoteContent] = createSignal("");

  const handleAddNote = () => {
    const label = noteLabel().trim();
    const content = noteContent().trim();
    if (!content) return;
    props.onAddFreetext(label || "Note", content);
    setNoteLabel("");
    setNoteContent("");
    setShowAddNote(false);
  };

  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      {/* Header */}
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-sm font-semibold">Context</h2>
          <p class="text-xs text-muted-foreground mt-0.5">
            {props.contextItems.length} items | ~{props.tokenEstimate} tokens
          </p>
        </div>
        <button
          onClick={() => setShowAddNote((p) => !p)}
          class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
        >
          <Plus class="w-3.5 h-3.5" />
          Add note
        </button>
      </div>

      {/* Add freetext note form */}
      <Show when={showAddNote()}>
        <div class="rounded-md border border-border p-3 space-y-2 bg-card/60">
          <input
            value={noteLabel()}
            onInput={(e) => setNoteLabel(e.currentTarget.value)}
            placeholder="Label (optional)"
            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none"
          />
          <textarea
            value={noteContent()}
            onInput={(e) => setNoteContent(e.currentTarget.value)}
            rows={3}
            placeholder="Additional context, notes, or constraints..."
            class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none resize-y"
          />
          <div class="flex gap-2">
            <button
              onClick={handleAddNote}
              disabled={noteContent().trim().length === 0}
              class="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            >
              Add
            </button>
            <button
              onClick={() => setShowAddNote(false)}
              class="rounded-md border border-border px-3 py-1 text-xs hover:bg-accent/60"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      {/* Context items list */}
      <Show
        when={props.contextItems.length > 0}
        fallback={
          <div class="text-center py-8 text-sm text-muted-foreground">
            <p>No context items yet.</p>
            <p class="mt-1 text-xs">
              Add items from Repository search, Git diffs, or add notes above.
            </p>
          </div>
        }
      >
        <div class="space-y-2">
          <For each={props.contextItems}>
            {(item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <div class="group rounded-md border border-border p-2.5 hover:border-border/80 transition-colors">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex items-center gap-2 min-w-0">
                      <Icon class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <div class="min-w-0">
                        <div class="text-sm font-medium truncate">{item.label}</div>
                        <div class="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{KIND_LABEL[item.kind]}</span>
                          <Show when={item.filePath}>
                            <span class="truncate max-w-48">{item.filePath}</span>
                          </Show>
                          <span>~{item.tokenEstimate} tok</span>
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => props.onRemoveItem(item.id)}
                      class="rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      title="Remove"
                    >
                      <X class="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <p class="text-xs text-muted-foreground mt-1.5 line-clamp-3 whitespace-pre-wrap">
                    {item.content}
                  </p>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
