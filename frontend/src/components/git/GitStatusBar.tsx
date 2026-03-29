import { createSignal, createEffect, Show, onCleanup } from "solid-js";
import { GitBranch, GitCommit, Circle } from "lucide-solid";
import { gitApi } from "@/api/git";
import type { GitRepoInfo } from "@/types/git";
import { BranchPicker } from "./BranchPicker";

interface GitStatusBarProps {
  repoPath: string;
  onOpenGit?: () => void;
}

export function GitStatusBar(props: GitStatusBarProps) {
  const [info, setInfo] = createSignal<GitRepoInfo | null>(null);
  const [branchPickerOpen, setBranchPickerOpen] = createSignal(false);

  const refresh = () => {
    gitApi
      .repoInfo(props.repoPath)
      .then(setInfo)
      .catch(() => setInfo(null));
  };

  createEffect(() => {
    if (!props.repoPath) return;
    refresh();
    const id = window.setInterval(refresh, 3000);
    onCleanup(() => window.clearInterval(id));
  });

  return (
    <Show when={info()}>
      {(repoInfo) => (
        <div class="relative flex items-center gap-3 border-t border-border px-3 py-1 text-xs bg-background/60 text-muted-foreground select-none flex-shrink-0">
          {/* Branch button */}
          <button
            onClick={() => setBranchPickerOpen((p) => !p)}
            class="flex items-center gap-1 hover:text-foreground transition-colors rounded px-1 py-0.5 hover:bg-accent/60"
            title="Switch branch"
          >
            <GitBranch class="w-3.5 h-3.5 flex-shrink-0" />
            <span class="font-medium">
              {repoInfo().currentBranch ?? "(detached)"}
            </span>
          </button>

          {/* Dirty indicator */}
          <Show when={!repoInfo().isClean}>
            <span
              class="flex items-center gap-1 text-amber-500"
              title="Uncommitted changes"
            >
              <Circle class="w-2 h-2 fill-current" />
              modified
            </span>
          </Show>

          {/* Open git panel */}
          <Show when={props.onOpenGit}>
            <button
              onClick={props.onOpenGit}
              class="ml-auto flex items-center gap-1 hover:text-foreground transition-colors rounded px-1 py-0.5 hover:bg-accent/60"
              title="Open Git panel"
            >
              <GitCommit class="w-3.5 h-3.5" />
              Git
            </button>
          </Show>

          {/* Branch picker popover */}
          <Show when={branchPickerOpen()}>
            <BranchPicker
              repoPath={props.repoPath}
              onClose={() => setBranchPickerOpen(false)}
              onBranchCheckedOut={() => {
                setBranchPickerOpen(false);
                refresh();
              }}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}
