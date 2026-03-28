import { createSignal, createResource, For, Show } from "solid-js";
import { marked } from "marked";
import { CheckCircle, Flag, Loader, ExternalLink, Sparkles, RefreshCcw } from "lucide-solid";
import { gitReviewApi } from "@/api/git-review";
import { gitApi } from "@/api/git";
import { DiffViewer } from "./DiffViewer";
import { MergeButton } from "./MergeButton";
import type { ReviewChecklist } from "@/types/git";

interface PrReviewViewProps {
  repoPath: string;
  prNumber: number;
  onBack: () => void;
  onMerged: () => void;
}

const categoryColors: Record<string, string> = {
  security: "text-red-400",
  performance: "text-amber-400",
  correctness: "text-blue-400",
  style: "text-purple-400",
  testing: "text-green-400",
};

export function PrReviewView(props: PrReviewViewProps) {
  const [checklist, setChecklist] = createSignal<ReviewChecklist | null>(null);
  const [checklistLoading, setChecklistLoading] = createSignal(false);
  const [checklistError, setChecklistError] = createSignal<string | null>(null);
  const [activeTab, setActiveTab] = createSignal<"review" | "diff" | "audit">("review");

  const [pr] = createResource(
    () => ({ path: props.repoPath, num: props.prNumber }),
    (src) => gitReviewApi.getPr(src.path, src.num),
  );

  const [diff] = createResource(
    () => {
      const p = pr();
      if (!p) return null;
      return { path: props.repoPath, base: p.baseBranch, head: p.headBranch };
    },
    (src) => src ? gitApi.diffBranches(src.path, src.base, src.head) : null,
  );

  const [auditLog] = createResource(
    () => ({ path: props.repoPath, num: props.prNumber }),
    (src) => gitReviewApi.getAuditLog(src.path, src.num),
  );

  const loadChecklist = async () => {
    setChecklistLoading(true);
    setChecklistError(null);
    try {
      const result = await gitReviewApi.generateChecklist(
        props.repoPath,
        props.prNumber,
      );
      setChecklist(result);
    } catch (e) {
      setChecklistError(String(e));
    } finally {
      setChecklistLoading(false);
    }
  };

  const updateItem = async (itemId: string, status: "unchecked" | "passed" | "flagged") => {
    try {
      await gitReviewApi.updateChecklistItem(
        props.repoPath,
        props.prNumber,
        itemId,
        status,
      );
      setChecklist((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((i) =>
            i.id === itemId ? { ...i, status } : i,
          ),
        };
      });
    } catch (e) {
      // Non-critical
    }
  };

  return (
    <div class="flex flex-col h-full">
      {/* Header */}
      <div class="border-b border-border p-3 space-y-2">
        <div class="flex items-center gap-2">
          <button
            onClick={props.onBack}
            class="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← PRs
          </button>
        </div>

        <Show when={pr()}>
          {(prInfo) => (
            <div>
              <div class="flex items-start justify-between gap-2">
                <h2 class="font-semibold text-sm">
                  #{prInfo().number} {prInfo().title}
                </h2>
                <a
                  href={prInfo().url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex-shrink-0"
                >
                  <ExternalLink class="w-4 h-4 text-muted-foreground hover:text-foreground" />
                </a>
              </div>
              <div class="text-xs text-muted-foreground">
                {prInfo().headBranch} → {prInfo().baseBranch} · by {prInfo().author}
              </div>
            </div>
          )}
        </Show>

        {/* Tabs */}
        <div class="flex gap-1">
          {(["review", "diff", "audit"] as const).map((tab) => (
            <button
              onClick={() => setActiveTab(tab)}
              class={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                activeTab() === tab
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-accent/60 text-muted-foreground"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div class="flex-1 overflow-y-auto p-3">
        <Show when={activeTab() === "review"}>
          <div class="space-y-4">
            {/* PR body */}
            <Show when={pr()?.body}>
              <div
                class="prose prose-sm prose-invert max-w-none text-sm pb-3 border-b border-border"
                innerHTML={marked.parse(pr()!.body) as string}
              />
            </Show>

            {/* Checklist */}
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold flex items-center gap-2">
                  <Sparkles class="w-4 h-4 text-primary" />
                  Review Checklist
                </h3>
                <button
                  onClick={() => void loadChecklist()}
                  disabled={checklistLoading()}
                  class="flex items-center gap-1 text-xs rounded border border-border px-2 py-1 hover:bg-accent/60 disabled:opacity-50"
                >
                  <Show when={checklistLoading()}>
                    <Loader class="w-3 h-3 animate-spin" />
                  </Show>
                  <RefreshCcw class="w-3 h-3" />
                  {checklist() ? "Regenerate" : "Generate"}
                </button>
              </div>

              <Show when={checklistError()}>
                <p class="text-xs text-destructive">{checklistError()}</p>
              </Show>

              <Show when={checklist()}>
                {(cl) => (
                  <div class="space-y-2">
                    <Show when={cl().aiSummary}>
                      <p class="text-xs text-muted-foreground border border-border rounded-md px-3 py-2 bg-card/30">
                        {cl().aiSummary}
                      </p>
                    </Show>
                    <For each={cl().items}>
                      {(item) => (
                        <div class="flex items-start gap-2 rounded-md border border-border p-2">
                          <div class="flex gap-1 flex-shrink-0 mt-0.5">
                            <button
                              onClick={() => void updateItem(item.id, "passed")}
                              title="Mark as passed"
                              class={`p-0.5 rounded transition-colors ${
                                item.status === "passed"
                                  ? "text-green-500"
                                  : "text-muted-foreground hover:text-green-500"
                              }`}
                            >
                              <CheckCircle class="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => void updateItem(item.id, "flagged")}
                              title="Flag this item"
                              class={`p-0.5 rounded transition-colors ${
                                item.status === "flagged"
                                  ? "text-red-500"
                                  : "text-muted-foreground hover:text-red-500"
                              }`}
                            >
                              <Flag class="w-4 h-4" />
                            </button>
                          </div>
                          <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                              <span
                                class={`text-xs font-medium uppercase ${categoryColors[item.category] ?? "text-muted-foreground"}`}
                              >
                                {item.category}
                              </span>
                              <span class="text-xs text-foreground">{item.description}</span>
                            </div>
                            <Show when={item.aiNote}>
                              <p class="text-xs text-muted-foreground mt-0.5">{item.aiNote}</p>
                            </Show>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </div>

            {/* Merge button */}
            <Show when={pr()}>
              {(prInfo) => (
                <div class="pt-2 border-t border-border">
                  <MergeButton
                    repoPath={props.repoPath}
                    prNumber={props.prNumber}
                    checklist={checklist()}
                    ciStatus={prInfo().ciStatus}
                    onMerged={props.onMerged}
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === "diff"}>
          <Show when={diff.loading}>
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader class="w-4 h-4 animate-spin" />
              Loading diff…
            </div>
          </Show>
          <Show when={diff()}>
            {(d) => <DiffViewer diff={d()} />}
          </Show>
        </Show>

        <Show when={activeTab() === "audit"}>
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">Audit Log</h3>
            <Show when={auditLog.loading}>
              <p class="text-xs text-muted-foreground">Loading…</p>
            </Show>
            <Show when={(auditLog() ?? []).length === 0 && !auditLog.loading}>
              <p class="text-xs text-muted-foreground">No audit entries yet.</p>
            </Show>
            <For each={auditLog() ?? []}>
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
        </Show>
      </div>
    </div>
  );
}
