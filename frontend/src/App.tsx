import {
  For,
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
  FilePlus2,
  FolderOpen,
  GitBranch,
  Play,
  RefreshCcw,
  Search,
  Settings,
  Trash2,
  Workflow,
} from "lucide-solid";
import { migrationApi } from "@/api/migration";
import { GitStatusBar } from "@/components/git/GitStatusBar";
import { GitTabContent } from "@/components/git/GitTabContent";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import type {
  RunState,
  ScanProgress,
  SearchResult,
  WorkflowDsl,
} from "@/types/migration";

type WorkArea = "repository" | "contextBuilder" | "workflow" | "git";

interface WorkspaceState {
  id: string;
  name: string;
  repoRoot: string | null;
  activeArea: WorkArea;
  lastScanJobId: string | null;
  scanStatus: ScanProgress | null;
  searchQuery: string;
  searchResults: SearchResult[];
  selectedContext: SearchResult[];
  objective: string;
  constraintsText: string;
  workflow: WorkflowDsl | null;
  activeRunId: string | null;
  runState: RunState | null;
  searching: boolean;
  generatingWorkflow: boolean;
  runningWorkflow: boolean;
  lastError: string | null;
}

interface PersistedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
  activeArea: WorkArea;
  objective: string;
  constraintsText: string;
}

interface AppState {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
}

const STORAGE_KEY = "voidlink-repo-workspaces";
const ACTIVE_STORAGE_KEY = "voidlink-active-repo-workspace";
const MIGRATION_MARKER_KEY = "voidlink-migration-v1-done";

function createWorkspace(name: string): WorkspaceState {
  return {
    id: crypto.randomUUID(),
    name,
    repoRoot: null,
    activeArea: "repository",
    lastScanJobId: null,
    scanStatus: null,
    searchQuery: "",
    searchResults: [],
    selectedContext: [],
    objective: "",
    constraintsText: "",
    workflow: null,
    activeRunId: null,
    runState: null,
    searching: false,
    generatingWorkflow: false,
    runningWorkflow: false,
    lastError: null,
  };
}

function clearLegacyStorage(): void {
  localStorage.removeItem("voidlink-workspaces");
  localStorage.removeItem("voidlink-active-workspace");
  localStorage.removeItem("voidlink-pages");

  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith("voidlink-pages-") || key.startsWith("voidlink-content-")) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

function ensureMigrationCleanup(): void {
  if (localStorage.getItem(MIGRATION_MARKER_KEY)) return;
  clearLegacyStorage();
  localStorage.setItem(MIGRATION_MARKER_KEY, "true");
}

function loadInitialState(): AppState {
  ensureMigrationCleanup();

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

function parseConstraintLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

function isRunTerminal(status: string): boolean {
  return status === "success" || status === "failed";
}

function isScanTerminal(status: string): boolean {
  return status === "success" || status === "failed";
}

function App() {
  const initial = loadInitialState();
  const [workspaces, setWorkspaces] = createSignal<WorkspaceState[]>(initial.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string>(initial.activeWorkspaceId);
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  const scanTimers = new Map<string, number>();
  const runTimers = new Map<string, number>();

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

  function addContextResult(workspaceId: string, result: SearchResult) {
    updateWorkspace(workspaceId, (ws) => {
      if (ws.selectedContext.some((item) => item.id === result.id)) {
        return ws;
      }
      return {
        ...ws,
        selectedContext: [...ws.selectedContext, result],
      };
    });
  }

  function removeContextResult(workspaceId: string, resultId: string) {
    updateWorkspace(workspaceId, (ws) => ({
      ...ws,
      selectedContext: ws.selectedContext.filter((item) => item.id !== resultId),
    }));
  }

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

  function clearScanTimer(workspaceId: string): void {
    const timer = scanTimers.get(workspaceId);
    if (timer) {
      window.clearTimeout(timer);
      scanTimers.delete(workspaceId);
    }
  }

  function clearRunTimer(workspaceId: string): void {
    const timer = runTimers.get(workspaceId);
    if (timer) {
      window.clearTimeout(timer);
      runTimers.delete(workspaceId);
    }
  }

  async function pollScanStatus(workspaceId: string, scanJobId: string): Promise<void> {
    clearScanTimer(workspaceId);
    try {
      const status = await migrationApi.getScanStatus(scanJobId);
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        scanStatus: status,
      }));
      if (!isScanTerminal(status.status)) {
        const timer = window.setTimeout(() => {
          void pollScanStatus(workspaceId, scanJobId);
        }, 800);
        scanTimers.set(workspaceId, timer);
      }
    } catch (error) {
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        lastError: error instanceof Error ? error.message : "Failed to poll scan status",
      }));
    }
  }

  async function startScan(workspaceId: string, forceFullRescan = false): Promise<void> {
    const ws = workspaces().find((item) => item.id === workspaceId);
    if (!ws?.repoRoot) return;

    try {
      const scanJobId = await migrationApi.scanRepository(ws.repoRoot, { forceFullRescan });
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        lastScanJobId: scanJobId,
        scanStatus: {
          scanJobId,
          repoPath: current.repoRoot ?? "",
          status: "pending",
          scannedFiles: 0,
          indexedFiles: 0,
          indexedChunks: 0,
          startedAt: Date.now(),
          finishedAt: null,
          error: null,
        },
        lastError: null,
      }));
      await pollScanStatus(workspaceId, scanJobId);
    } catch (error) {
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "Scan failed",
      }));
    }
  }

  async function performSearch(workspaceId: string): Promise<void> {
    const ws = workspaces().find((item) => item.id === workspaceId);
    if (!ws?.repoRoot || ws.searchQuery.trim().length === 0) return;

    updateWorkspace(workspaceId, (current) => ({ ...current, searching: true, lastError: null }));
    try {
      const results = await migrationApi.searchRepository(
        {
          repoPath: ws.repoRoot,
          text: ws.searchQuery.trim(),
          maxTokens: 120,
          type: "hybrid",
        },
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

  async function generateWorkflowForWorkspace(workspaceId: string): Promise<void> {
    const ws = workspaces().find((item) => item.id === workspaceId);
    if (!ws) return;

    const objective = ws.objective.trim() || ws.searchQuery.trim();
    if (!objective) {
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        lastError: "Objective is required before generating a workflow.",
      }));
      return;
    }

    updateWorkspace(workspaceId, (current) => ({
      ...current,
      generatingWorkflow: true,
      lastError: null,
    }));

    try {
      const dsl = await migrationApi.generateWorkflow({
        repoPath: ws.repoRoot ?? undefined,
        objective,
        constraints: parseConstraintLines(ws.constraintsText),
        contextBundle: {
          freeText: ws.objective,
          selectedResults: ws.selectedContext,
          maxTokens: 1200,
        },
      });
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        workflow: dsl,
        generatingWorkflow: false,
      }));
    } catch (error) {
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        generatingWorkflow: false,
        lastError: error instanceof Error ? error.message : "Workflow generation failed",
      }));
    }
  }

  async function pollRunStatus(workspaceId: string, runId: string): Promise<void> {
    clearRunTimer(workspaceId);
    try {
      const runState = await migrationApi.getRunStatus(runId);
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        runState,
        runningWorkflow: !isRunTerminal(runState.status),
      }));
      if (!isRunTerminal(runState.status)) {
        const timer = window.setTimeout(() => {
          void pollRunStatus(workspaceId, runId);
        }, 900);
        runTimers.set(workspaceId, timer);
      }
    } catch (error) {
      updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        runningWorkflow: false,
        lastError: error instanceof Error ? error.message : "Failed to poll run status",
      }));
    }
  }

  async function runWorkflowForWorkspace(workspaceId: string): Promise<void> {
    const ws = workspaces().find((item) => item.id === workspaceId);
    if (!ws?.workflow) return;

    updateWorkspace(workspaceId, (current) => ({
      ...current,
      runningWorkflow: true,
      runState: null,
      activeRunId: null,
      lastError: null,
    }));

    try {
      const runId = await migrationApi.runWorkflow({
        dsl: ws.workflow,
        repoPath: ws.repoRoot ?? undefined,
      });
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        activeRunId: runId,
      }));
      await pollRunStatus(workspaceId, runId);
    } catch (error) {
      updateWorkspace(workspaceId, (current) => ({
        ...current,
        runningWorkflow: false,
        lastError: error instanceof Error ? error.message : "Workflow execution failed",
      }));
    }
  }

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
    const opacity = localStorage.getItem("voidlink-opacity") ?? "0.85";
    document.documentElement.style.setProperty("--bg-opacity", opacity);

    const vibrancy = localStorage.getItem("voidlink-vibrancy") ?? "hudWindow";
    const win = getCurrentWindow();
    if (vibrancy === "off") {
      win.clearEffects().catch(() => {});
    } else {
      win.setEffects({ effects: [vibrancy as never], state: "active" as never }).catch(() => {});
    }

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
    for (const timer of scanTimers.values()) {
      window.clearTimeout(timer);
    }
    for (const timer of runTimers.values()) {
      window.clearTimeout(timer);
    }
  });

  return (
    <div class="relative flex flex-col h-screen bg-background text-foreground overflow-hidden">
      <div data-tauri-drag-region class="absolute top-0 left-0 right-0 h-3 z-50" />
      <div class="flex flex-1 overflow-hidden">
        <aside class="w-64 border-r border-border bg-sidebar flex flex-col">
          <div class="px-3 py-3 border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            Workspaces
          </div>

          <div class="flex-1 overflow-y-auto p-2 space-y-1">
            <For each={workspaces()}>
              {(ws) => (
                <div
                  class={`group rounded-md border px-2 py-2 text-sm transition-colors ${
                    ws.id === activeWorkspaceId()
                      ? "border-primary/50 bg-sidebar-accent"
                      : "border-transparent hover:bg-sidebar-accent/50"
                  }`}
                >
                  <button
                    class="w-full text-left"
                    onClick={() => setActiveWorkspaceId(ws.id)}
                    title={ws.name}
                  >
                    <div class="truncate font-medium">{ws.name}</div>
                    <div class="truncate text-xs text-muted-foreground">
                      {ws.repoRoot ?? "No repository selected"}
                    </div>
                  </button>

                  <div class="mt-2 flex items-center justify-between gap-1">
                    <input
                      value={ws.name}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        updateWorkspace(ws.id, (current) => ({ ...current, name: value || "Workspace" }));
                      }}
                      class="w-full rounded bg-accent/60 px-1.5 py-1 text-xs outline-none"
                      aria-label={`Rename ${ws.name}`}
                    />
                    <button
                      onClick={() => removeWorkspace(ws.id)}
                      class="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete workspace"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>

          <div class="border-t border-border p-2 space-y-2">
            <button
              onClick={addWorkspace}
              class="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/60"
            >
              <FilePlus2 class="w-4 h-4" />
              New Workspace
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              class="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/60"
            >
              <Settings class="w-4 h-4" />
              Settings
            </button>
          </div>
        </aside>

        <main class="flex-1 flex flex-col overflow-hidden">
          <Show when={activeWorkspace()}>
            {(wsAccessor) => {
              const ws = () => wsAccessor();

              return (
                <>
                  <header class="border-b border-border p-3 space-y-3 bg-background/80">
                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => void chooseRepository(ws().id)}
                        class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/60"
                      >
                        <FolderOpen class="w-4 h-4" />
                        Choose Repository
                      </button>

                      <button
                        onClick={() => void startScan(ws().id, false)}
                        disabled={!ws().repoRoot}
                        class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-accent/60"
                      >
                        <RefreshCcw class="w-4 h-4" />
                        Scan
                      </button>

                      <button
                        onClick={() => void startScan(ws().id, true)}
                        disabled={!ws().repoRoot}
                        class="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-accent/60"
                      >
                        Full Rescan
                      </button>

                      <div class="text-xs text-muted-foreground">
                        {ws().repoRoot ?? "Select a repository to begin"}
                      </div>
                    </div>

                    <Show when={ws().scanStatus}>
                      {(status) => (
                        <div class="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                          <span>scan: {status().status}</span>
                          <span>scanned: {status().scannedFiles}</span>
                          <span>indexed files: {status().indexedFiles}</span>
                          <span>indexed chunks: {status().indexedChunks}</span>
                          <span>finished: {formatTimestamp(status().finishedAt)}</span>
                        </div>
                      )}
                    </Show>

                    <Show when={ws().lastError}>
                      {(error) => (
                        <div class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                          {error()}
                        </div>
                      )}
                    </Show>
                  </header>

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

                  <section class="flex-1 overflow-auto p-4">
                    <Show when={ws().activeArea === "repository"}>
                      <div class="space-y-4">
                        <div class="flex gap-2">
                          <input
                            value={ws().searchQuery}
                            onInput={(event) =>
                              updateWorkspace(ws().id, (current) => ({
                                ...current,
                                searchQuery: event.currentTarget.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void performSearch(ws().id);
                              }
                            }}
                            placeholder="Search files and snippets..."
                            class="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                          />
                          <button
                            onClick={() => void performSearch(ws().id)}
                            disabled={!ws().repoRoot || ws().searching || ws().searchQuery.trim().length === 0}
                            class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
                          >
                            <Search class="inline w-4 h-4 mr-1" />
                            {ws().searching ? "Searching..." : "Search"}
                          </button>
                        </div>

                        <Show when={ws().searchResults.length > 0} fallback={<p class="text-sm text-muted-foreground">No results yet.</p>}>
                          <div class="space-y-2">
                            <For each={ws().searchResults}>
                              {(result) => (
                                <article class="rounded-md border border-border bg-card/60 p-3 space-y-2">
                                  <div class="flex items-start justify-between gap-3">
                                    <div>
                                      <div class="font-medium text-sm">{result.filePath}</div>
                                      <div class="text-xs text-muted-foreground">{result.anchor}</div>
                                    </div>
                                    <button
                                      onClick={() => addContextResult(ws().id, result)}
                                      class="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
                                    >
                                      Add to Context
                                    </button>
                                  </div>
                                  <pre class="text-xs whitespace-pre-wrap text-muted-foreground bg-background/40 rounded p-2 overflow-auto">
                                    {result.snippet}
                                  </pre>
                                  <div class="text-xs text-muted-foreground">
                                    lexical {result.lexicalScore.toFixed(2)} | semantic {result.semanticScore.toFixed(2)} | graph {(result.why.graphProximity ?? 0).toFixed(2)}
                                  </div>
                                </article>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={ws().activeArea === "contextBuilder"}>
                      <div class="space-y-4">
                        <div>
                          <label class="block text-sm font-medium mb-1">Objective</label>
                          <textarea
                            value={ws().objective}
                            onInput={(event) =>
                              updateWorkspace(ws().id, (current) => ({
                                ...current,
                                objective: event.currentTarget.value,
                              }))
                            }
                            rows={4}
                            placeholder="Describe the migration objective..."
                            class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                          />
                        </div>

                        <div>
                          <label class="block text-sm font-medium mb-1">Constraints (one per line)</label>
                          <textarea
                            value={ws().constraintsText}
                            onInput={(event) =>
                              updateWorkspace(ws().id, (current) => ({
                                ...current,
                                constraintsText: event.currentTarget.value,
                              }))
                            }
                            rows={4}
                            placeholder="No destructive edits in v1\nPreserve existing behavior"
                            class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none"
                          />
                        </div>

                        <div class="text-xs text-muted-foreground">
                          Selected context items: {ws().selectedContext.length} | Estimated tokens: {selectedContextTokenEstimate()}
                        </div>

                        <Show when={ws().selectedContext.length > 0} fallback={<p class="text-sm text-muted-foreground">Add repository results to build context.</p>}>
                          <div class="space-y-2">
                            <For each={ws().selectedContext}>
                              {(item) => (
                                <div class="rounded-md border border-border p-2">
                                  <div class="flex items-center justify-between gap-2">
                                    <div class="text-sm font-medium truncate">{item.anchor}</div>
                                    <button
                                      onClick={() => removeContextResult(ws().id, item.id)}
                                      class="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/60"
                                    >
                                      Remove
                                    </button>
                                  </div>
                                  <p class="text-xs text-muted-foreground mt-1 line-clamp-3">{item.snippet}</p>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    <Show when={ws().activeArea === "git"}>
                      <Show when={ws().repoRoot} fallback={<p class="text-sm text-muted-foreground">Select a repository to use Git features.</p>}>
                        {(repoRoot) => (
                          <div class="h-full -m-4">
                            <GitTabContent
                              repoPath={repoRoot()}
                            />
                          </div>
                        )}
                      </Show>
                    </Show>

                    <Show when={ws().activeArea === "workflow"}>
                      <div class="space-y-4">
                        <div class="flex flex-wrap gap-2">
                          <button
                            onClick={() => void generateWorkflowForWorkspace(ws().id)}
                            disabled={ws().generatingWorkflow}
                            class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
                          >
                            {ws().generatingWorkflow ? "Generating..." : "Generate Workflow"}
                          </button>
                          <button
                            onClick={() => void runWorkflowForWorkspace(ws().id)}
                            disabled={!ws().workflow || ws().runningWorkflow}
                            class="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50 hover:bg-accent/60"
                          >
                            <Play class="inline w-4 h-4 mr-1" />
                            {ws().runningWorkflow ? "Running..." : "Run Workflow"}
                          </button>
                        </div>

                        <Show when={ws().workflow} fallback={<p class="text-sm text-muted-foreground">Generate a workflow to preview steps.</p>}>
                          {(dsl) => (
                            <div class="rounded-md border border-border p-3 space-y-3">
                              <div>
                                <h3 class="text-sm font-semibold">{dsl().workflow.objective}</h3>
                                <p class="text-xs text-muted-foreground">Workflow ID: {dsl().workflow.id}</p>
                              </div>

                              <div class="space-y-2">
                                <For each={dsl().steps}>
                                  {(step) => (
                                    <div class="rounded border border-border/70 p-2">
                                      <div class="text-sm font-medium">{step.id}</div>
                                      <div class="text-xs text-muted-foreground">{step.intent}</div>
                                      <div class="text-xs text-muted-foreground mt-1">
                                        tools: {step.tools.join(", ")}
                                      </div>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </Show>

                        <Show when={ws().runState}>
                          {(runState) => (
                            <div class="rounded-md border border-border p-3 space-y-3">
                              <div class="text-sm font-medium">
                                Run {runState().runId} - {runState().status}
                              </div>

                              <div class="space-y-1">
                                <For each={runState().steps}>
                                  {(step) => (
                                    <div class="text-xs text-muted-foreground">
                                      {step.stepId}: {step.status} (attempts: {step.attempts})
                                    </div>
                                  )}
                                </For>
                              </div>

                              <div class="max-h-44 overflow-auto rounded border border-border/60 p-2 space-y-1 bg-background/40">
                                <For each={runState().events}>
                                  {(event) => (
                                    <div class="text-xs">
                                      <span class="text-muted-foreground">[{formatTimestamp(event.createdAt)}]</span>{" "}
                                      <span class={event.level === "error" ? "text-destructive" : "text-foreground"}>
                                        {event.message}
                                      </span>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                  </section>
                </>
              );
            }}
          </Show>
          {/* Git status bar — shown at the bottom when a repo is open */}
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
