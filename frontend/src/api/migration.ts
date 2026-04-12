import { invoke } from "@tauri-apps/api/core";
import type {
  DataFlowAnalysisResult,
  EntityAnalysisResult,
  GenerateWorkflowInput,
  RepoGraph,
  RunState,
  RunWorkflowInput,
  ScanOptions,
  ScanProgress,
  SearchOptions,
  SearchQuery,
  SearchResult,
  WorkflowDsl,
} from "@/types/migration";

export const migrationApi = {
  scanRepository(repoPath: string, options?: ScanOptions): Promise<string> {
    return invoke<string>("scan_repository", { repoPath, options });
  },

  getScanStatus(scanJobId: string): Promise<ScanProgress> {
    return invoke<ScanProgress>("get_scan_status", { scanJobId });
  },

  searchRepository(query: SearchQuery, options?: SearchOptions): Promise<SearchResult[]> {
    return invoke<SearchResult[]>("search_repository", { query, options });
  },

  generateWorkflow(input: GenerateWorkflowInput): Promise<WorkflowDsl> {
    return invoke<WorkflowDsl>("generate_workflow", { input });
  },

  runWorkflow(input: RunWorkflowInput): Promise<string> {
    return invoke<string>("run_workflow", { input });
  },

  getRunStatus(runId: string): Promise<RunState> {
    return invoke<RunState>("get_run_status", { runId });
  },

  getStartupRepoPath(): Promise<string | null> {
    return invoke<string | null>("get_startup_repo_path");
  },

  getRepoGraph(repoPath: string): Promise<RepoGraph> {
    return invoke<RepoGraph>("get_repo_graph", { repoPath });
  },

  identifyEntities(repoPath: string): Promise<EntityAnalysisResult> {
    return invoke<EntityAnalysisResult>("identify_entities", { repoPath });
  },

  analyzeDataFlows(repoPath: string): Promise<DataFlowAnalysisResult> {
    return invoke<DataFlowAnalysisResult>("analyze_data_flows", { repoPath });
  },
};
