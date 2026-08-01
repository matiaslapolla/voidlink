/// Applying an `EditorRequest` to the layout store.
///
/// The editor surface never writes tab state itself — it asks for a mutation and
/// re-renders from what comes back. In detached mode that ask crosses a window
/// boundary as an event; in stacked mode it is a direct call. Both land here, so
/// there is one implementation of "open this tab" rather than a copy per mode
/// that can drift.
///
/// Note which pointer this writes: every action below is an *editor* tab action,
/// so they move `editorActiveItemByWorktree`, never the workbench's own
/// `activeItemByWorktree`. Those two pointers are what let the editor and the
/// workbench focus independently.

import type { EditorRequest } from "@/api/windows";
import type { AppStore } from "@/store/layout";

export function applyEditorRequest(
  state: AppStore["state"],
  actions: AppStore["actions"],
  worktreeId: string,
  req: EditorRequest,
): void {
  switch (req.kind) {
    case "open-file":
      actions.openFileTab(worktreeId, req.path);
      break;
    case "open-diff":
      actions.openDiffTab(worktreeId, req.filePath, req.staged ?? false);
      break;
    case "open-conflict":
      actions.openConflictTab(worktreeId, req.filePath);
      break;
    case "open-preview":
      actions.openPreviewTab(worktreeId, req.filePath);
      break;
    case "activate":
      switch (req.tab) {
        case "file": {
          // `selectFileTab` needs the path too — it is what tells Monaco which
          // model to bring forward — so the tab has to be looked up first.
          const tab = (state.openFilesByWorktree[worktreeId] ?? []).find(
            (f) => f.id === req.id,
          );
          if (tab) actions.selectFileTab(worktreeId, tab.id, tab.path);
          break;
        }
        case "diff":
          actions.selectDiffTab(worktreeId, req.id);
          break;
        case "conflict":
          actions.selectConflictTab(worktreeId, req.id);
          break;
        case "preview":
          actions.selectPreviewTab(worktreeId, req.id);
          break;
      }
      break;
    case "close":
      switch (req.tab) {
        case "file":
          actions.closeFileTab(worktreeId, req.id);
          break;
        case "diff":
          actions.closeDiffTab(worktreeId, req.id);
          break;
        case "conflict":
          actions.closeConflictTab(worktreeId, req.id);
          break;
        case "preview":
          actions.closePreviewTab(worktreeId, req.id);
          break;
      }
      break;
    case "reorder":
      actions.reorderItemTab(worktreeId, req.tab, req.fromId, req.toId);
      break;
    case "toggle-pin":
      actions.togglePinTab(worktreeId, req.id);
      break;
    case "open-compare": {
      // Compare is a workbench surface even though the editor's file tree can
      // start one. In detached mode the sender focuses `main` itself so the tab
      // isn't opened offscreen; in stacked mode the caller switches view.
      const id = actions.openCompareTab(worktreeId, {
        baseRef: req.baseRef,
        headRef: req.headRef,
        useMergeBase: req.useMergeBase,
      });
      if (req.selectedFilePath) {
        actions.setCompareSelectedFile(worktreeId, id, req.selectedFilePath);
      }
      break;
    }
  }
}
