import { invoke } from "@tauri-apps/api/core";
import type {
  CreateWorktreeInput,
  DiffExplanation,
  DiffResult,
  GitBranchInfo,
  GitCommitInfo,
  GitFileStatus,
  GitRepoInfo,
  WorktreeInfo,
} from "@/types/git";

export const gitApi = {
  // Phase 1
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

  stageAll(repoPath: string): Promise<void> {
    return invoke<void>("git_stage_all", { repoPath });
  },

  commit(repoPath: string, message: string): Promise<string> {
    return invoke<string>("git_commit", { repoPath, message });
  },

  push(repoPath: string, remote?: string, branch?: string): Promise<void> {
    return invoke<void>("git_push", { repoPath, remote, branch });
  },

  // Phase 2
  createWorktree(input: CreateWorktreeInput): Promise<WorktreeInfo> {
    return invoke<WorktreeInfo>("git_create_worktree", { input });
  },

  listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    return invoke<WorktreeInfo[]>("git_list_worktrees", { repoPath });
  },

  removeWorktree(repoPath: string, name: string, force?: boolean): Promise<void> {
    return invoke<void>("git_remove_worktree", { repoPath, name, force });
  },

  worktreeStatus(repoPath: string, name: string): Promise<GitFileStatus[]> {
    return invoke<GitFileStatus[]>("git_worktree_status", { repoPath, name });
  },

  // Phase 3
  diffWorking(repoPath: string, stagedOnly?: boolean): Promise<DiffResult> {
    return invoke<DiffResult>("git_diff_working", { repoPath, stagedOnly });
  },

  diffBranches(repoPath: string, base: string, head: string): Promise<DiffResult> {
    return invoke<DiffResult>("git_diff_branches", { repoPath, base, head });
  },

  diffCommit(repoPath: string, oid: string): Promise<DiffResult> {
    return invoke<DiffResult>("git_diff_commit", { repoPath, oid });
  },

  explainDiff(repoPath: string, base: string, head: string): Promise<DiffExplanation[]> {
    return invoke<DiffExplanation[]>("git_explain_diff", { repoPath, base, head });
  },
};
