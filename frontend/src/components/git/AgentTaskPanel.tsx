import {
  createSignal,
  createEffect,
  For,
  Show,
  onCleanup,
} from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { Play, X, ExternalLink, GitBranch, CheckCircle, AlertCircle, Loader } from "lucide-solid";
import { gitAgentApi } from "@/api/git-agent";
import type { AgentEvent, AgentTaskInput, AgentTaskState } from "@/types/git";

interface AgentTaskPanelProps {
  repoPath: string;
}

const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  branching: "Creating branch",
  implementing: "Implementing",
  testing: "Testing",
  pr_creating: "Creating PR",
  success: "Done",
  failed: "Failed",
};

export function AgentTaskPanel(props: AgentTaskPanelProps) {
  const [objective, setObjective] = createSignal("");
  const [constraints, setConstraints] = createSignal("");
  const [baseBranch, setBaseBranch] = createSignal("main");
  const [autoPr, setAutoPr] = createSignal(true);
  const [taskId, setTaskId] = createSignal<string | null>(null);
  const [taskState, setTaskState] = createSignal<AgentTaskState | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Live event stream from Rust
  createEffect(() => {
    const id = taskId();
    if (!id) return;

    let unlisten: (() => void) | null = null;
    listen<AgentEvent>(`git-agent-event:${id}`, (evt) => {
      setTaskState((prev) => {
        if (!prev) return prev;
        const already = prev.events.some((e) => e.id === evt.payload.id);
        if (already) return prev;
        return { ...prev, events: [...prev.events, evt.payload] };
      });
    }).then((fn) => {
      unlisten = fn;
    });

    // Also poll for status updates every 2s
    const pollId = window.setInterval(() => {
      gitAgentApi
        .status(id)
        .then(setTaskState)
        .catch(() => {});
    }, 2000);

    onCleanup(() => {
      unlisten?.();
      window.clearInterval(pollId);
    });
  });

  const handleStart = async () => {
    const obj = objective().trim();
    if (!obj) return;
    setStarting(true);
    setError(null);
    setTaskState(null);
    try {
      const constraintList = constraints()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const input: AgentTaskInput = {
        repoPath: props.repoPath,
        objective: obj,
        constraints: constraintList,
        autoPr: autoPr(),
        githubBaseBranch: baseBranch() || "main",
      };
      const id = await gitAgentApi.start(input);
      setTaskId(id);
      const initial = await gitAgentApi.status(id);
      setTaskState(initial);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    const id = taskId();
    if (!id) return;
    try {
      await gitAgentApi.cancel(id);
      const state = await gitAgentApi.status(id);
      setTaskState(state);
    } catch (e) {
      setError(String(e));
    }
  };

  const handleReset = () => {
    setTaskId(null);
    setTaskState(null);
    setError(null);
    setObjective("");
    setConstraints("");
  };

  const isTerminal = () => {
    const s = taskState()?.status;
    return s === "success" || s === "failed";
  };

  const isRunning = () => {
    const s = taskState()?.status;
    return s && s !== "success" && s !== "failed";
  };

  return (
    <div class="space-y-4">
      <Show when={!taskId()}>
        {/* Config form */}
        <div class="space-y-3">
          <div>
            <label class="block text-sm font-medium mb-1">Objective</label>
            <textarea
              value={objective()}
              onInput={(e) => setObjective(e.currentTarget.value)}
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
              value={constraints()}
              onInput={(e) => setConstraints(e.currentTarget.value)}
              rows={2}
              placeholder="Preserve existing API\nNo external dependencies"
              class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none resize-none"
            />
          </div>
          <div class="flex flex-wrap gap-4">
            <div class="flex-1 min-w-32">
              <label class="block text-sm font-medium mb-1">Base branch</label>
              <input
                value={baseBranch()}
                onInput={(e) => setBaseBranch(e.currentTarget.value)}
                placeholder="main"
                class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
              />
            </div>
            <div class="flex items-end pb-2">
              <label class="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoPr()}
                  onChange={(e) => setAutoPr(e.currentTarget.checked)}
                  class="rounded"
                />
                Auto-open PR
              </label>
            </div>
          </div>

          <Show when={error()}>
            <p class="text-xs text-destructive">{error()}</p>
          </Show>

          <button
            onClick={() => void handleStart()}
            disabled={starting() || !objective().trim()}
            class="flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm disabled:opacity-50"
          >
            <Play class="w-4 h-4" />
            {starting() ? "Starting…" : "Run Agent"}
          </button>
        </div>
      </Show>

      <Show when={taskState()}>
        {(state) => (
          <div class="space-y-4">
            {/* Status header */}
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-2">
                <Show when={state().status === "success"}>
                  <CheckCircle class="w-5 h-5 text-green-500" />
                </Show>
                <Show when={state().status === "failed"}>
                  <AlertCircle class="w-5 h-5 text-destructive" />
                </Show>
                <Show when={isRunning()}>
                  <Loader class="w-5 h-5 text-primary animate-spin" />
                </Show>
                <span class="font-medium">
                  {STATUS_LABELS[state().status] ?? state().status}
                </span>
                <Show when={state().currentStep}>
                  <span class="text-xs text-muted-foreground">
                    — {state().currentStep}
                  </span>
                </Show>
              </div>
              <div class="flex gap-2">
                <Show when={isRunning()}>
                  <button
                    onClick={() => void handleCancel()}
                    class="flex items-center gap-1 text-xs rounded border border-border px-2 py-1 hover:bg-accent/60"
                  >
                    <X class="w-3 h-3" />
                    Cancel
                  </button>
                </Show>
                <Show when={isTerminal()}>
                  <button
                    onClick={handleReset}
                    class="text-xs rounded border border-border px-2 py-1 hover:bg-accent/60"
                  >
                    New task
                  </button>
                </Show>
              </div>
            </div>

            {/* Branch & PR info */}
            <Show when={state().branchName}>
              <div class="flex items-center gap-2 text-sm">
                <GitBranch class="w-4 h-4 text-muted-foreground" />
                <span class="font-mono">{state().branchName}</span>
                <Show when={state().prUrl}>
                  <a
                    href={state().prUrl!}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    View PR
                    <ExternalLink class="w-3 h-3" />
                  </a>
                </Show>
              </div>
            </Show>

            {/* Error */}
            <Show when={state().error}>
              <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {state().error}
              </div>
            </Show>

            {/* Event log */}
            <div class="rounded-md border border-border bg-background/40 max-h-64 overflow-y-auto p-2 space-y-0.5 font-mono">
              <For each={state().events}>
                {(ev) => (
                  <div class="flex gap-2 text-xs">
                    <span class="text-muted-foreground/60 flex-shrink-0 tabular-nums">
                      {new Date(ev.createdAt).toLocaleTimeString()}
                    </span>
                    <span
                      class={
                        ev.level === "error"
                          ? "text-destructive"
                          : ev.level === "warn"
                            ? "text-amber-400"
                            : "text-foreground"
                      }
                    >
                      {ev.message}
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
