pub mod audit;
pub mod checklist;
pub mod db;
pub mod github;
pub mod merge;

use serde::{Deserialize, Serialize};

pub use audit::{get_audit_log_impl, get_pr_impl, list_prs_impl};
pub use checklist::{generate_review_checklist_impl, update_checklist_item_impl};
pub use merge::merge_pr_impl;

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
