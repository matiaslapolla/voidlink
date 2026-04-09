import { migrationApi } from "@/api/migration";
import type { WorkspaceState } from "@/types/workspace";
import { isTerminalStatus } from "@/lib/statusUtils";

interface ScanPollingDeps {
  getWorkspaces: () => WorkspaceState[];
  updateWorkspace: (id: string, updater: (ws: WorkspaceState) => WorkspaceState) => void;
}

export function createScanPolling(deps: ScanPollingDeps) {
  const scanTimers = new Map<string, number>();

  function clearScanTimer(workspaceId: string): void {
    const timer = scanTimers.get(workspaceId);
    if (timer) {
      window.clearTimeout(timer);
      scanTimers.delete(workspaceId);
    }
  }

  async function pollScanStatus(workspaceId: string, scanJobId: string): Promise<void> {
    clearScanTimer(workspaceId);
    try {
      const status = await migrationApi.getScanStatus(scanJobId);
      deps.updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        scanStatus: status,
      }));
      if (!isTerminalStatus(status.status)) {
        const timer = window.setTimeout(() => {
          void pollScanStatus(workspaceId, scanJobId);
        }, 800);
        scanTimers.set(workspaceId, timer);
      }
    } catch (error) {
      deps.updateWorkspace(workspaceId, (ws) => ({
        ...ws,
        lastError: error instanceof Error ? error.message : "Failed to poll scan status",
      }));
    }
  }

  async function startScan(workspaceId: string, forceFullRescan = false): Promise<void> {
    const ws = deps.getWorkspaces().find((item) => item.id === workspaceId);
    if (!ws?.repoRoot) return;

    try {
      const scanJobId = await migrationApi.scanRepository(ws.repoRoot, { forceFullRescan });
      deps.updateWorkspace(workspaceId, (current) => ({
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
      deps.updateWorkspace(workspaceId, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "Scan failed",
      }));
    }
  }

  function cleanupTimers(): void {
    for (const timer of scanTimers.values()) {
      window.clearTimeout(timer);
    }
  }

  return { startScan, clearScanTimer, cleanupTimers };
}
