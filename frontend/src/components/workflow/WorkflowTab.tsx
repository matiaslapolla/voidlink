import { Show, For } from "solid-js";
import { Play, FileText } from "lucide-solid";
import type { WorkflowDsl, RunState } from "@/types/migration";
import type { ContextItem } from "@/types/context";

function formatTimestamp(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

interface WorkflowTabProps {
  objective: string;
  constraintsText: string;
  contextItems: ContextItem[];
  contextTokenEstimate: number;
  workflow: WorkflowDsl | null;
  runState: RunState | null;
  generatingWorkflow: boolean;
  runningWorkflow: boolean;
  onObjectiveChange: (v: string) => void;
  onConstraintsChange: (v: string) => void;
  onGenerate: () => void;
  onRun: () => void;
}

export function WorkflowTab(props: WorkflowTabProps) {
  return (
    <div class="h-full overflow-auto p-4 space-y-4">
      {/* Objective + Constraints */}
      <div class="space-y-3">
        <div>
          <label class="block text-sm font-medium mb-1">Objective</label>
          <textarea
            value={props.objective}
            onInput={(e) => props.onObjectiveChange(e.currentTarget.value)}
            rows={3}
            placeholder="Describe what this workflow should accomplish..."
            class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none resize-y"
          />
        </div>

        <div>
          <label class="block text-sm font-medium mb-1">Constraints (one per line)</label>
          <textarea
            value={props.constraintsText}
            onInput={(e) => props.onConstraintsChange(e.currentTarget.value)}
            rows={3}
            placeholder="No destructive edits in v1&#10;Preserve existing behavior"
            class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none resize-y"
          />
        </div>
      </div>

      {/* Context summary */}
      <div class="rounded-md border border-border p-3 bg-card/40">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-sm">
            <FileText class="w-4 h-4 text-muted-foreground" />
            <span class="font-medium">Context</span>
          </div>
          <span class="text-xs text-muted-foreground">
            {props.contextItems.length} items | ~{props.contextTokenEstimate} tokens
          </span>
        </div>
        <Show when={props.contextItems.length > 0}>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <For each={props.contextItems.slice(0, 8)}>
              {(item) => (
                <span class="rounded bg-accent/60 px-1.5 py-0.5 text-xs text-muted-foreground truncate max-w-32">
                  {item.label}
                </span>
              )}
            </For>
            <Show when={props.contextItems.length > 8}>
              <span class="text-xs text-muted-foreground">
                +{props.contextItems.length - 8} more
              </span>
            </Show>
          </div>
        </Show>
        <Show when={props.contextItems.length === 0}>
          <p class="mt-1 text-xs text-muted-foreground">
            No context items. Add items from the Context tab first.
          </p>
        </Show>
      </div>

      {/* Actions */}
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

      {/* Workflow preview */}
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

      {/* Run state */}
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
