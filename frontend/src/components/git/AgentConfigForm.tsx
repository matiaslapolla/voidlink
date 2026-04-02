import { Show } from "solid-js";
import { Play } from "lucide-solid";

interface AgentConfigFormProps {
  objective: string;
  onObjective: (v: string) => void;
  constraints: string;
  onConstraints: (v: string) => void;
  baseBranch: string;
  onBaseBranch: (v: string) => void;
  autoPr: boolean;
  onAutoPr: (v: boolean) => void;
  starting: boolean;
  error: string | null;
  onStart: () => void;
}

export function AgentConfigForm(props: AgentConfigFormProps) {
  return (
    <div class="space-y-3">
      <div>
        <label class="block text-sm font-medium mb-1">Objective</label>
        <textarea
          value={props.objective}
          onInput={(e) => props.onObjective(e.currentTarget.value)}
          rows={3}
          placeholder="Describe what the agent should implement..."
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none resize-none"
        />
      </div>
      <div>
        <label class="block text-sm font-medium mb-1">
          Constraints <span class="font-normal text-muted-foreground">(one per line)</span>
        </label>
        <textarea
          value={props.constraints}
          onInput={(e) => props.onConstraints(e.currentTarget.value)}
          rows={2}
          placeholder="Preserve existing API&#10;No external dependencies"
          class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none resize-none"
        />
      </div>
      <div class="flex flex-wrap gap-4">
        <div class="flex-1 min-w-32">
          <label class="block text-sm font-medium mb-1">Base branch</label>
          <input
            value={props.baseBranch}
            onInput={(e) => props.onBaseBranch(e.currentTarget.value)}
            placeholder="main"
            class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
          />
        </div>
        <div class="flex items-end pb-2">
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={props.autoPr}
              onChange={(e) => props.onAutoPr(e.currentTarget.checked)}
              class="rounded"
            />
            Auto-open PR
          </label>
        </div>
      </div>

      <Show when={props.error}>
        <p class="text-xs text-destructive">{props.error}</p>
      </Show>

      <button
        onClick={props.onStart}
        disabled={props.starting || !props.objective.trim()}
        class="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm disabled:opacity-50"
      >
        <Play class="w-4 h-4" />
        {props.starting ? "Starting…" : "Run Agent"}
      </button>
    </div>
  );
}
