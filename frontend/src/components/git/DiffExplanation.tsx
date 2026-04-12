import { createSignal, For, Show } from "solid-js";
import { Sparkles, Info, ChevronDown, ChevronRight } from "lucide-solid";
import { gitApi } from "@/api/git";
import type { DiffExplanation } from "@/types/git";

interface DiffExplanationProps {
  repoPath: string;
  base: string;
  head: string;
}

const riskColors: Record<string, string> = {
  low: "text-success",
  medium: "text-warning",
  high: "text-destructive",
};

export function DiffExplanationPanel(props: DiffExplanationProps) {
  const [explanations, setExplanations] = createSignal<DiffExplanation[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await gitApi.explainDiff(props.repoPath, props.base, props.head);
      setExplanations(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleExpanded = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2">
          <Sparkles class="w-4 h-4 text-primary" />
          AI Explanations
        </h3>
        <button
          onClick={() => void load()}
          disabled={loading()}
          class="flex items-center gap-1 text-xs rounded border border-border px-2 py-1 hover:bg-accent/60 disabled:opacity-50 transition-colors"
        >
          {loading() ? "Analyzing…" : "Analyze Changes"}
        </button>
      </div>

      <Show when={error()}>
        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error()}
        </div>
      </Show>

      <Show when={explanations().length === 0 && !loading() && !error()}>
        <p class="text-xs text-muted-foreground">
          Click "Analyze Changes" for AI-powered diff explanations and risk assessment.
        </p>
      </Show>

      <For each={explanations()}>
        {(exp) => {
          const isOpen = () => expanded().has(exp.filePath);

          return (
            <div class="rounded-md border border-border overflow-hidden">
              <button
                onClick={() => toggleExpanded(exp.filePath)}
                class="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/50 transition-colors text-left"
              >
                <Show
                  when={isOpen()}
                  fallback={<ChevronRight class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                >
                  <ChevronDown class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                </Show>
                <span class="flex-1 truncate font-medium">{exp.filePath}</span>
                <span
                  class={`flex-shrink-0 uppercase font-semibold text-xs ${riskColors[exp.riskLevel] ?? "text-muted-foreground"}`}
                >
                  {exp.riskLevel} risk
                </span>
              </button>

              <Show when={isOpen()}>
                <div class="px-4 py-3 space-y-2 border-t border-border bg-card/30">
                  <p class="text-xs text-foreground">{exp.summary}</p>
                  <Show when={exp.suggestions.length > 0}>
                    <div class="space-y-1">
                      <p class="text-xs font-medium text-muted-foreground">Suggestions</p>
                      <For each={exp.suggestions}>
                        {(s) => (
                          <div class="flex items-start gap-1.5 text-xs text-muted-foreground">
                            <Info class="w-3 h-3 mt-0.5 flex-shrink-0 text-primary" />
                            {s}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
