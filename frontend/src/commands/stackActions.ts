import { emitGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { textPrompt } from "@/commands/prompt";
import { useActionSource, type Action } from "@/commands/registry";
import { useAppStore } from "@/store/LayoutContext";

/// Stack's palette entries, moved out of `App.tsx`'s catalog — see
/// PALETTE-SRC1 in `commands/registry.ts`. Call once from `AppInner`'s body.
///
/// One `registerActionSource` call: unlike git, the original array kept the
/// whole stack block contiguous, so one priority reproduces its position.
export function registerStackActions(): void {
  const { state, activeRepoPath, actions } = useAppStore();

  useActionSource(80, (): Action[] => {
    const repo = activeRepoPath();
    const wtId = state.activeWorktreeId;
    return [
      {
        id: "stack.branch-on-top",
        label: "Stack: Branch on top of current",
        description: "Create a child of the current branch and start a stack",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          const { gitApi } = await import("@/api/git");
          try {
            const info = await gitApi.repoInfo(repo);
            const parent = info.currentBranch;
            if (!parent) {
              pushToast("HEAD is detached — check out a branch first", "warning");
              return;
            }
            const name = await textPrompt({
              title: "New branch",
              label: `Create on top of ${parent}`,
              placeholder: "feature/my-branch",
              confirmLabel: "Create",
            });
            if (!name) return;
            await stackApi.createBranch(repo, name, parent);
            pushToast(`Created ${name} on top of ${parent}`, "success");
            emitGitRefsChanged();
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
      {
        id: "stack.restack-all",
        label: "Stack: Restack all",
        description: "Replay every branch in the current stack onto its parent's current tip",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack", "warning");
              return;
            }
            const results = await stackApi.restackAll(
              repo,
              stack.branches.map((b) => b.name),
            );
            const conflict = results.find((r) => r.outcome.kind === "conflict");
            if (conflict && conflict.outcome.kind === "conflict") {
              pushToast(
                `Conflict on ${conflict.branch}: ${conflict.outcome.paths.join(", ")}`,
                "error",
                6000,
              );
            } else {
              const replayed = results.reduce(
                (n, r) => n + (r.outcome.kind === "restacked" ? r.outcome.commitsReplayed : 0),
                0,
              );
              pushToast(`Stack restacked clean (${replayed} commits replayed)`, "success");
            }
            emitGitRefsChanged();
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
      {
        id: "stack.submit",
        label: "Stack: Submit to GitHub",
        description: "Create or update one PR per branch (requires GITHUB_TOKEN)",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack", "warning");
              return;
            }
            const results = await stackApi.submit(
              repo,
              stack.branches.map((b) => b.name),
            );
            const failed = results.filter((r) => r.outcome.kind === "failed").length;
            if (failed === 0) {
              pushToast(`Submitted ${results.length} branch(es)`, "success");
            } else {
              pushToast(
                `Submit finished with ${failed} failure(s) — open the stack tab for details`,
                "warning",
                6000,
              );
            }
            emitGitRefsChanged();
          } catch (e) {
            pushToast(String(e), "error", 6000);
          }
        },
      },
      {
        id: "stack.open-tab",
        label: "Stack: Open stack workspace",
        description: "Open a tab with the full stack graph for the current branch",
        group: "Stack",
        enabled: () => !!repo,
        run: async () => {
          if (!repo) return;
          const { stackApi } = await import("@/api/stack");
          try {
            const stack = await stackApi.current(repo);
            if (!stack) {
              pushToast("Not on a stack — use 'Branch on top' first", "warning");
              return;
            }
            const top = stack.branches.at(-1)?.name;
            if (!top) return;
            actions.openStackTab(wtId, { trunk: stack.trunk, topBranch: top });
          } catch (e) {
            pushToast(String(e), "error");
          }
        },
      },
    ];
  });
}
