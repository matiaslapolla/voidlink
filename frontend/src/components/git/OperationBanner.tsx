import { Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import type { GitRepoInfo } from "@/types/git";

type Operation = NonNullable<GitRepoInfo["operation"]>;

const LABELS: Record<Operation, string> = {
  merge: "Merge",
  rebase: "Rebase",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

/// Shown whenever the repo is mid-operation (repoInfo.operation is non-null).
/// Continue/Abort are driven off the *current* operation, never off which
/// button the user last pressed — calling the wrong op's continue/abort
/// corrupts state. Continue is gated on conflicts being fully resolved.
export function OperationBanner(props: {
  repoPath: string;
  worktreeId: string;
  operation: Operation;
  hasConflicts: boolean;
}) {
  const { actions } = useAppStore();

  async function openRemainingConflicts() {
    const conflicts = await gitApi.listConflicts(props.repoPath);
    for (const c of conflicts) {
      actions.openConflictTab(props.worktreeId, `${props.repoPath}/${c}`);
    }
  }

  async function continueOp() {
    if (props.hasConflicts) {
      pushToast("Resolve all conflicts first, then continue.", "warning", 4000);
      void openRemainingConflicts();
      return;
    }
    try {
      const res =
        props.operation === "rebase"
          ? await gitApi.rebaseContinue(props.repoPath)
          : props.operation === "cherry-pick"
            ? await gitApi.cherryPickContinue(props.repoPath)
            : props.operation === "revert"
              ? await gitApi.revertContinue(props.repoPath)
              : // merge has no "--continue"; finishing it is just a commit.
                null;

      if (props.operation === "merge") {
        pushToast("Conflicts resolved — commit to finish the merge.", "info", 4000);
      } else if (res?.conflicted) {
        pushToast("More conflicts to resolve.", "warning", 4000);
        void openRemainingConflicts();
      } else if (res && !res.ok) {
        pushToast(res.message || `${LABELS[props.operation]} could not continue`, "error", 7000);
      } else {
        pushToast(`${LABELS[props.operation]} continued`, "success", 2500);
      }
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    } finally {
      emitGitRefsChanged();
    }
  }

  async function abortOp() {
    try {
      if (props.operation === "merge") await gitApi.mergeAbort(props.repoPath);
      else if (props.operation === "rebase") await gitApi.rebaseAbort(props.repoPath);
      else if (props.operation === "cherry-pick") await gitApi.cherryPickAbort(props.repoPath);
      else if (props.operation === "revert") await gitApi.revertAbort(props.repoPath);
      pushToast(`${LABELS[props.operation]} aborted`, "info", 2500);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
    } finally {
      emitGitRefsChanged();
    }
  }

  return (
    <div class="px-2.5 py-2 border-b border-warning/30 bg-warning/10 text-[12px] space-y-1.5">
      <div class="flex items-center gap-1.5 text-warning">
        <AlertTriangle class="w-3.5 h-3.5 shrink-0" />
        <span class="font-medium">{LABELS[props.operation]} in progress</span>
        <Show when={props.hasConflicts}>
          <span class="text-destructive">· conflicts</span>
        </Show>
      </div>
      <div class="flex items-center gap-1.5">
        <Show when={props.operation !== "merge"}>
          <button
            onClick={() => void continueOp()}
            class="flex-1 px-2 py-1 rounded text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Continue
          </button>
        </Show>
        <Show when={props.operation === "merge" && !props.hasConflicts}>
          <span class="flex-1 text-muted-foreground">Commit to finish.</span>
        </Show>
        <button
          onClick={() => void abortOp()}
          class="px-2 py-1 rounded text-[12px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        >
          Abort
        </button>
      </div>
    </div>
  );
}
