import { openEditorTab } from "@/api/windows";
import type { AppStore } from "@/store/layout";

/// Open a conflicted file in the editor window's merge editor.
///
/// Shared rather than per-component because four separate surfaces route a
/// conflicted operation the same way, and the workbench / satellite split
/// (`openEditorTab` hands off to the editor window when there is one, and falls
/// back to this window's store when there isn't) is exactly the detail that rots
/// when it is written out four times. The operation banner used to call
/// `actions.openConflictTab` directly, which in detached-window mode wrote the
/// *git* window's non-persisted store — so the tabs appeared nowhere.
export function openMerge(
  actions: AppStore["actions"],
  worktreeId: string,
  filePath: string,
): Promise<void> {
  return openEditorTab({ kind: "open-conflict", filePath }, () =>
    actions.openConflictTab(worktreeId, filePath),
  );
}
