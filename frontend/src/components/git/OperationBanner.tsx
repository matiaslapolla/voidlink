import { Show } from "solid-js";
import { AlertTriangle } from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import { pushToast } from "@/commands/toast";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { createInFlight } from "@/commands/inflight";
import { openMerge } from "@/components/git/openMerge";
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
///
/// Every read of `props` happens **before** the first `await`. Props in Solid are
/// live getters, and the `<Show when={repoInfo()?.operation}>` above this
/// component disposes it the moment the operation ends — which is precisely when
/// a successful continue returns. Reading `props.operation` afterwards yielded
/// `undefined`, so a completing rebase toasted "undefined continued".
export function OperationBanner(props: {
  repoPath: string;
  worktreeId: string;
  operation: Operation;
  hasConflicts: boolean;
}) {
  const { actions } = useAppStore();
  const { busy, run } = createInFlight();

  /// Open whatever is still conflicted, through the same path every other call
  /// site uses. Calling `actions.openConflictTab` directly wrote the git window's
  /// own non-persisted store in detached mode, so no tab ever appeared.
  async function openRemainingConflicts(repoPath: string) {
    try {
      const conflicts = await gitApi.listConflicts(repoPath);
      await Promise.all(
        conflicts.map((c) => openMerge(actions, props.worktreeId, `${repoPath}/${c}`)),
      );
    } catch (e) {
      pushToast(
        `Could not open the remaining conflicts: ${e instanceof Error ? e.message : String(e)}`,
        "error",
        6000,
      );
    }
  }

  async function continueOp() {
    // Snapshot everything this handler needs, then never touch props again.
    const op = props.operation;
    const label = LABELS[op];
    const repoPath = props.repoPath;
    const hadConflicts = props.hasConflicts;

    if (hadConflicts) {
      pushToast("Resolve all conflicts first, then continue.", "warning", 4000);
      await openRemainingConflicts(repoPath);
      return;
    }

    await run(async () => {
      try {
        const res =
          op === "rebase"
            ? await gitApi.rebaseContinue(repoPath)
            : op === "cherry-pick"
              ? await gitApi.cherryPickContinue(repoPath)
              : op === "revert"
                ? await gitApi.revertContinue(repoPath)
                : // merge has no "--continue"; finishing it is just a commit.
                  null;

        if (op === "merge") {
          pushToast("Conflicts resolved — commit to finish the merge.", "info", 4000);
        } else if (res?.conflicted) {
          pushToast("More conflicts to resolve.", "warning", 4000);
          await openRemainingConflicts(repoPath);
        } else if (res && !res.ok) {
          pushToast(res.message || `${label} could not continue`, "error", 7000);
        } else {
          pushToast(`${label} continued`, "success", 2500);
        }
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
      } finally {
        emitGitRefsChanged();
      }
    });
  }

  async function abortOp() {
    const op = props.operation;
    const label = LABELS[op];
    const repoPath = props.repoPath;

    await run(async () => {
      try {
        if (op === "merge") await gitApi.mergeAbort(repoPath);
        else if (op === "rebase") await gitApi.rebaseAbort(repoPath);
        else if (op === "cherry-pick") await gitApi.cherryPickAbort(repoPath);
        else if (op === "revert") await gitApi.revertAbort(repoPath);
        pushToast(`${label} aborted`, "info", 2500);
      } catch (e) {
        pushToast(e instanceof Error ? e.message : String(e), "error", 7000);
      } finally {
        emitGitRefsChanged();
      }
    });
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
            disabled={busy()}
            class="flex-1 px-2 py-1 rounded text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy() ? "Working…" : "Continue"}
          </button>
        </Show>
        <Show when={props.operation === "merge" && !props.hasConflicts}>
          <span class="flex-1 text-muted-foreground">Commit to finish.</span>
        </Show>
        <button
          onClick={() => void abortOp()}
          disabled={busy()}
          class="px-2 py-1 rounded text-[12px] text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Abort
        </button>
      </div>
    </div>
  );
}
