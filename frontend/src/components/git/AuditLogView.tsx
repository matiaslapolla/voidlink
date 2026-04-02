import { Show, For } from "solid-js";
import type { AuditEntry } from "@/types/git";

interface AuditLogViewProps {
  entries: AuditEntry[];
  loading: boolean;
}

export function AuditLogView(props: AuditLogViewProps) {
  return (
    <div class="space-y-2">
      <h3 class="text-sm font-semibold">Audit Log</h3>
      <Show when={props.loading}>
        <p class="text-xs text-muted-foreground">Loading…</p>
      </Show>
      <Show when={props.entries.length === 0 && !props.loading}>
        <p class="text-xs text-muted-foreground">No audit entries yet.</p>
      </Show>
      <For each={props.entries}>
        {(entry) => (
          <div class="rounded-md border border-border p-2 space-y-0.5">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium">{entry.action}</span>
              <span class="text-muted-foreground">
                {new Date(entry.timestamp).toLocaleString()}
              </span>
            </div>
            <div class="text-xs text-muted-foreground">
              {entry.actor} — {entry.details}
            </div>
          </div>
        )}
      </For>
    </div>
  );
}
