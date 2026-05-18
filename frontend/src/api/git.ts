import { invoke } from "@tauri-apps/api/core";
import type {
  BlameLine,
  ConflictVersions,
  DiffResult,
  FileDiff,
  GitBranchInfo,
  GitCommitInfo,
  GitFileStatus,
  GitRepoInfo,
  RefList,
  SafeCheckoutResult,
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

  diffRefs(
    repoPath: string,
    baseRef: string,
    headRef: string,
    useMergeBase?: boolean,
  ): Promise<DiffResult> {
    return invoke<DiffResult>("git_diff_refs", {
      repoPath,
      baseRef,
      headRef,
      useMergeBase: useMergeBase ?? true,
    });
  },

  listRefs(repoPath: string): Promise<RefList> {
    return invoke<RefList>("git_list_refs", { repoPath });
  },

  lsFiles(repoPath: string): Promise<string[]> {
    return invoke<string[]>("git_ls_files", { repoPath });
  },

  safeCheckout(
    repoPath: string,
    branch: string,
    create?: boolean,
  ): Promise<SafeCheckoutResult> {
    return invoke<SafeCheckoutResult>("git_safe_checkout", {
      repoPath,
      branch,
      create,
    });
  },

  applyHunk(
    repoPath: string,
    file: FileDiff,
    hunkIndex: number,
    reverse?: boolean,
  ): Promise<void> {
    return invoke<void>("git_apply_hunk", {
      repoPath,
      file,
      hunkIndex,
      reverse: reverse ?? false,
    });
  },

  aiGenerateCommit(repoPath: string, commandTemplate: string): Promise<string> {
    return invoke<string>("git_ai_generate_commit", {
      repoPath,
      commandTemplate,
    });
  },

  blameFile(repoPath: string, filePath: string): Promise<BlameLine[]> {
    return invoke<BlameLine[]>("git_blame_file", { repoPath, filePath });
  },

  listConflicts(repoPath: string): Promise<string[]> {
    return invoke<string[]>("git_list_conflicts", { repoPath });
  },

  conflictVersions(repoPath: string, filePath: string): Promise<ConflictVersions> {
    return invoke<ConflictVersions>("git_conflict_versions", { repoPath, filePath });
  },

  resolveConflict(repoPath: string, filePath: string, content: string): Promise<void> {
    return invoke<void>("git_resolve_conflict", { repoPath, filePath, content });
  },
};
