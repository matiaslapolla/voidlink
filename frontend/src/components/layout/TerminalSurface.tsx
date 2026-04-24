import { For, Show } from "solid-js";
import { TerminalSquare } from "lucide-solid";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { GitDiffView } from "@/components/git/GitDiffView";
import { useAppStore } from "@/store/LayoutContext";

export function TerminalSurface() {
  const {
    state,
    activeWorkspace,
    activeTerminals,
    activeDiffTabs,
    activeItem,
    actions,
  } = useAppStore();

  const activeTerminalId = () => {
    const a = activeItem();
    return a?.type === "terminal" ? a.id : null;
  };
  const activeDiffId = () => {
    const a = activeItem();
    return a?.type === "diff" ? a.id : null;
  };
  const hasAnything = () => activeTerminals().length > 0 || activeDiffTabs().length > 0;

  return (
    <div class="flex-1 relative overflow-hidden bg-background">
      <Show
        when={(activeWorkspace()?.repoRoot ?? null) !== null}
        fallback={<EmptyState message="Select a repository in the sidebar to start working." />}
      >
        <Show when={hasAnything()} fallback={
          <EmptyState message="Nothing open. Start a terminal with + in the sidebar, or click a file in the Git panel to open its diff." />
        }>
          {/* Terminals — kept mounted, visibility toggled. */}
          <For each={activeTerminals()}>
            {(term) => (
              <div
                class="absolute inset-0"
                style={{ display: term.id === activeTerminalId() ? "block" : "none" }}
              >
                <TerminalPane
                  ptyId={term.ptyId}
                  active={term.id === activeTerminalId()}
                  class="w-full h-full"
                  onExit={() => actions.removeTerminal(state.activeWorkspaceId, term.id)}
                />
              </div>
            )}
          </For>

          {/* Diff tabs — also mounted; each shows for its own active id. */}
          <For each={activeDiffTabs()}>
            {(tab) => (
              <Show when={activeWorkspace()?.repoRoot}>
                {(repo) => (
                  <div
                    class="absolute inset-0"
                    style={{ display: tab.id === activeDiffId() ? "block" : "none" }}
                  >
                    <GitDiffView
                      repoPath={repo()}
                      filePath={tab.filePath}
                      onClose={() => actions.closeDiffTab(state.activeWorkspaceId, tab.id)}
                    />
                  </div>
                )}
              </Show>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}

function EmptyState(props: { message: string }) {
  return (
    <div class="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
      <TerminalSquare class="w-6 h-6 opacity-60" />
      <p class="text-xs">{props.message}</p>
    </div>
  );
}
