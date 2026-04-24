import { Show, createSignal } from "solid-js";
import { AppShell } from "@/components/layout/AppShell";
import { TitleBar } from "@/components/layout/TitleBar";
import { WindowFrame } from "@/components/layout/WindowFrame";
import { WorkspaceTabBar } from "@/components/layout/WorkspaceTabBar";
import { TerminalSidebar } from "@/components/layout/TerminalSidebar";
import { TerminalSurface } from "@/components/layout/TerminalSurface";
import { GitSidebar, GitSidebarCollapsed } from "@/components/git/GitSidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";

function AppInner() {
  const { state, activeWorkspace, actions } = useAppStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  return (
    <>
      <AppShell
        titleBar={<TitleBar onOpenSettings={() => setSettingsOpen(true)} />}
        tabBar={<WorkspaceTabBar />}
        sidebar={<TerminalSidebar />}
        main={<TerminalSurface />}
        rightSidebar={
          <Show when={activeWorkspace()?.repoRoot}>
            {(repo) => (
              <Show
                when={!state.gitSidebarCollapsed}
                fallback={<GitSidebarCollapsed onExpand={actions.toggleGitSidebar} />}
              >
                <GitSidebar repoPath={repo()} workspaceId={state.activeWorkspaceId} />
              </Show>
            )}
          </Show>
        }
      />
      <SettingsDialog open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <WindowFrame />
    </>
  );
}

export default function App() {
  const store = createAppStore();
  return (
    <AppStoreContext.Provider value={store}>
      <AppInner />
    </AppStoreContext.Provider>
  );
}
