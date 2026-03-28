import { invoke } from "@tauri-apps/api/core";
import type {
  GenerateWorkflowInput,
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
};
