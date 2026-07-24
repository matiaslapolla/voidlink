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
  OpResult,
  PullResult,
  RefList,
  RemoteInfo,
  SafeCheckoutResult,
  StashEntry,
  WorktreeInfo,
} from "@/types/git";
import type { GraphCommit } from "@/types/history";

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

  commitGraph(repoPath: string, limit?: number): Promise<GraphCommit[]> {
    return invoke<GraphCommit[]>("git_commit_graph", { repoPath, limit });
  },

  checkoutBranch(repoPath: string, branch: string, create?: boolean): Promise<void> {
    return invoke<void>("git_checkout_branch", { repoPath, branch, create });
  },

  createBranch(repoPath: string, name: string, startPoint?: string): Promise<void> {
    return invoke<void>("git_create_branch", { repoPath, name, startPoint });
  },

  deleteBranch(repoPath: string, name: string, force?: boolean): Promise<void> {
    return invoke<void>("git_delete_branch", { repoPath, name, force: force ?? false });
  },

  renameBranch(repoPath: string, oldName: string, newName: string, force?: boolean): Promise<void> {
    return invoke<void>("git_rename_branch", { repoPath, oldName, newName, force: force ?? false });
  },

  createTag(repoPath: string, name: string, target?: string, message?: string): Promise<void> {
    return invoke<void>("git_create_tag", { repoPath, name, target, message });
  },

  deleteTag(repoPath: string, name: string): Promise<void> {
    return invoke<void>("git_delete_tag", { repoPath, name });
  },

  pushTag(repoPath: string, name: string, remote?: string): Promise<void> {
    return invoke<void>("git_push_tag", { repoPath, name, remote });
  },

  stashList(repoPath: string): Promise<StashEntry[]> {
    return invoke<StashEntry[]>("git_stash_list", { repoPath });
  },

  stashSave(
    repoPath: string,
    message?: string,
    keepIndex?: boolean,
    includeUntracked?: boolean,
  ): Promise<string> {
    return invoke<string>("git_stash_save", {
      repoPath,
      message,
      keepIndex: keepIndex ?? false,
      includeUntracked: includeUntracked ?? false,
    });
  },

  stashApply(repoPath: string, index: number): Promise<void> {
    return invoke<void>("git_stash_apply", { repoPath, index });
  },

  stashPop(repoPath: string, index: number): Promise<void> {
    return invoke<void>("git_stash_pop", { repoPath, index });
  },

  stashDrop(repoPath: string, index: number): Promise<void> {
    return invoke<void>("git_stash_drop", { repoPath, index });
  },

  stashShow(repoPath: string, index: number): Promise<DiffResult> {
    return invoke<DiffResult>("git_stash_show", { repoPath, index });
  },

  listRemotes(repoPath: string): Promise<RemoteInfo[]> {
    return invoke<RemoteInfo[]>("git_list_remotes", { repoPath });
  },

  addRemote(repoPath: string, name: string, url: string): Promise<void> {
    return invoke<void>("git_add_remote", { repoPath, name, url });
  },

  removeRemote(repoPath: string, name: string): Promise<void> {
    return invoke<void>("git_remove_remote", { repoPath, name });
  },

  renameRemote(repoPath: string, oldName: string, newName: string): Promise<void> {
    return invoke<void>("git_rename_remote", { repoPath, oldName, newName });
  },

  setRemoteUrl(repoPath: string, name: string, url: string): Promise<void> {
    return invoke<void>("git_set_remote_url", { repoPath, name, url });
  },

  merge(repoPath: string, branch: string, noFf?: boolean): Promise<OpResult> {
    return invoke<OpResult>("git_merge", { repoPath, branch, noFf: noFf ?? false });
  },

  mergeAbort(repoPath: string): Promise<void> {
    return invoke<void>("git_merge_abort", { repoPath });
  },

  rebase(repoPath: string, onto: string): Promise<OpResult> {
    return invoke<OpResult>("git_rebase", { repoPath, onto });
  },

  rebaseContinue(repoPath: string): Promise<OpResult> {
    return invoke<OpResult>("git_rebase_continue", { repoPath });
  },

  rebaseAbort(repoPath: string): Promise<void> {
    return invoke<void>("git_rebase_abort", { repoPath });
  },

  cherryPick(repoPath: string, oid: string): Promise<OpResult> {
    return invoke<OpResult>("git_cherry_pick", { repoPath, oid });
  },

  cherryPickContinue(repoPath: string): Promise<OpResult> {
    return invoke<OpResult>("git_cherry_pick_continue", { repoPath });
  },

  cherryPickAbort(repoPath: string): Promise<void> {
    return invoke<void>("git_cherry_pick_abort", { repoPath });
  },

  revert(repoPath: string, oid: string): Promise<OpResult> {
    return invoke<OpResult>("git_revert", { repoPath, oid });
  },

  revertContinue(repoPath: string): Promise<OpResult> {
    return invoke<OpResult>("git_revert_continue", { repoPath });
  },

  revertAbort(repoPath: string): Promise<void> {
    return invoke<void>("git_revert_abort", { repoPath });
  },

  amend(repoPath: string, message?: string): Promise<string> {
    return invoke<string>("git_amend", { repoPath, message });
  },

  undoLastCommit(repoPath: string): Promise<void> {
    return invoke<void>("git_undo_last_commit", { repoPath });
  },

  reset(repoPath: string, target: string, mode: "soft" | "mixed" | "hard"): Promise<void> {
    return invoke<void>("git_reset", { repoPath, target, mode });
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

  fetch(repoPath: string, remote?: string): Promise<void> {
    return invoke<void>("git_fetch", { repoPath, remote });
  },

  pull(repoPath: string, mode?: "ff-only" | "merge" | "rebase"): Promise<PullResult> {
    return invoke<PullResult>("git_pull", { repoPath, mode: mode ?? "ff-only" });
  },

  discardFile(repoPath: string, path: string): Promise<void> {
    return invoke<void>("git_discard_file", { repoPath, path });
  },

  discardAll(repoPath: string, includeUntracked?: boolean): Promise<void> {
    return invoke<void>("git_discard_all", {
      repoPath,
      includeUntracked: includeUntracked ?? false,
    });
  },

  discardHunk(repoPath: string, file: FileDiff, hunkIndex: number): Promise<void> {
    return invoke<void>("git_discard_hunk", { repoPath, file, hunkIndex });
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

  /// `secretBindings` is the non-secret id → env-var mapping of the provider
  /// keys the user configured. Rust resolves each id against the OS keychain
  /// at spawn time and exports the value into the child's environment; no
  /// value passes through JS in either direction.
  aiGenerateCommit(
    repoPath: string,
    commandTemplate: string,
    secretBindings: { id: string; envVar: string }[] = [],
  ): Promise<string> {
    return invoke<string>("git_ai_generate_commit", {
      repoPath,
      commandTemplate,
      secretBindings,
    });
  },

  agentQuery(
    repoPath: string,
    commandTemplate: string,
    prompt: string,
    secretBindings: { id: string; envVar: string }[] = [],
  ): Promise<string> {
    return invoke<string>("git_agent_query", {
      repoPath,
      commandTemplate,
      prompt,
      secretBindings,
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

  listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    return invoke<WorktreeInfo[]>("git_list_worktrees", { repoPath });
  },

  addWorktree(
    repoPath: string,
    path: string,
    branch?: string,
    newBranch?: boolean,
  ): Promise<WorktreeInfo> {
    return invoke<WorktreeInfo>("git_add_worktree", {
      repoPath,
      path,
      branch: branch ?? null,
      newBranch: newBranch ?? false,
    });
  },

  removeWorktree(repoPath: string, path: string, force?: boolean): Promise<void> {
    return invoke<void>("git_remove_worktree", { repoPath, path, force: force ?? false });
  },
};
