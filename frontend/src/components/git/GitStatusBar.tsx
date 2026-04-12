import { createSignal, createEffect, Show } from "solid-js";
import { GitBranch, Circle, ChevronUp, ChevronDown } from "lucide-solid";
import { gitApi } from "@/api/git";
import type { GitRepoInfo } from "@/types/git";
import { BranchPicker } from "./BranchPicker";

interface GitStatusBarProps {
  repoPath: string;
  activeArea?: string;
  gitPanelOpen?: boolean;
  onToggleGit?: () => void;
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
    void props.activeArea;
    void props.gitPanelOpen;
    refresh();
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
              class="flex items-center gap-1 text-warning"
              title="Uncommitted changes"
            >
              <Circle class="w-2 h-2 fill-current" />
              modified
            </span>
          </Show>

          {/* Toggle git panel */}
          <Show when={props.onToggleGit}>
            <button
              onClick={props.onToggleGit}
              class="ml-auto flex items-center gap-1.5 hover:text-foreground transition-colors rounded px-1.5 py-0.5 hover:bg-accent/60"
              title={`${props.gitPanelOpen ? "Close" : "Open"} Git panel (Ctrl+G)`}
            >
              {props.gitPanelOpen ? (
                <ChevronDown class="w-3.5 h-3.5" />
              ) : (
                <ChevronUp class="w-3.5 h-3.5" />
              )}
              <span>Git</span>
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
