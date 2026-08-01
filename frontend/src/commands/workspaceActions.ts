import { pushToast } from "@/commands/toast";
import {
  closeWorktreeSwitcher,
  isWorktreeSwitcherOpen,
  openWorktreeSwitcher,
  useActionSource,
  type Action,
} from "@/commands/registry";
import { requestNewWorktree } from "@/commands/worktree";
import { WORKSPACE_SELECT_COUNT, workspaceSelectId } from "@/commands/actionIds";
import { useAppStore } from "@/store/LayoutContext";

/// Workspace and worktree palette entries — new/next/prev for both, remove,
/// the hidden `⌘1`…`⌘9` jump slots, and "Go to worktree…" — moved out of
/// `App.tsx`'s catalog (PALETTE-SRC1, `commands/registry.ts`) to where the
/// feature's own cycling logic can live beside it instead of as loose
/// closures in `AppInner`.
///
/// Three `registerActionSource` calls: the original array split this group
/// across three positions (the main block, the hidden select-by-index array a
/// little further down, and `workspace.switch` further still, after the tab
/// group) — the priorities reproduce those exact original positions.
export function registerWorkspaceActions(): void {
  const { state, activeWorkspace, activeWorktree, actions } = useAppStore();

  function cycleWorkspace(direction: 1 | -1) {
    const list = state.workspaces;
    if (list.length < 2) return;
    const idx = list.findIndex((w) => w.id === state.activeWorkspaceId);
    if (idx === -1) return;
    const next = (idx + direction + list.length) % list.length;
    actions.selectWorkspace(list[next].id);
  }

  /// Cycle within the active workspace's worktrees. Wraps, like the tab and
  /// workspace cycles, so repeated presses stay useful with two worktrees.
  function cycleWorktree(direction: 1 | -1) {
    const ws = activeWorkspace();
    if (!ws || ws.worktrees.length < 2) return;
    const idx = ws.worktrees.findIndex((wt) => wt.id === state.activeWorktreeId);
    if (idx === -1) return;
    const next = (idx + direction + ws.worktrees.length) % ws.worktrees.length;
    actions.selectWorktree(ws.worktrees[next].id);
  }

  /// Remove the active worktree from git and from the rail. Main worktrees are
  /// the workspace itself and are never removable this way. The palette's
  /// "Remove current worktree…".
  ///
  /// The `…` used to be a lie: this deleted the directory with no confirmation
  /// at all, offered no force path when git refused, and emitted no refresh
  /// pulse. It now runs the same flow as the rail and the sidebar.
  async function removeActiveWorktree() {
    const ws = activeWorkspace();
    const wt = activeWorktree();
    if (!ws?.repoRoot || !wt || wt.isMain) {
      pushToast("The main worktree can't be removed — close the workspace instead", "warning");
      return;
    }
    const { removeWorktreeWithConfirm } = await import("@/commands/worktreeRemove");
    const { worktreeLabel } = await import("@/types/workspace");
    const removed = await removeWorktreeWithConfirm({
      repoRoot: ws.repoRoot,
      path: wt.path,
      label: worktreeLabel(wt),
    });
    if (removed) actions.removeWorktree(ws.id, wt.id);
  }

  useActionSource(130, (): Action[] => [
    {
      id: "workspace.new",
      label: "New workspace",
      group: "Workspace",
      run: () => {
        actions.addWorkspace();
      },
    },
    {
      id: "workspace.next",
      label: "Next workspace",
      group: "Workspace",
      enabled: () => state.workspaces.length > 1,
      run: () => cycleWorkspace(1),
    },
    {
      id: "workspace.prev",
      label: "Previous workspace",
      group: "Workspace",
      enabled: () => state.workspaces.length > 1,
      run: () => cycleWorkspace(-1),
    },
    // ── Worktrees ────────────────────────────────────────────────────
    {
      id: "worktree.new",
      label: "New worktree…",
      description: "Create a linked worktree with env files and dependencies set up",
      group: "Workspace",
      enabled: () => !!activeWorkspace()?.isRepo,
      run: () => {
        const ws = activeWorkspace();
        if (!ws?.repoRoot) {
          pushToast("Open a folder in this workspace first", "warning");
          return;
        }
        if (!ws.isRepo) {
          pushToast("This folder isn't a git repository — worktrees need one", "warning");
          return;
        }
        requestNewWorktree({
          workspaceId: ws.id,
          repoRoot: ws.repoRoot,
          sourcePath: activeWorktree()?.path || ws.repoRoot,
        });
      },
    },
    {
      id: "worktree.next",
      label: "Next worktree",
      description: "Switch to the next worktree in this workspace",
      group: "Workspace",
      enabled: () => (activeWorkspace()?.worktrees.length ?? 0) > 1,
      run: () => cycleWorktree(1),
    },
    {
      id: "worktree.prev",
      label: "Previous worktree",
      description: "Switch to the previous worktree in this workspace",
      group: "Workspace",
      enabled: () => (activeWorkspace()?.worktrees.length ?? 0) > 1,
      run: () => cycleWorktree(-1),
    },
    {
      id: "worktree.remove",
      label: "Remove current worktree…",
      description: "Delete the active linked worktree's directory",
      group: "Workspace",
      enabled: () => activeWorktree()?.isMain === false,
      run: () => void removeActiveWorktree(),
    },
  ]);

  // ⌘1-⌘9 jump straight to a workspace. Registered so the keymap can bind
  // them, hidden so nine near-identical rows don't drown the palette.
  useActionSource(150, (): Action[] =>
    Array.from({ length: WORKSPACE_SELECT_COUNT }, (_, i): Action => ({
      id: workspaceSelectId(i + 1),
      label: `Go to workspace ${i + 1}`,
      group: "Workspace",
      hidden: true,
      enabled: () => !!state.workspaces[i],
      run: () => {
        const ws = state.workspaces[i];
        if (ws) actions.selectWorkspace(ws.id);
      },
    })),
  );

  useActionSource(180, (): Action[] => [
    {
      id: "workspace.switch",
      label: "Go to worktree…",
      description: "Every worktree across every workspace, with its dirty and ahead/behind state",
      group: "Workspace",
      run: () =>
        isWorktreeSwitcherOpen() ? closeWorktreeSwitcher() : openWorktreeSwitcher(),
    },
  ]);
}
