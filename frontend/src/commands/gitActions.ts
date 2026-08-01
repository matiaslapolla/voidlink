import { emitGitRefsChanged } from "@/commands/gitEvents";
import { requestAiCommitDraft } from "@/commands/aiCommit";
import { requestGitSidebarAction, type GitSidebarAction } from "@/commands/gitSidebarActions";
import { pushToast } from "@/commands/toast";
import { useActionSource, type Action } from "@/commands/registry";
import { openGitWindow } from "@/api/windows";
import { useAppStore } from "@/store/LayoutContext";

/// Git's palette entries, registered here instead of spelled out inside
/// `App.tsx`'s catalog — see PALETTE-SRC1 in `commands/registry.ts` for why
/// that mattered. Call once, from `AppInner`'s body, the same place
/// `useKeybindings` is called: it needs to run inside the store's provider so
/// `useAppStore()` resolves, but sets up no reactivity of its own — the
/// closures below are read by the single composed catalog effect, which is
/// what makes them reactive.
///
/// Three separate `registerActionSource` calls, not one: the original
/// hand-written array in `App.tsx` interleaved git actions with stack, app
/// and view actions (`git.refresh`…`git.compare`, then later `git.open-window`
/// beside the stack block, then `git.ai-draft-commit` after the view-toggle
/// block). The priorities below reproduce those exact original positions so
/// this extraction does not reshuffle the palette's resting order.
export function registerGitActions(): void {
  const { state, activeRepoPath, actions } = useAppStore();

  /// Run a sidebar-owned git action, revealing the panel if it is not
  /// mounted. Moved out of `AppInner` verbatim: the request is held by
  /// `gitSidebarActions` and replayed once the sidebar registers, so
  /// expanding here completes an in-flight request rather than merely making
  /// the next attempt work.
  function runGitSidebarAction(action: GitSidebarAction): void {
    if (requestGitSidebarAction(action)) return;
    if (state.gitSidebarCollapsed) actions.toggleGitSidebar();
  }

  useActionSource(50, (): Action[] => {
    const repo = activeRepoPath();
    const wtId = state.activeWorktreeId;
    return [
      {
        id: "git.refresh",
        label: "Refresh git status",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          // The sidebar owns its own refetch; broadcasting via a window event
          // keeps the action decoupled from the component tree.
          emitGitRefsChanged();
        },
      },
      {
        id: "git.fetch",
        label: "Fetch from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("fetch"),
      },
      {
        id: "git.pull",
        label: "Pull from origin",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("pull"),
      },
      {
        id: "git.remotes",
        label: "Manage remotes…",
        group: "Git",
        enabled: () => !!repo,
        run: () => runGitSidebarAction("remotes"),
      },
      {
        id: "git.undo-last-commit",
        label: "Undo last commit (soft)",
        group: "Git",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { gitApi } = await import("@/api/git");
          await gitApi.undoLastCommit(repo);
          emitGitRefsChanged();
        },
      },
      {
        id: "git.compare",
        label: "Compare branches…",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          actions.openCompareTab(wtId);
        },
      },
    ];
  });

  useActionSource(70, (): Action[] => [
    {
      id: "git.open-window",
      label: "Open git window",
      description: "The full git client in its own window",
      group: "Git",
      run: async () => {
        try {
          const created = await openGitWindow();
          if (!created) pushToast("Git window brought to front", "info", 2000);
        } catch (e) {
          pushToast(
            `Could not open the git window: ${e instanceof Error ? e.message : String(e)}`,
            "error",
          );
        }
      },
    },
  ]);

  useActionSource(110, (): Action[] => {
    const repo = activeRepoPath();
    return [
      {
        id: "git.ai-draft-commit",
        label: "Draft commit message with AI",
        description: "Pipe staged diff to your configured CLI",
        group: "Git",
        enabled: () => !!repo,
        run: () => {
          if (!repo) {
            pushToast("Open a repository first", "warning");
            return;
          }
          requestAiCommitDraft();
        },
      },
    ];
  });
}
