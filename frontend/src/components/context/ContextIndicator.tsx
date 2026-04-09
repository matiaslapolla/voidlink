import { createSignal, Show, For } from "solid-js";
import { Layers, X } from "lucide-solid";
import type { ContextItem } from "@/types/context";
import { KIND_ICON } from "@/lib/contextUtils";

interface ContextIndicatorProps {
  items: ContextItem[];
  tokenEstimate: number;
  onRemoveItem: (id: string) => void;
  onOpenContextTab: () => void;
}

export function ContextIndicator(props: ContextIndicatorProps) {
  const [open, setOpen] = createSignal(false);

  return (
    <div class="fixed bottom-12 right-4 z-50 flex flex-col items-end gap-2">
      {/* Flyout panel */}
      <Show when={open()}>
        <div class="w-80 max-h-96 rounded-lg border border-border bg-background shadow-xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-2">
          {/* Header */}
          <div class="flex items-center justify-between px-3 py-2 border-b border-border bg-background/80">
            <span class="text-xs font-semibold">
              Context ({props.items.length} items, ~{props.tokenEstimate} tok)
            </span>
            <div class="flex items-center gap-1">
              <button
                onClick={() => {
                  setOpen(false);
                  props.onOpenContextTab();
                }}
                class="text-xs text-primary hover:underline"
              >
                Open tab
              </button>
              <button
                onClick={() => setOpen(false)}
                class="p-0.5 rounded hover:bg-accent/60 text-muted-foreground"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Items */}
          <div class="flex-1 overflow-y-auto p-2 space-y-1">
            <Show
              when={props.items.length > 0}
              fallback={
                <p class="text-xs text-muted-foreground text-center py-4">
                  No context items yet
                </p>
              }
            >
              <For each={props.items}>
                {(item) => {
                  const Icon = KIND_ICON[item.kind];
                  return (
                    <div class="group flex items-center gap-2 rounded px-2 py-1.5 hover:bg-accent/40 transition-colors">
                      <Icon class="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <div class="flex-1 min-w-0">
                        <div class="text-xs truncate">{item.label}</div>
                        <div class="text-xs text-muted-foreground truncate">
                          {item.filePath ?? item.kind} · ~{item.tokenEstimate} tok
                        </div>
                      </div>
                      <button
                        onClick={() => props.onRemoveItem(item.id)}
                        class="p-0.5 rounded text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      >
                        <X class="w-3 h-3" />
                      </button>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>
      </Show>

      {/* Badge button */}
      <button
        onClick={() => setOpen((v) => !v)}
        class={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-medium shadow-lg transition-all ${
          props.items.length > 0
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-accent text-muted-foreground hover:bg-accent/80"
        }`}
        title="View context items"
      >
        <Layers class="w-4 h-4" />
        <Show when={props.items.length > 0}>
          <span>{props.items.length}</span>
        </Show>
      </button>
    </div>
  );
}
