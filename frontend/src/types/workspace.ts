import type {
  RunState,
  ScanProgress,
  SearchResult,
  WorkflowDsl,
} from "@/types/migration";

export type WorkArea = "repository" | "contextBuilder" | "workflow" | "git" | "aiAgent" | "cliAgents" | "terminal";

export interface WorkspaceState {
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

export interface PersistedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
  activeArea: WorkArea;
  objective: string;
  constraintsText: string;
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
