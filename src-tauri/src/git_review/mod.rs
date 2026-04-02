pub(crate) mod audit;
pub(crate) mod checklist;
pub(crate) mod db;
pub(crate) mod github;
pub(crate) mod merge;

use serde::{Deserialize, Serialize};

use audit::{get_audit_log_impl, get_pr_impl, list_prs_impl};
use checklist::{generate_review_checklist_impl, update_checklist_item_impl};
use merge::merge_pr_impl;

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestInfo {
    pub number: u32,
    pub title: String,
    pub body: String,
    pub state: String,
    pub draft: bool,
    pub base_branch: String,
    pub head_branch: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub mergeable: Option<bool>,
    pub ci_status: Option<String>,
    pub review_status: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChecklist {
    pub pr_number: u32,
    pub items: Vec<ChecklistItem>,
    pub overall_risk: String,
    pub ai_summary: String,
    pub generated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecklistItem {
    pub id: String,
    pub category: String,
    pub description: String,
    pub status: String,
    pub ai_note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInput {
    pub repo_path: String,
    pub pr_number: u32,
    pub method: String,
    pub delete_branch: bool,
    pub delete_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub id: String,
    pub pr_number: u32,
    pub action: String,
    pub actor: String,
    pub timestamp: i64,
    pub details: String,
    pub checklist_snapshot: Option<String>,
}

// ─── Tauri command wrappers ───────────────────────────────────────────────────

#[tauri::command]
pub fn git_list_prs(
    repo_path: String,
    state_filter: Option<String>,
) -> Result<Vec<PullRequestInfo>, String> {
    list_prs_impl(repo_path, state_filter)
}

#[tauri::command]
pub fn git_get_pr(repo_path: String, pr_number: u32) -> Result<PullRequestInfo, String> {
    get_pr_impl(repo_path, pr_number)
}

#[tauri::command]
pub fn git_generate_review_checklist(
    repo_path: String,
    pr_number: u32,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<ReviewChecklist, String> {
    generate_review_checklist_impl(repo_path, pr_number, &migration_state)
}

#[tauri::command]
pub fn git_update_checklist_item(
    repo_path: String,
    pr_number: u32,
    item_id: String,
    status: String,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<(), String> {
    update_checklist_item_impl(repo_path, pr_number, item_id, status, &migration_state)
}

#[tauri::command]
pub fn git_merge_pr(
    input: MergeInput,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<(), String> {
    merge_pr_impl(input, &migration_state)
}

#[tauri::command]
pub fn git_get_audit_log(
    repo_path: String,
    pr_number: Option<u32>,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<Vec<AuditEntry>, String> {
    get_audit_log_impl(repo_path, pr_number, &migration_state)
}
