import { invoke } from "@tauri-apps/api/core";
import type { RestackResult, Stack, SubmitResult } from "@/types/stack";

export const stackApi = {
  /// Discover the stack rooted at HEAD's branch. Returns null when HEAD is
  /// detached, on a trunk, or on a branch with no parent recorded.
  current(repoPath: string): Promise<Stack | null> {
    return invoke<Stack | null>("git_stack_current", { repoPath });
  },

  /// Enumerate every stack discoverable in the repo (any branch with a
  /// recorded parent), deduplicated by leaf.
  list(repoPath: string): Promise<Stack[]> {
    return invoke<Stack[]>("git_stack_list", { repoPath });
  },

  /// Create `name` on top of `parent` and check it out. Refuses on duplicate.
  createBranch(repoPath: string, name: string, parent: string): Promise<void> {
    return invoke<void>("git_stack_create_branch", { repoPath, name, parent });
  },

  /// Retroactively record `branch` as a child of `parent` (no checkout).
  setParent(repoPath: string, branch: string, parent: string): Promise<void> {
    return invoke<void>("git_stack_set_parent", { repoPath, branch, parent });
  },

  /// Remove the voidlink-managed parent / parentbase / prnumber keys for
  /// `branch`. The branch itself is left intact.
  untrack(repoPath: string, branch: string): Promise<void> {
    return invoke<void>("git_stack_untrack", { repoPath, branch });
  },

  /// Replay `branch`'s unique commits onto its parent's current tip.
  /// Atomic per branch: on conflict, nothing is modified — the working tree
  /// stays put and the user can resolve in their terminal.
  restack(repoPath: string, branch: string): Promise<RestackResult> {
    return invoke<RestackResult>("git_stack_restack", { repoPath, branch });
  },

  /// Restack `branches` bottom-up (trunk-ward first). Stops at the first
  /// conflict and returns results-so-far.
  restackAll(repoPath: string, branches: string[]): Promise<RestackResult[]> {
    return invoke<RestackResult[]>("git_stack_restack_all", { repoPath, branches });
  },

  /// Create or update one PR per branch on GitHub. Requires `GITHUB_TOKEN`.
  /// Returns one result per branch even on partial failure.
  submit(repoPath: string, branches: string[]): Promise<SubmitResult[]> {
    return invoke<SubmitResult[]>("git_stack_submit", { repoPath, branches });
  },

  /// Read the per-repo trunk override list (`voidlink.stack.trunks`).
  /// Empty array means "unset"; discovery falls back to defaults + origin/HEAD.
  getTrunks(repoPath: string): Promise<string[]> {
    return invoke<string[]>("git_stack_get_trunks", { repoPath });
  },

  /// Replace the per-repo trunk override list. Empty array removes the key.
  setTrunks(repoPath: string, trunks: string[]): Promise<void> {
    return invoke<void>("git_stack_set_trunks", { repoPath, trunks });
  },
};
