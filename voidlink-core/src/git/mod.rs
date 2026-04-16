pub mod blame;
pub mod branch;
pub mod diff;
pub mod push;
pub mod repo;
pub mod staging;
pub mod status;
pub mod worktree;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub use blame::{git_blame_file_impl, git_diff_file_lines_impl};
pub use branch::{git_checkout_branch_impl, git_list_branches_impl};
pub use diff::{git_diff_branches_impl, git_diff_commit_impl, git_diff_working_impl, git_explain_diff_impl};
pub use push::git_push_impl;
pub use repo::git_repo_info_impl;
pub use staging::{git_commit_impl, git_stage_all_impl, git_stage_files_impl, git_unstage_files_impl};
pub use status::{git_file_status_impl, git_log_impl};
pub use worktree::{git_create_worktree_impl, git_list_worktrees_impl, git_remove_worktree_impl, git_worktree_status_impl};

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitState {
    pub repo_path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            repo_path_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─── Types ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_path: String,
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_detached: bool,
    pub is_clean: bool,
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_summary: Option<String>,
    pub last_commit_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    pub parent_oids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub is_locked: bool,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeInput {
    pub repo_path: String,
    pub branch_name: String,
    pub base_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub origin: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub status: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffExplanation {
    pub file_path: String,
    pub summary: String,
    pub risk_level: String,
    pub suggestions: Vec<String>,
}
