import { invoke } from "@tauri-apps/api/core";
import type {
  DiffResult,
  GitBranchInfo,
  GitCommitInfo,
  GitFileStatus,
  GitRepoInfo,
} from "@/types/git";

export const gitApi = {
  repoInfo(repoPath: string): Promise<GitRepoInfo> {
    return invoke<GitRepoInfo>("git_repo_info", { repoPath });
  },

  listBranches(repoPath: string, includeRemote?: boolean): Promise<GitBranchInfo[]> {
    return invoke<GitBranchInfo[]>("git_list_branches", {
      repoPath,
      includeRemote: includeRemote ?? false,
    });
  },

  fileStatus(repoPath: string): Promise<GitFileStatus[]> {
    return invoke<GitFileStatus[]>("git_file_status", { repoPath });
  },

  log(repoPath: string, branch?: string, limit?: number): Promise<GitCommitInfo[]> {
    return invoke<GitCommitInfo[]>("git_log", { repoPath, branch, limit });
  },

  checkoutBranch(repoPath: string, branch: string, create?: boolean): Promise<void> {
    return invoke<void>("git_checkout_branch", { repoPath, branch, create });
  },

  stageFiles(repoPath: string, paths: string[]): Promise<void> {
    return invoke<void>("git_stage_files", { repoPath, paths });
  },

  unstageFiles(repoPath: string, paths: string[]): Promise<void> {
    return invoke<void>("git_unstage_files", { repoPath, paths });
  },

  stageAll(repoPath: string): Promise<void> {
    return invoke<void>("git_stage_all", { repoPath });
  },

  commit(repoPath: string, message: string): Promise<string> {
    return invoke<string>("git_commit", { repoPath, message });
  },

  push(repoPath: string, remote?: string, branch?: string): Promise<void> {
    return invoke<void>("git_push", { repoPath, remote, branch });
  },

  diffWorking(repoPath: string, stagedOnly?: boolean): Promise<DiffResult> {
    return invoke<DiffResult>("git_diff_working", { repoPath, stagedOnly });
  },
};
