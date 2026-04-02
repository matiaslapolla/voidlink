import { Show, For } from "solid-js";
import { Play } from "lucide-solid";
import type { WorkflowDsl, RunState } from "@/types/migration";

function formatTimestamp(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

interface WorkflowTabProps {
  workflow: WorkflowDsl | null;
  runState: RunState | null;
  generatingWorkflow: boolean;
  runningWorkflow: boolean;
  onGenerate: () => void;
  onRun: () => void;
}

export function WorkflowTab(props: WorkflowTabProps) {
  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      <div class="flex flex-wrap gap-2">
        <button
          onClick={props.onGenerate}
          disabled={props.generatingWorkflow}
          class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
        >
          {props.generatingWorkflow ? "Generating..." : "Generate Workflow"}
        </button>
        <button
          onClick={props.onRun}
          disabled={!props.workflow || props.runningWorkflow}
          class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
        >
          <Play class="inline w-4 h-4 mr-1" />
          {props.runningWorkflow ? "Running..." : "Run Workflow"}
        </button>
      </div>

      <Show when={props.workflow} fallback={<p class="text-sm text-muted-foreground">Generate a workflow to preview steps.</p>}>
        {(dsl) => (
          <div class="rounded-md border border-border p-3 space-y-3">
            <div>
              <h3 class="text-sm font-semibold">{dsl().workflow.objective}</h3>
              <p class="text-xs text-muted-foreground">Workflow ID: {dsl().workflow.id}</p>
            </div>

            <div class="space-y-2">
              <For each={dsl().steps}>
                {(step) => (
                  <div class="rounded border border-border/70 p-2">
                    <div class="text-sm font-medium">{step.id}</div>
                    <div class="text-xs text-muted-foreground">{step.intent}</div>
                    <div class="text-xs text-muted-foreground mt-1">
                      tools: {step.tools.join(", ")}
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.runState}>
        {(runState) => (
          <div class="rounded-md border border-border p-3 space-y-3">
            <div class="text-sm font-medium">
              Run {runState().runId} - {runState().status}
            </div>

            <div class="space-y-1">
              <For each={runState().steps}>
                {(step) => (
                  <div class="text-xs text-muted-foreground">
                    {step.stepId}: {step.status} (attempts: {step.attempts})
                  </div>
                )}
              </For>
            </div>

            <div class="max-h-44 overflow-auto rounded border border-border/60 p-2 space-y-1 bg-background/40">
              <For each={runState().events}>
                {(event) => (
                  <div class="text-xs">
                    <span class="text-muted-foreground">[{formatTimestamp(event.createdAt)}]</span>{" "}
                    <span class={event.level === "error" ? "text-destructive" : "text-foreground"}>
                      {event.message}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
