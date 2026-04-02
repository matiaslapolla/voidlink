import { Show, For } from "solid-js";
import type { SearchResult } from "@/types/migration";

interface ContextBuilderTabProps {
  objective: string;
  constraintsText: string;
  selectedContext: SearchResult[];
  tokenEstimate: number;
  onObjectiveChange: (v: string) => void;
  onConstraintsChange: (v: string) => void;
  onRemoveContext: (resultId: string) => void;
}

export function ContextBuilderTab(props: ContextBuilderTabProps) {
  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      <div>
        <label class="block text-sm font-medium mb-1">Objective</label>
        <textarea
          value={props.objective}
          onInput={(event) => props.onObjectiveChange(event.currentTarget.value)}
          rows={4}
          placeholder="Describe the migration objective..."
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
        />
      </div>

      <div>
        <label class="block text-sm font-medium mb-1">Constraints (one per line)</label>
        <textarea
          value={props.constraintsText}
          onInput={(event) => props.onConstraintsChange(event.currentTarget.value)}
          rows={4}
          placeholder="No destructive edits in v1&#10;Preserve existing behavior"
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
        />
      </div>

      <div class="text-xs text-muted-foreground">
        Selected context items: {props.selectedContext.length} | Estimated tokens: {props.tokenEstimate}
      </div>

      <Show when={props.selectedContext.length > 0} fallback={<p class="text-sm text-muted-foreground">Add repository results to build context.</p>}>
        <div class="space-y-2">
          <For each={props.selectedContext}>
            {(item) => (
              <div class="rounded-md border border-border p-2">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-sm font-medium truncate">{item.anchor}</div>
                  <button
                    onClick={() => props.onRemoveContext(item.id)}
                    class="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
                  >
                    Remove
                  </button>
                </div>
                <p class="text-xs text-muted-foreground mt-1 line-clamp-3">{item.snippet}</p>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
