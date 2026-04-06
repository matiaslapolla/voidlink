import type {
  RunState,
  ScanProgress,
  SearchResult,
  WorkflowDsl,
} from "@/types/migration";
import type { ContextItem } from "@/types/context";

export type WorkArea = "repository" | "contextBuilder" | "workflow" | "aiAgent" | "cliAgents" | "terminal";

export interface WorkspaceState {
  id: string;
  name: string;
  repoRoot: string | null;
  activeArea: WorkArea;
  lastScanJobId: string | null;
  scanStatus: ScanProgress | null;
  searchQuery: string;
  searchResults: SearchResult[];
  /** Context items assembled from any source (search, diffs, freetext) */
  contextItems: ContextItem[];
  /** Workflow-specific: objective text */
  objective: string;
  /** Workflow-specific: constraints (one per line) */
  constraintsText: string;
  workflow: WorkflowDsl | null;
  activeRunId: string | null;
  runState: RunState | null;
  searching: boolean;
  generatingWorkflow: boolean;
  runningWorkflow: boolean;
  gitPanelOpen: boolean;
  lastError: string | null;
}

export interface PersistedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
  activeArea: WorkArea;
  objective: string;
  constraintsText: string;
  gitPanelOpen?: boolean;
}

export function createWorkspace(name: string): WorkspaceState {
  return {
    id: crypto.randomUUID(),
    name,
    repoRoot: null,
    activeArea: "repository",
    lastScanJobId: null,
    scanStatus: null,
    searchQuery: "",
    searchResults: [],
    contextItems: [],
    objective: "",
    constraintsText: "",
    workflow: null,
    activeRunId: null,
    runState: null,
    searching: false,
    generatingWorkflow: false,
    runningWorkflow: false,
    gitPanelOpen: false,
    lastError: null,
  };
}
