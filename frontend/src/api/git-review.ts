import { invoke } from "@tauri-apps/api/core";
import type { AuditEntry, MergeInput, PullRequestInfo, ReviewChecklist } from "@/types/git";

export const gitReviewApi = {
  listPrs(repoPath: string, stateFilter?: string): Promise<PullRequestInfo[]> {
    return invoke<PullRequestInfo[]>("git_list_prs", { repoPath, stateFilter });
  },

  getPr(repoPath: string, prNumber: number): Promise<PullRequestInfo> {
    return invoke<PullRequestInfo>("git_get_pr", { repoPath, prNumber });
  },

  generateChecklist(repoPath: string, prNumber: number): Promise<ReviewChecklist> {
    return invoke<ReviewChecklist>("git_generate_review_checklist", { repoPath, prNumber });
  },

  updateChecklistItem(
    repoPath: string,
    prNumber: number,
    itemId: string,
    status: string,
  ): Promise<void> {
    return invoke<void>("git_update_checklist_item", { repoPath, prNumber, itemId, status });
  },

  mergePr(input: MergeInput): Promise<void> {
    return invoke<void>("git_merge_pr", { input });
  },

  getAuditLog(repoPath: string, prNumber?: number): Promise<AuditEntry[]> {
    return invoke<AuditEntry[]>("git_get_audit_log", { repoPath, prNumber });
  },
};
