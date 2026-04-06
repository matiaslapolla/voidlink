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
  Bot,
  DatabaseZap,
  TerminalSquare,
  Workflow,
} from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { GitStatusBar } from "@/components/git/GitStatusBar";
import { GitTabContent } from "@/components/git/GitTabContent";
import { AgentChatView } from "@/components/agent/AgentChatView";
import { BottomPanel } from "@/components/layout/BottomPanel";
import { MountOnce } from "@/components/layout/MountOnce";
import { TerminalView } from "@/components/terminal/TerminalView";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { WorkspaceSidebar } from "@/components/workspace/WorkspaceSidebar";
import { RepositoryHeader } from "@/components/repository/RepositoryHeader";
import { SearchTab } from "@/components/repository/SearchTab";
import { ContextBuilderTab } from "@/components/context/ContextBuilderTab";
import { ContextIndicator } from "@/components/context/ContextIndicator";
import { WorkflowTab } from "@/components/workflow/WorkflowTab";
import { createScanPolling } from "@/hooks/useScanPolling";
import { createWorkflowManager } from "@/hooks/useWorkflowManager";
import type { SearchResult } from "@/types/migration";
import type { WorkspaceState, PersistedWorkspace } from "@/types/workspace";
import { createWorkspace } from "@/types/workspace";
import type { ContextItem } from "@/types/context";
import { contextItemFromSearch, contextItemFromText, contextItemFromDiff } from "@/types/context";

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
          activeArea: item.activeArea === ("git" as string) ? "repository" : item.activeArea,
          objective: item.objective,
          constraintsText: item.constraintsText,
          gitPanelOpen: item.gitPanelOpen ?? false,
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

  const contextTokenEstimate = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return 0;
    return ws.contextItems.reduce((sum, item) => sum + item.tokenEstimate, 0);
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

  function addContextItem(workspaceId: string, item: ContextItem) {
    updateWorkspace(workspaceId, (ws) => {
      if (ws.contextItems.some((existing) => existing.id === item.id)) return ws;
      return { ...ws, contextItems: [...ws.contextItems, item] };
    });
  }

  function addContextFromSearch(workspaceId: string, result: SearchResult) {
    addContextItem(workspaceId, contextItemFromSearch(result));
  }

  function removeContextItem(workspaceId: string, itemId: string) {
    updateWorkspace(workspaceId, (ws) => ({
      ...ws,
      contextItems: ws.contextItems.filter((item) => item.id !== itemId),
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
        contextItems: [],
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
      gitPanelOpen: ws.gitPanelOpen,
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
                        onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "aiAgent" }))}
                        class={`rounded-md px-3 py-1.5 text-sm ${
                          ws().activeArea === "aiAgent"
                            ? "bg-primary text-primary-foreground"
                            : "bg-accent/60 hover:bg-accent"
                        }`}
                      >
                        <Bot class="inline w-4 h-4 mr-1" />
                        AI Agent
                      </button>
                      <button
                        onClick={() => updateWorkspace(ws().id, (current) => ({ ...current, activeArea: "terminal" }))}
                        class={`rounded-md px-3 py-1.5 text-sm ${
                          ws().activeArea === "terminal"
                            ? "bg-primary text-primary-foreground"
                            : "bg-accent/60 hover:bg-accent"
                        }`}
                      >
                        <TerminalSquare class="inline w-4 h-4 mr-1" />
                        Terminal
                      </button>
                    </Show>
                  </div>

                  <section class="flex-1 overflow-hidden relative">
                    {/* Props-driven tabs: Show is OK — state lives in workspace signals */}
                    <div
                      class="absolute inset-0"
                      style={{ display: ws().activeArea === "repository" ? "block" : "none" }}
                    >
                      <SearchTab
                        searchQuery={ws().searchQuery}
                        searchResults={ws().searchResults}
                        searching={ws().searching}
                        repoRoot={ws().repoRoot}
                        onQueryChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, searchQuery: v }))}
                        onSearch={() => void performSearch(ws().id)}
                        onAddContext={(r) => addContextFromSearch(ws().id, r)}
                      />
                    </div>

                    <div
                      class="absolute inset-0"
                      style={{ display: ws().activeArea === "contextBuilder" ? "block" : "none" }}
                    >
                      <ContextBuilderTab
                        contextItems={ws().contextItems}
                        tokenEstimate={contextTokenEstimate()}
                        onRemoveItem={(id) => removeContextItem(ws().id, id)}
                        onAddFreetext={(label, content) => {
                          addContextItem(ws().id, contextItemFromText(label, content));
                        }}
                      />
                    </div>

                    <div
                      class="absolute inset-0"
                      style={{ display: ws().activeArea === "workflow" ? "block" : "none" }}
                    >
                      <WorkflowTab
                        objective={ws().objective}
                        constraintsText={ws().constraintsText}
                        contextItems={ws().contextItems}
                        contextTokenEstimate={contextTokenEstimate()}
                        workflow={ws().workflow}
                        runState={ws().runState}
                        generatingWorkflow={ws().generatingWorkflow}
                        runningWorkflow={ws().runningWorkflow}
                        onObjectiveChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, objective: v }))}
                        onConstraintsChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, constraintsText: v }))}
                        onGenerate={() => void workflowManager.generateWorkflow(ws().id)}
                        onRun={() => void workflowManager.runWorkflow(ws().id)}
                      />
                    </div>

                    {/* Stateful tabs: MountOnce keeps them alive after first render */}
                    <MountOnce when={ws().repoRoot}>
                      {(repoRoot) => (
                        <div
                          class="absolute inset-0 overflow-hidden"
                          style={{ display: ws().activeArea === "aiAgent" ? "block" : "none" }}
                        >
                          <AgentChatView repoPath={repoRoot()} />
                        </div>
                      )}
                    </MountOnce>

                    <MountOnce when={ws().repoRoot}>
                      {(repoRoot) => (
                        <div
                          class="absolute inset-0 overflow-hidden"
                          style={{ display: ws().activeArea === "terminal" ? "block" : "none" }}
                        >
                          <TerminalView cwd={repoRoot()} />
                        </div>
                      )}
                    </MountOnce>
                  </section>
                </>
              );
            }}
          </Show>
          <Show when={activeWorkspace()?.repoRoot}>
            {(repoRoot) => {
              const gitOpen = () => activeWorkspace()?.gitPanelOpen ?? false;
              const toggleGit = () => {
                const wsId = activeWorkspaceId();
                updateWorkspace(wsId, (ws) => ({ ...ws, gitPanelOpen: !ws.gitPanelOpen }));
              };
              return (
                <>
                  <BottomPanel
                    open={gitOpen()}
                    onToggle={toggleGit}
                    shortcutKey="g"
                  >
                    <GitTabContent
                      repoPath={repoRoot()}
                      onAddToContext={(filePath, content) => {
                        const item = contextItemFromDiff(filePath, content);
                        addContextItem(activeWorkspaceId(), item);
                      }}
                    />
                  </BottomPanel>
                  <GitStatusBar
                    repoPath={repoRoot()}
                    activeArea={activeWorkspace()?.activeArea}
                    gitPanelOpen={gitOpen()}
                    onToggleGit={toggleGit}
                  />
                </>
              );
            }}
          </Show>
          <ContextIndicator
            items={activeWorkspace()?.contextItems ?? []}
            tokenEstimate={contextTokenEstimate()}
            onRemoveItem={(id) => removeContextItem(activeWorkspaceId(), id)}
            onOpenContextTab={() => {
              updateWorkspace(activeWorkspaceId(), (ws) => ({ ...ws, activeArea: "contextBuilder" }));
            }}
          />
        </main>
      </div>

      <SettingsPanel open={settingsOpen()} onOpenChange={setSettingsOpen} />
    </div>
  );
}

export default App;
