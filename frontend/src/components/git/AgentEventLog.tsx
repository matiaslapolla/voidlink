import { For } from "solid-js";
import type { AgentEvent } from "@/types/git";

interface AgentEventLogProps {
  events: AgentEvent[];
}

export function AgentEventLog(props: AgentEventLogProps) {
  return (
    <div class="rounded-md border border-border bg-background/40 max-h-64 overflow-y-auto p-2 space-y-0.5 font-mono">
      <For each={props.events}>
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
  );
}
