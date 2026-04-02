import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DatabaseZap,
  GitBranch,
  Workflow,
} from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { GitStatusBar } from "@/components/git/GitStatusBar";
import { GitTabContent } from "@/components/git/GitTabContent";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { RepositoryHeader } from "@/components/repository/RepositoryHeader";
import { SearchTab } from "@/components/repository/SearchTab";
import { ContextBuilderTab } from "@/components/context/ContextBuilderTab";
import { WorkflowTab } from "@/components/workflow/WorkflowTab";
import { createScanPolling } from "@/hooks/useScanPolling";
import { createWorkflowManager } from "@/hooks/useWorkflowManager";
import type { SearchResult } from "@/types/migration";
import type { WorkspaceState, PersistedWorkspace } from "@/types/workspace";
import { createWorkspace } from "@/types/workspace";

const STORAGE_KEY = "voidlink-repo-workspaces";
const ACTIVE_STORAGE_KEY = "voidlink-active-repo-workspace";

interface AppState {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
}

function loadInitialState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedWorkspace[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const workspaces = parsed.map((item) => ({
          ...createWorkspace(item.name),
          id: item.id,
          repoRoot: item.repoRoot,
          activeArea: item.activeArea,
          objective: item.objective,
          constraintsText: item.constraintsText,
        }));
        const activeId = localStorage.getItem(ACTIVE_STORAGE_KEY);
        const activeWorkspaceId =
          activeId && workspaces.some((ws) => ws.id === activeId)
            ? activeId
            : workspaces[0].id;
        return { workspaces, activeWorkspaceId };
      }
    }
  } catch {
    // ignore corrupted local storage payloads
  }

  const initial = createWorkspace("Main");
  return {
    workspaces: [initial],
    activeWorkspaceId: initial.id,
  };
}

function App() {
  const initial = loadInitialState();
  const [workspaces, setWorkspaces] = createSignal<WorkspaceState[]>(initial.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>(initial.activeWorkspaceId);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  const activeWorkspace = createMemo(
    () => workspaces().find((ws) => ws.id === activeWorkspaceId()) ?? null,
  );

  const selectedContextTokenEstimate = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return 0;
    return ws.selectedContext.reduce(
      (sum, item) => sum + item.snippet.split(/\s+/).filter(Boolean).length,
      0,
    );
  });

  function updateWorkspace(id: string, updater: (workspace: WorkspaceState) => WorkspaceState) {
    setWorkspaces((prev) => prev.map((ws) => (ws.id === id ? updater(ws) : ws)));
  }

  // ─── Hooks ──────────────────────────────────────────────────────────────────

  const scanPolling = createScanPolling({
    getWorkspaces: workspaces,
    updateWorkspace,
  });

  const workflowManager = createWorkflowManager({
    getWorkspaces: workspaces,
    updateWorkspace,
  });

  // ─── Workspace CRUD ─────────────────────────────────────────────────────────

  function addWorkspace() {
    const count = workspaces().length + 1;
    const ws = createWorkspace(`Workspace ${count}`);
    setWorkspaces((prev) => [...prev, ws]);
    setActiveWorkspaceId(ws.id);
  }

  function removeWorkspace(id: string) {
    const next = workspaces().filter((ws) => ws.id !== id);
    if (next.length === 0) {
      const fallback = createWorkspace("Main");
      setWorkspaces([fallback]);
      setActiveWorkspaceId(fallback.id);
      return;
    }
    setWorkspaces(next);
    if (activeWorkspaceId() === id) {
      setActiveWorkspaceId(next[next.length - 1].id);
    }
  }

  // ─── Context helpers ────────────────────────────────────────────────────────

  function addContextResult(workspaceId: string, result: SearchResult) {
    updateWorkspace(workspaceId, (ws) => {
      if (ws.selectedContext.some((item) => item.id === result.id)) return ws;
      return { ...ws, selectedContext: [...ws.selectedContext, result] };
    });
  }

  function removeContextResult(workspaceId: string, resultId: string) {
    updateWorkspace(workspaceId, (ws) => ({
      ...ws,
      selectedContext: ws.selectedContext.filter((item) => item.id !== resultId),
    }));
  }

  // ─── Repository chooser ────────────────────────────────────────────────────

  async function chooseRepository(workspaceId: string): Promise<void> {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select repository root" });
      if (!selected || Array.isArray(selected)) return;
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        repoRoot: selected,
        lastError: null,
        searchResults: [],
        selectedContext: [],
        workflow: null,
        runState: null,
        activeRunId: null,
        scanStatus: null,
        lastScanJobId: null,
      }));
    } catch (error) {
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        lastError: error instanceof Error ? error.message : "Failed to open directory picker",
      }));
    }
  }

  // ─── Search ─────────────────────────────────────────────────────────────────

  async function performSearch(workspaceId: string): Promise<void> {
    const ws = workspaces().find((item) => item.id === workspaceId);
    if (!ws?.repoRoot || ws.searchQuery.trim().length === 0) return;

    updateWorkspace(workspaceId, (current) => ({ ...current, searching: true, lastError: null }));
    try {
      const results = await migrationApi.searchRepository(
        { repoPath: ws.repoRoot, text: ws.searchQuery.trim(), maxTokens: 120, type: "hybrid" },
        { limit: 20 },
      );
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        searchResults: results,
        searching: false,
      }));
    } catch (error) {
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        searching: false,
        lastError: error instanceof Error ? error.message : "Search failed",
      }));
    }
  }

  // ─── Effects ────────────────────────────────────────────────────────────────

  createEffect(() => {
    const serialized: PersistedWorkspace[] = workspaces().map((ws) => ({
      id: ws.id,
      name: ws.name,
      repoRoot: ws.repoRoot,
      activeArea: ws.activeArea,
      objective: ws.objective,
      constraintsText: ws.constraintsText,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized));
    localStorage.setItem(ACTIVE_STORAGE_KEY, activeWorkspaceId());
  });

  onMount(() => {
    migrationApi
      .getStartupRepoPath()
      .then((repoPath) => {
        if (!repoPath) return;
        const wsId = activeWorkspaceId();
        updateWorkspace(wsId, (ws) => ({
          ...ws,
          repoRoot: ws.repoRoot ?? repoPath,
        }));
      })
      .catch(() => {});
  });

  onCleanup(() => {
    scanPolling.cleanupTimers();
    workflowManager.cleanupTimers();
  });

  const win = getCurrentWindow();

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div class="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Titlebar */}
      <div class="flex items-center h-8 shrink-0 border-b border-border bg-background/70 select-none">
        <div data-tauri-drag-region class="flex-1 flex items-center px-3 h-full">
          <span class="text-xs font-semibold tracking-wide text-muted-foreground">Voidlink</span>
        </div>
        <div class="flex items-center h-full text-muted-foreground">
          <button
            onClick={() => void win.minimize()}
            class="w-10 h-full flex items-center justify-center hover:bg-accent/60 transition-colors text-sm"
            title="Minimize"
          >
            &#x2212;
          </button>
          <button
            onClick={() => void win.toggleMaximize()}
            class="w-10 h-full flex items-center justify-center hover:bg-accent/60 transition-colors text-xs"
            title="Maximize"
          >
            &#x25A1;
          </button>
          <button
            onClick={() => void win.close()}
            class="w-10 h-full flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors text-sm"
            title="Close"
          >
            &#x2715;
          </button>
        </div>
      </div>

      <div class="flex flex-1 overflow-hidden">
        <WorkspaceSidebar
          workspaces={workspaces()}
          activeId={activeWorkspaceId()}
          onSelect={setActiveWorkspaceId}
          onAdd={addWorkspace}
          onRemove={removeWorkspace}
          onRename={(id, name) => updateWorkspace(id, (ws) => ({ ...ws, name }))}
          onSettingsOpen={() => setSettingsOpen(true)}
        />

        <main class="flex-1 flex flex-col overflow-hidden">
          <Show when={activeWorkspace()}>
            {(wsAccessor) => {
              const ws = () => wsAccessor();

              return (
                <>
                  <RepositoryHeader
                    repoRoot={ws().repoRoot}
                    scanStatus={ws().scanStatus}
                    lastError={ws().lastError}
                    onChooseRepo={() => void chooseRepository(ws().id)}
                    onScan={(full) => void scanPolling.startScan(ws().id, full)}
                  />

                  <div class="border-b border-border px-3 py-2 flex flex-wrap gap-2 bg-background/60">
                    <button
                      onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "repository" }))}
                      class={`rounded-md px-3 py-1.5 text-sm ${
                        ws().activeArea === "repository"
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 hover:bg-accent"
                      }`}
                    >
                      <DatabaseZap class="inline w-4 h-4 mr-1" />
                      Repository
                    </button>
                    <button
                      onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "contextBuilder" }))}
                      class={`rounded-md px-3 py-1.5 text-sm ${
                        ws().activeArea === "contextBuilder"
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 hover:bg-accent"
                      }`}
                    >
                      Context Builder
                    </button>
                    <button
                      onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "workflow" }))}
                      class={`rounded-md px-3 py-1.5 text-sm ${
                        ws().activeArea === "workflow"
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent/60 hover:bg-accent"
                      }`}
                    >
                      <Workflow class="inline w-4 h-4 mr-1" />
                      Workflow
                    </button>
                    <Show when={ws().repoRoot}>
                      <button
                        onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "git" }))}
                        class={`rounded-md px-3 py-1.5 text-sm ${
                          ws().activeArea === "git"
                            ? "bg-primary text-primary-foreground"
                            : "bg-accent/60 hover:bg-accent"
                        }`}
                      >
                        <GitBranch class="inline w-4 h-4 mr-1" />
                        Git
                      </button>
                    </Show>
                  </div>

                  <section class="flex-1 overflow-hidden">
                    <Show when={ws().activeArea === "repository"}>
                      <SearchTab
                        searchQuery={ws().searchQuery}
                        searchResults={ws().searchResults}
                        searching={ws().searching}
                        repoRoot={ws().repoRoot}
                        onQueryChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, searchQuery: v }))}
                        onSearch={() => void performSearch(ws().id)}
                        onAddContext={(r) => addContextResult(ws().id, r)}
                      />
                    </Show>

                    <Show when={ws().activeArea === "contextBuilder"}>
                      <ContextBuilderTab
                        objective={ws().objective}
                        constraintsText={ws().constraintsText}
                        selectedContext={ws().selectedContext}
                        tokenEstimate={selectedContextTokenEstimate()}
                        onObjectiveChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, objective: v }))}
                        onConstraintsChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, constraintsText: v }))}
                        onRemoveContext={(id) => removeContextResult(ws().id, id)}
                      />
                    </Show>

                    <Show when={ws().activeArea === "git"}>
                      <Show when={ws().repoRoot} fallback={<div class="h-full flex items-center justify-center"><p class="text-sm text-muted-foreground">Select a repository to use Git features.</p></div>}>
                        {(repoRoot) => (
                          <div class="h-full">
                            <GitTabContent repoPath={repoRoot()} />
                          </div>
                        )}
                      </Show>
                    </Show>

                    <Show when={ws().activeArea === "workflow"}>
                      <WorkflowTab
                        workflow={ws().workflow}
                        runState={ws().runState}
                        generatingWorkflow={ws().generatingWorkflow}
                        runningWorkflow={ws().runningWorkflow}
                        onGenerate={() => void workflowManager.generateWorkflow(ws().id)}
                        onRun={() => void workflowManager.runWorkflow(ws().id)}
                      />
                    </Show>
                  </section>
                </>
              );
            }}
          </Show>
          <Show when={activeWorkspace()?.repoRoot}>
            {(repoRoot) => (
              <GitStatusBar
                repoPath={repoRoot()}
                onOpenGit={() => {
                  const wsId = activeWorkspaceId();
                  updateWorkspace(wsId, (ws) => ({ ...ws, activeArea: "git" }));
                }}
              />
            )}
          </Show>
        </main>
      </div>

      <SettingsPanel open={settingsOpen()} onOpenChange={setSettingsOpen} />
    </div>
  );
}

export default App;
