import { migrationApi } from "@/api/migration";
import type { WorkspaceState } from "@/types/workspace";
import { isTerminalStatus } from "@/lib/statusUtils";

function parseConstraintLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface WorkflowManagerDeps {
  getWorkspaces: () => WorkspaceState[];
  updateWorkspace: (id: string, updater: (ws: WorkspaceState) => WorkspaceState) => void;
}

export function createWorkflowManager(deps: WorkflowManagerDeps) {
  const runTimers = new Map<string, number>();

  function clearRunTimer(workspaceId: string): void {
    const timer = runTimers.get(workspaceId);
    if (timer) {
      window.clearTimeout(timer);
      runTimers.delete(workspaceId);
    }
  }

  async function pollRunStatus(workspaceId: string, runId: string): Promise<void> {
    clearRunTimer(workspaceId);
    try {
      const runState = await migrationApi.getRunStatus(runId);
      deps.updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        runState,
        runningWorkflow: !isTerminalStatus(runState.status),
      }));
      if (!isTerminalStatus(runState.status)) {
        const timer = window.setTimeout(() => {
          void pollRunStatus(workspaceId, runId);
        }, 900);
        runTimers.set(workspaceId, timer);
      }
    } catch (error) {
      deps.updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        runningWorkflow: false,
        lastError: error instanceof Error ? error.message : "Failed to poll run status",
      }));
    }
  }

  async function generateWorkflow(workspaceId: string): Promise<void> {
    const ws = deps.getWorkspaces().find((item) => item.id === workspaceId);
    if (!ws) return;

    const objective = ws.objective.trim() || ws.searchQuery.trim();
    if (!objective) {
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        lastError: "Objective is required before generating a workflow.",
      }));
      return;
    }

    deps.updateWorkspace(workspaceId, (current) => ({
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
          selectedResults: ws.contextItems.map((item) => ({
            id: item.id,
            filePath: item.filePath ?? "",
            anchor: item.label,
            snippet: item.content,
            language: "",
            score: 0,
            lexicalScore: 0,
            semanticScore: 0,
            why: { matchedTerms: [], semanticScore: 0, graphProximity: null },
          })),
          maxTokens: 1200,
        },
      });
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        workflow: dsl,
        generatingWorkflow: false,
      }));
    } catch (error) {
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        generatingWorkflow: false,
        lastError: error instanceof Error ? error.message : "Workflow generation failed",
      }));
    }
  }

  async function runWorkflow(workspaceId: string): Promise<void> {
    const ws = deps.getWorkspaces().find((item) => item.id === workspaceId);
    if (!ws?.workflow) return;

    deps.updateWorkspace(workspaceId, (current) => ({
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
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        activeRunId: runId,
      }));
      await pollRunStatus(workspaceId, runId);
    } catch (error) {
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        runningWorkflow: false,
        lastError: error instanceof Error ? error.message : "Workflow execution failed",
      }));
    }
  }

  function cleanupTimers(): void {
    for (const timer of runTimers.values()) {
      window.clearTimeout(timer);
    }
  }

  return { generateWorkflow, runWorkflow, clearRunTimer, cleanupTimers };
}
