import { createResource, For, Show } from "solid-js";
import { gitReviewApi } from "@/api/git-review";

interface AuditLogProps {
  repoPath: string;
  prNumber?: number;
}

const actionColors: Record<string, string> = {
  merged: "text-primary",
  pr_created: "text-success",
  checklist_generated: "text-info",
  checklist_item_passed: "text-success",
  checklist_item_flagged: "text-destructive",
};

export function AuditLog(props: AuditLogProps) {
  const [entries] = createResource(
    () => ({ path: props.repoPath, pr: props.prNumber }),
    (src) => gitReviewApi.getAuditLog(src.path, src.pr),
  );

  return (
    <div class="space-y-3">
      <h3 class="text-sm font-semibold">Audit Trail</h3>

      <Show when={entries.loading}>
        <p class="text-xs text-muted-foreground">Loading…</p>
      </Show>

      <Show when={(entries() ?? []).length === 0 && !entries.loading}>
        <p class="text-xs text-muted-foreground">No audit entries recorded yet.</p>
      </Show>

      <div class="relative">
        {/* Timeline line */}
        <div class="absolute left-2 top-2 bottom-2 w-px bg-border" />

        <div class="space-y-3 pl-6">
          <For each={entries() ?? []}>
            {(entry) => (
              <div class="relative">
                {/* Dot */}
                <div class="absolute -left-6 top-1.5 w-2 h-2 rounded-full bg-border border-2 border-background" />

                <div class="rounded-md border border-border p-2 space-y-1">
                  <div class="flex items-center justify-between">
                    <span
                      class={`text-xs font-medium ${actionColors[entry.action] ?? "text-foreground"}`}
                    >
                      {entry.action.replace(/_/g, " ")}
                    </span>
                    <span class="text-xs text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <div class="text-xs text-muted-foreground">
                    <span class="font-medium">{entry.actor}</span> — {entry.details}
                  </div>
                  <Show when={entry.prNumber > 0 && !props.prNumber}>
                    <div class="text-xs text-muted-foreground">PR #{entry.prNumber}</div>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
