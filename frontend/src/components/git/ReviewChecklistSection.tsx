import { Show, For } from "solid-js";
import { CheckCircle, Flag, Loader, Sparkles, RefreshCcw } from "lucide-solid";
import type { ReviewChecklist } from "@/types/git";

const categoryColors: Record<string, string> = {
  security: "text-destructive",
  performance: "text-warning",
  correctness: "text-info",
  style: "text-primary",
  testing: "text-success",
};

interface ReviewChecklistSectionProps {
  checklist: ReviewChecklist | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
  onUpdateItem: (itemId: string, status: "unchecked" | "passed" | "flagged") => void;
}

export function ReviewChecklistSection(props: ReviewChecklistSectionProps) {
  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2">
          <Sparkles class="w-4 h-4 text-primary" />
          Review Checklist
        </h3>
        <button
          onClick={props.onGenerate}
          disabled={props.loading}
          class="flex items-center gap-1 text-xs rounded border border-border px-2 py-1 hover:bg-accent/60 disabled:opacity-50"
        >
          <Show when={props.loading}>
            <Loader class="w-3 h-3 animate-spin" />
          </Show>
          <RefreshCcw class="w-3 h-3" />
          {props.checklist ? "Regenerate" : "Generate"}
        </button>
      </div>

      <Show when={props.error}>
        <p class="text-xs text-destructive">{props.error}</p>
      </Show>

      <Show when={props.checklist}>
        {(cl) => (
          <div class="space-y-2">
            <Show when={cl().aiSummary}>
              <p class="text-xs text-muted-foreground border border-border rounded-md px-3 py-2 bg-card/30">
                {cl().aiSummary}
              </p>
            </Show>
            <For each={cl().items}>
              {(item) => (
                <div class="flex items-start gap-2 rounded-md border border-border p-2">
                  <div class="flex gap-1 flex-shrink-0 mt-0.5">
                    <button
                      onClick={() => props.onUpdateItem(item.id, "passed")}
                      title="Mark as passed"
                      class={`p-0.5 rounded transition-colors ${
                        item.status === "passed"
                          ? "text-success"
                          : "text-muted-foreground hover:text-success"
                      }`}
                    >
                      <CheckCircle class="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => props.onUpdateItem(item.id, "flagged")}
                      title="Flag this item"
                      class={`p-0.5 rounded transition-colors ${
                        item.status === "flagged"
                          ? "text-destructive"
                          : "text-muted-foreground hover:text-destructive"
                      }`}
                    >
                      <Flag class="w-4 h-4" />
                    </button>
                  </div>
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span
                        class={`text-xs font-medium uppercase ${categoryColors[item.category] ?? "text-muted-foreground"}`}
                      >
                        {item.category}
                      </span>
                      <span class="text-xs text-foreground">{item.description}</span>
                    </div>
                    <Show when={item.aiNote}>
                      <p class="text-xs text-muted-foreground mt-0.5">{item.aiNote}</p>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}
