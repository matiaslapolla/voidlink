import { createSignal, createResource, For, Show } from "solid-js";
import { ExternalLink, GitMerge, GitPullRequest, Loader, RefreshCcw } from "lucide-solid";
import { gitReviewApi } from "@/api/git-review";

interface PrDashboardProps {
  repoPath: string;
  onOpenReview: (prNumber: number) => void;
}

const ciColors: Record<string, string> = {
  success: "bg-success",
  failure: "bg-destructive",
  pending: "bg-warning",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const PR_FILTER_KEY = "voidlink-pr-filter";

export function PrDashboard(props: PrDashboardProps) {
  const stored = localStorage.getItem(PR_FILTER_KEY);
  const [stateFilter, setStateFilter] = createSignal(stored || "open");

  const updateFilter = (v: string) => {
    setStateFilter(v);
    localStorage.setItem(PR_FILTER_KEY, v);
  };

  const [prs, { refetch }] = createResource(
    () => [props.repoPath, stateFilter()] as const,
    ([path, filter]) => gitReviewApi.listPrs(path, filter),
  );

  return (
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2">
          <GitPullRequest class="w-4 h-4" />
          Pull Requests
        </h3>
        <div class="flex items-center gap-2">
          <select
            value={stateFilter()}
            onChange={(e) => updateFilter(e.currentTarget.value)}
            class="rounded border border-border bg-background px-2 py-1 text-xs outline-none"
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button
            onClick={() => refetch()}
            class="p-1 rounded hover:bg-accent/60 transition-colors"
            title="Refresh"
          >
            <RefreshCcw class="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      <Show when={prs.loading}>
        <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader class="w-4 h-4 animate-spin" />
          Loading PRs…
        </div>
      </Show>

      <Show when={prs.error}>
        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {String(prs.error)}
        </div>
      </Show>

      <Show when={(prs() ?? []).length === 0 && !prs.loading}>
        <p class="text-sm text-muted-foreground py-4 text-center">
          No {stateFilter()} pull requests found.
          <br />
          <span class="text-xs">Make sure GITHUB_TOKEN is set.</span>
        </p>
      </Show>

      <div class="space-y-2">
        <For each={prs() ?? []}>
          {(pr) => (
            <div
              class="rounded-md border border-border bg-card/60 p-3 space-y-2 hover:border-primary/40 transition-colors"
            >
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <Show when={pr.draft}>
                      <span class="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        Draft
                      </span>
                    </Show>
                    <button
                      onClick={() => props.onOpenReview(pr.number)}
                      class="font-medium text-sm hover:text-primary transition-colors text-left line-clamp-1"
                    >
                      #{pr.number} {pr.title}
                    </button>
                  </div>
                  <div class="text-xs text-muted-foreground mt-0.5">
                    {pr.headBranch} → {pr.baseBranch} · {pr.author} · {timeAgo(pr.updatedAt)}
                  </div>
                </div>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  class="flex-shrink-0 p-1 rounded hover:bg-accent/60 transition-colors"
                  title="Open on GitHub"
                >
                  <ExternalLink class="w-3.5 h-3.5 text-muted-foreground" />
                </a>
              </div>

              <div class="flex items-center gap-3 text-xs text-muted-foreground">
                <span class="text-success">+{pr.additions}</span>
                <span class="text-destructive">-{pr.deletions}</span>
                <span>{pr.changedFiles} files</span>
                <Show when={pr.ciStatus}>
                  <span class="flex items-center gap-1">
                    <span
                      class={`w-2 h-2 rounded-full ${ciColors[pr.ciStatus!] ?? "bg-muted"}`}
                    />
                    CI: {pr.ciStatus}
                  </span>
                </Show>
                <button
                  onClick={() => props.onOpenReview(pr.number)}
                  class="ml-auto flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-accent/60 transition-colors text-foreground"
                >
                  <GitMerge class="w-3 h-3" />
                  Review
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
