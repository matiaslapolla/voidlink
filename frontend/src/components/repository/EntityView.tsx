import { createSignal, Show, For } from "solid-js";
import { Brain, ChevronDown, ChevronRight, FileText, Loader2 } from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { useLayout } from "@/store/LayoutContext";
import type { EntityAnalysisResult, EntityCategory } from "@/types/migration";

interface EntityViewProps {
  repoPath: string;
  workspaceId: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  model: "bg-blue-500/20 text-blue-400",
  service: "bg-green-500/20 text-green-400",
  controller: "bg-purple-500/20 text-purple-400",
  route: "bg-purple-500/20 text-purple-400",
  component: "bg-cyan-500/20 text-cyan-400",
  hook: "bg-teal-500/20 text-teal-400",
  store: "bg-amber-500/20 text-amber-400",
  util: "bg-gray-500/20 text-gray-400",
  config: "bg-orange-500/20 text-orange-400",
  test: "bg-yellow-500/20 text-yellow-400",
  type: "bg-indigo-500/20 text-indigo-400",
  middleware: "bg-rose-500/20 text-rose-400",
  migration: "bg-pink-500/20 text-pink-400",
  style: "bg-fuchsia-500/20 text-fuchsia-400",
  script: "bg-lime-500/20 text-lime-400",
  asset: "bg-emerald-500/20 text-emerald-400",
  documentation: "bg-sky-500/20 text-sky-400",
};

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category.toLowerCase()] ?? "bg-accent/40 text-muted-foreground";
}

function CategoryCard(props: {
  category: EntityCategory;
  workspaceId: string;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const [, actions] = useLayout();

  return (
    <div class="rounded-md border border-border bg-card/40 overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/20 transition-colors"
      >
        <Show when={expanded()} fallback={<ChevronRight class="w-3.5 h-3.5 text-muted-foreground shrink-0" />}>
          <ChevronDown class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        </Show>
        <span class={`rounded px-1.5 py-0.5 text-xs font-medium ${categoryColor(props.category.category)}`}>
          {props.category.category}
        </span>
        <span class="text-xs text-muted-foreground flex-1 truncate">
          {props.category.description}
        </span>
        <span class="text-xs text-muted-foreground tabular-nums">
          {props.category.filePaths.length} files
        </span>
        <span class="text-[10px] text-muted-foreground/60">
          {(props.category.confidence * 100).toFixed(0)}%
        </span>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-border/50 px-3 py-1.5 space-y-0.5 max-h-60 overflow-auto">
          <For each={props.category.filePaths}>
            {(filePath) => (
              <button
                onClick={() => actions.openFile(props.workspaceId, filePath)}
                class="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors text-left"
              >
                <FileText class="w-3 h-3 shrink-0" />
                <span class="truncate">{filePath}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function EntityView(props: EntityViewProps) {
  const [result, setResult] = createSignal<EntityAnalysisResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const data = await migrationApi.identifyEntities(props.repoPath);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      <Show when={!result() && !loading()}>
        <div class="flex flex-col items-center gap-4 py-12">
          <Brain class="w-10 h-10 text-muted-foreground" />
          <p class="text-sm text-muted-foreground text-center max-w-sm">
            Use AI to analyze file names and paths to identify entity types like models, services,
            controllers, and more.
          </p>
          <button
            onClick={analyze}
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Brain class="w-4 h-4" />
            Analyze Entities
          </button>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="flex items-center justify-center py-12 gap-2">
          <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
          <span class="text-sm text-muted-foreground">Analyzing file entities...</span>
        </div>
      </Show>

      <Show when={error()}>
        {(err) => (
          <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {err()}
          </div>
        )}
      </Show>

      <Show when={result()}>
        {(r) => (
          <>
            <div class="flex items-center justify-between">
              <span class="text-xs text-muted-foreground">
                {r().categories.length} categories found &middot;{" "}
                {r().categories.reduce((s, c) => s + c.filePaths.length, 0)} files categorized
                {r().uncategorized.length > 0 && ` \u00b7 ${r().uncategorized.length} uncategorized`}
              </span>
              <button
                onClick={analyze}
                disabled={loading()}
                class="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 transition-colors disabled:opacity-50"
              >
                Re-analyze
              </button>
            </div>

            <div class="space-y-2">
              <For each={r().categories}>
                {(cat) => (
                  <CategoryCard category={cat} workspaceId={props.workspaceId} />
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
