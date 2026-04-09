import { createResource, Show } from "solid-js";
import { GitBranch } from "lucide-solid";
import { gitApi } from "@/api/git";

export function BranchesView(props: { repoPath: string }) {
  const [branches] = createResource(
    () => props.repoPath,
    (path) => gitApi.listBranches(path, true),
  );

  return (
    <div class="space-y-2">
      <h3 class="text-sm font-semibold">Branches</h3>
      <Show when={branches.loading}>
        <p class="text-xs text-muted-foreground">Loading…</p>
      </Show>
      <div class="space-y-1">
        {(branches() ?? []).map((b) => (
          <div
            class={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
              b.isHead ? "bg-primary/10 border border-primary/20" : "border border-border"
            }`}
          >
            <GitBranch class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span class={b.isHead ? "font-semibold text-primary" : ""}>{b.name}</span>
            <Show when={b.isHead}>
              <span class="text-xs text-primary/60">HEAD</span>
            </Show>
            <div class="ml-auto flex items-center gap-2 text-muted-foreground">
              <Show when={b.lastCommitSummary}>
                <span class="max-w-40 truncate">{b.lastCommitSummary}</span>
              </Show>
              <Show when={b.ahead > 0}>
                <span class="text-green-500">↑{b.ahead}</span>
              </Show>
              <Show when={b.behind > 0}>
                <span class="text-red-400">↓{b.behind}</span>
              </Show>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
