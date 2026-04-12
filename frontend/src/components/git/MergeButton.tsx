import { createSignal, Show } from "solid-js";
import { GitMerge, ChevronDown } from "lucide-solid";
import { gitReviewApi } from "@/api/git-review";
import type { ReviewChecklist } from "@/types/git";

interface MergeButtonProps {
  repoPath: string;
  prNumber: number;
  checklist: ReviewChecklist | null;
  ciStatus: string | null;
  onMerged: () => void;
}

export function MergeButton(props: MergeButtonProps) {
  const [method, setMethod] = createSignal<"merge" | "squash" | "rebase">("squash");
  const [deleteBranch, setDeleteBranch] = createSignal(true);
  const [deleteWorktree, setDeleteWorktree] = createSignal(true);
  const [merging, setMerging] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showOptions, setShowOptions] = createSignal(false);

  const flaggedItems = () =>
    props.checklist?.items.filter((i) => i.status === "flagged") ?? [];

  const ciBlocking = () => props.ciStatus === "failure";

  const canMerge = () =>
    !merging() && flaggedItems().length === 0 && !ciBlocking();

  const blockers = () => {
    const b: string[] = [];
    if (ciBlocking()) b.push("CI checks are failing");
    const flags = flaggedItems().length;
    if (flags > 0) b.push(`${flags} checklist item(s) are flagged`);
    return b;
  };

  const handleMerge = async () => {
    if (!canMerge()) return;
    setMerging(true);
    setError(null);
    try {
      await gitReviewApi.mergePr({
        repoPath: props.repoPath,
        prNumber: props.prNumber,
        method: method(),
        deleteBranch: deleteBranch(),
        deleteWorktree: deleteWorktree(),
      });
      props.onMerged();
    } catch (e) {
      setError(String(e));
    } finally {
      setMerging(false);
    }
  };

  return (
    <div class="space-y-2">
      {/* Blockers */}
      <Show when={blockers().length > 0}>
        <div class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 space-y-1">
          <p class="text-xs font-medium text-warning">Cannot merge:</p>
          <ul class="list-disc list-inside space-y-0.5">
            {blockers().map((b) => (
              <li class="text-xs text-warning/80">{b}</li>
            ))}
          </ul>
        </div>
      </Show>

      {/* Error */}
      <Show when={error()}>
        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error()}
        </div>
      </Show>

      {/* Merge controls */}
      <div class="flex items-stretch gap-0 rounded-md overflow-hidden border border-border">
        <button
          onClick={() => void handleMerge()}
          disabled={!canMerge()}
          class="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm bg-primary text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed hover:bg-primary/90 transition-colors"
        >
          <GitMerge class="w-4 h-4" />
          {merging() ? "Merging…" : `Merge (${method()})`}
        </button>
        <button
          onClick={() => setShowOptions((p) => !p)}
          class="px-2 border-l border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <ChevronDown class="w-4 h-4" />
        </button>
      </div>

      <Show when={showOptions()}>
        <div class="rounded-md border border-border p-3 space-y-3 bg-card/40">
          <div>
            <label class="block text-xs font-medium mb-1">Merge method</label>
            <div class="flex gap-2">
              {(["merge", "squash", "rebase"] as const).map((m) => (
                <label class="flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    type="radio"
                    name="merge-method"
                    value={m}
                    checked={method() === m}
                    onChange={() => setMethod(m)}
                  />
                  {m}
                </label>
              ))}
            </div>
          </div>
          <div class="space-y-1">
            <label class="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={deleteBranch()}
                onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
              />
              Delete branch after merge
            </label>
            <label class="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={deleteWorktree()}
                onChange={(e) => setDeleteWorktree(e.currentTarget.checked)}
              />
              Remove worktree after merge
            </label>
          </div>
        </div>
      </Show>
    </div>
  );
}
