import { createSignal, Show, For } from "solid-js";
import { GitFork, ChevronDown, ChevronRight, FileText, Loader2, ArrowDown } from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { useLayout } from "@/store/LayoutContext";
import type { DataFlowAnalysisResult, DataPipeline } from "@/types/migration";

interface DataFlowViewProps {
  repoPath: string;
  workspaceId: string;
}

const ROLE_STYLES: Record<string, string> = {
  source: "bg-green-500/20 text-green-400",
  transform: "bg-blue-500/20 text-blue-400",
  sink: "bg-red-500/20 text-red-400",
  middleware: "bg-amber-500/20 text-amber-400",
};

function PipelineCard(props: { pipeline: DataPipeline; workspaceId: string }) {
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
        <GitFork class="w-3.5 h-3.5 text-primary shrink-0" />
        <span class="text-sm font-medium flex-1 truncate">{props.pipeline.name}</span>
        <span class="text-xs text-muted-foreground">
          {props.pipeline.steps.length} steps
        </span>
        <span class="text-[10px] text-muted-foreground/60">
          {(props.pipeline.confidence * 100).toFixed(0)}%
        </span>
      </button>

      <Show when={expanded()}>
        <div class="border-t border-border/50 px-3 py-3">
          <p class="text-xs text-muted-foreground mb-3">{props.pipeline.description}</p>

          {/* Flow visualization */}
          <div class="space-y-0">
            <For each={props.pipeline.steps}>
              {(step, idx) => (
                <>
                  <button
                    onClick={() => actions.openFile(props.workspaceId, step.filePath)}
                    class="w-full flex items-center gap-2 rounded-md border border-border/50 px-3 py-2 hover:bg-accent/20 transition-colors text-left"
                  >
                    <span class={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${ROLE_STYLES[step.role] ?? "bg-accent/40 text-muted-foreground"}`}>
                      {step.role}
                    </span>
                    <FileText class="w-3 h-3 shrink-0 text-muted-foreground" />
                    <div class="flex-1 min-w-0">
                      <div class="text-xs text-primary truncate">{step.filePath}</div>
                      <div class="text-[10px] text-muted-foreground truncate">{step.description}</div>
                    </div>
                  </button>
                  <Show when={idx() < props.pipeline.steps.length - 1}>
                    <div class="flex justify-center py-0.5">
                      <ArrowDown class="w-3 h-3 text-muted-foreground/40" />
                    </div>
                  </Show>
                </>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function DataFlowView(props: DataFlowViewProps) {
  const [result, setResult] = createSignal<DataFlowAnalysisResult | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const data = await migrationApi.analyzeDataFlows(props.repoPath);
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
          <GitFork class="w-10 h-10 text-muted-foreground" />
          <p class="text-sm text-muted-foreground text-center max-w-sm">
            Use AI to analyze import relationships and file contents to identify data flows
            and pipelines in your codebase.
          </p>
          <button
            onClick={analyze}
            class="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <GitFork class="w-4 h-4" />
            Analyze Data Flows
          </button>
        </div>
      </Show>

      <Show when={loading()}>
        <div class="flex items-center justify-center py-12 gap-2">
          <Loader2 class="w-5 h-5 animate-spin text-muted-foreground" />
          <span class="text-sm text-muted-foreground">Analyzing data flows...</span>
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
                {r().pipelines.length} pipelines identified
              </span>
              <button
                onClick={analyze}
                disabled={loading()}
                class="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/60 transition-colors disabled:opacity-50"
              >
                Re-analyze
              </button>
            </div>

            <Show when={r().summary}>
              <p class="text-xs text-muted-foreground">{r().summary}</p>
            </Show>

            <div class="space-y-2">
              <For each={r().pipelines}>
                {(pipeline) => (
                  <PipelineCard pipeline={pipeline} workspaceId={props.workspaceId} />
                )}
              </For>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
