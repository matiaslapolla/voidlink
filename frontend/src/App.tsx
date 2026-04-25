import { Show, createSignal } from "solid-js";
import { AppShell } from "@/components/layout/AppShell";
import { TitleBar } from "@/components/layout/TitleBar";
import { WindowFrame } from "@/components/layout/WindowFrame";
import { WorkspaceTabBar } from "@/components/layout/WorkspaceTabBar";
import { TerminalSidebar } from "@/components/layout/TerminalSidebar";
import { MainSurface } from "@/components/layout/MainSurface";
import { GitSidebar, GitSidebarCollapsed } from "@/components/git/GitSidebar";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AppStoreContext, useAppStore } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { editorController } from "@/components/editor/editorController";

function AppInner() {
  const { state, activeWorkspace, actions } = useAppStore();
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  async function handleOpenFile(path: string) {
    const wsId = state.activeWorkspaceId;
    actions.openFileTab(wsId, path);
    await editorController.openFile(path);
  }

  return (
    <>
      <AppShell
        titleBar={<TitleBar onOpenSettings={() => setSettingsOpen(true)} />}
        tabBar={<WorkspaceTabBar />}
        sidebar={<TerminalSidebar onOpenFile={(path) => void handleOpenFile(path)} />}
        main={<MainSurface />}
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
