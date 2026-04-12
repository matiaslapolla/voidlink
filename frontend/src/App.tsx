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

import { Sun, Moon } from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { GitTabContent } from "@/components/git/GitTabContent";
import { AppShell } from "@/components/layout/AppShell";
import { BottomBar } from "@/components/layout/BottomBar";
import { BottomPane } from "@/components/layout/BottomPane";
import { CenterColumn } from "@/components/layout/CenterColumn";
import { LeftSidebar } from "@/components/layout/LeftSidebar";
import { RightSidebar } from "@/components/layout/RightSidebar";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { TerminalView } from "@/components/terminal/TerminalView";
import { createScanPolling } from "@/hooks/useScanPolling";
import { createWorkflowManager } from "@/hooks/useWorkflowManager";
import { createLayoutStore } from "@/store/layout";
import { LayoutContext } from "@/store/LayoutContext";
import type { SearchResult } from "@/types/migration";
import type { WorkspaceState, PersistedWorkspace } from "@/types/workspace";
import { createWorkspace } from "@/types/workspace";
import type { ContextItem } from "@/types/context";
import { contextItemFromSearch, contextItemFromText, contextItemFromDiff } from "@/types/context";
import type { CenterTabType } from "@/store/layout";
import { useTheme } from "@/store/theme";

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

  const [layoutStore, layoutActions] = createLayoutStore();

  // Seed layout store with existing workspace tabs
  for (const ws of initial.workspaces) {
    layoutActions.initWorkspaceTabs(ws.id, ws.activeArea as any);
  }

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

  // ─── Render helpers ──────────────────────────────────────────────────────────

  const cycleLayout = () => {
    const orders: [string, string, string][] = [
      ["left", "center", "right"],
      ["right", "center", "left"],
    ];
    const current = layoutStore.columnOrder.join(",");
    const idx = orders.findIndex((o) => o.join(",") === current);
    const next = orders[(idx + 1) % orders.length] as ["left" | "center" | "right", "left" | "center" | "right", "left" | "center" | "right"];
    layoutActions.setColumnOrder(next);
  };

  const { mode, toggleTheme } = useTheme();

  const statusText = createMemo(() => {
    const ws = activeWorkspace();
    if (!ws) return "No workspace";
    const parts: string[] = [];
    if (ws.repoRoot) {
      const name = ws.repoRoot.split("/").pop() ?? ws.repoRoot;
      parts.push(name);
    }
    if (ws.scanStatus?.status === "scanning") parts.push("Scanning...");
    if (ws.runningWorkflow) parts.push("Workflow running");
    return parts.join(" \u00b7 ") || "No repository selected";
  });

  // ─── Render ─────────────────────────────────────────────────────────────────
  //
  // All layout components that call useLayout() MUST be created inside the
  // LayoutContext.Provider tree.  In SolidJS, component functions execute
  // immediately when their JSX is evaluated, so pre-creating them as variables
  // above the Provider would call useLayout() before the context exists.

  return (
    <LayoutContext.Provider value={[layoutStore, layoutActions]}>
      <AppShell
        titleBar={
          <div class="flex items-center h-8 shrink-0 border-b border-border bg-background/70 select-none">
            <div data-tauri-drag-region class="flex-1 flex items-center px-3 h-full">
              <span class="text-xs font-bold tracking-wider text-primary/80">Voidlink</span>
            </div>
            <div class="flex items-center h-full text-muted-foreground">
              <button
                onClick={toggleTheme}
                class="w-10 h-full flex items-center justify-center hover:bg-accent/60 transition-colors"
                title={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              >
                <Show when={mode() === "dark"} fallback={<Moon class="w-3.5 h-3.5" />}>
                  <Sun class="w-3.5 h-3.5" />
                </Show>
              </button>
              <button
                onClick={cycleLayout}
                class="w-10 h-full flex items-center justify-center hover:bg-accent/60 transition-colors text-xs"
                title="Swap layout"
              >
                &#x21C4;
              </button>
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
        }
        leftSidebar={
          <LeftSidebar
            workspaces={workspaces()}
            activeWorkspaceId={activeWorkspaceId()}
            onSelectWorkspace={setActiveWorkspaceId}
            onAddWorkspace={addWorkspace}
            onRemoveWorkspace={removeWorkspace}
            onRenameWorkspace={(id, name) => updateWorkspace(id, (ws) => ({ ...ws, name }))}
            onSettingsOpen={() => setSettingsOpen(true)}
            repoRoot={activeWorkspace()?.repoRoot ?? null}
          />
        }
        centerColumn={
          <main class="flex-1 flex flex-col overflow-hidden">
            <Show when={activeWorkspace()}>
              {(wsAccessor) => {
                const ws = () => wsAccessor();

                return (
                  <CenterColumn
                    workspace={ws()}
                    contextTokenEstimate={contextTokenEstimate()}
                    onSearch={() => void performSearch(ws().id)}
                    onQueryChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, searchQuery: v }))}
                    onAddContext={(r) => addContextFromSearch(ws().id, r)}
                    onRemoveContext={(id) => removeContextItem(ws().id, id)}
                    onAddFreetext={(label, content) => {
                      addContextItem(ws().id, contextItemFromText(label, content));
                    }}
                    onObjectiveChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, objective: v }))}
                    onConstraintsChange={(v) => updateWorkspace(ws().id, (c) => ({ ...c, constraintsText: v }))}
                    onGenerate={() => void workflowManager.generateWorkflow(ws().id)}
                    onRun={() => void workflowManager.runWorkflow(ws().id)}
                    onChooseRepo={() => void chooseRepository(ws().id)}
                    onScan={(full) => void scanPolling.startScan(ws().id, full)}
                  />
                );
              }}
            </Show>
          </main>
        }
        rightSidebar={
          <RightSidebar
            workspace={activeWorkspace()}
            contextTokenEstimate={contextTokenEstimate()}
            onRemoveContextItem={(id) => removeContextItem(activeWorkspaceId(), id)}
            onOpenContextTab={() => layoutActions.openSingleton(activeWorkspaceId(), "contextBuilder")}
            repoPath={activeWorkspace()?.repoRoot ?? null}
          />
        }
        bottomPane={
          <BottomPane>
            {{
              terminal: (
                <Show
                  when={activeWorkspace()?.repoRoot}
                  fallback={
                    <div class="h-full flex items-center justify-center text-xs text-muted-foreground">
                      Select a repository to open terminal
                    </div>
                  }
                >
                  {(repoRoot) => <TerminalView cwd={repoRoot()} />}
                </Show>
              ),
              git: (
                <Show
                  when={activeWorkspace()?.repoRoot}
                  fallback={
                    <div class="h-full flex items-center justify-center text-xs text-muted-foreground">
                      Select a repository to view git info
                    </div>
                  }
                >
                  {(repoRoot) => (
                    <GitTabContent
                      repoPath={repoRoot()}
                      onAddToContext={(filePath, content) => {
                        const item = contextItemFromDiff(filePath, content);
                        addContextItem(activeWorkspaceId(), item);
                      }}
                    />
                  )}
                </Show>
              ),
              logs: (
                <div class="h-full flex items-center justify-center text-xs text-muted-foreground">
                  Logs — coming soon
                </div>
              ),
              agentOutput: (
                <div class="h-full flex items-center justify-center text-xs text-muted-foreground">
                  Agent output — coming soon
                </div>
              ),
            }}
          </BottomPane>
        }
        bottomBar={
          <BottomBar
            repoPath={activeWorkspace()?.repoRoot ?? null}
            statusText={statusText()}
          />
        }
      />
      <SettingsPanel open={settingsOpen()} onOpenChange={setSettingsOpen} />
    </LayoutContext.Provider>
  );
}

export default App;
