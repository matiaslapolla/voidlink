pub(crate) mod branch;
pub(crate) mod diff;
pub(crate) mod push;
pub(crate) mod repo;
pub(crate) mod staging;
pub(crate) mod status;
pub(crate) mod worktree;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use branch::{git_checkout_branch_impl, git_list_branches_impl};
use diff::{git_diff_commit_impl, git_diff_working_impl, git_explain_diff_impl};
use repo::git_repo_info_impl;
use staging::git_stage_files_impl;
use status::{git_file_status_impl, git_log_impl};
use worktree::{git_list_worktrees_impl, git_worktree_status_impl};

// Re-exports: accessible to git_agent and git_review via `crate::git::`
pub(crate) use diff::git_diff_branches_impl;
pub(crate) use push::git_push_impl;
pub(crate) use staging::{git_commit_impl, git_stage_all_impl};
pub(crate) use worktree::{git_create_worktree_impl, git_remove_worktree_impl};

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitState {
    path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            path_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─── Phase 1 types ───────────────────────────────────────────────────────────

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

// ─── Phase 2 types ───────────────────────────────────────────────────────────

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

// ─── Phase 3 types ───────────────────────────────────────────────────────────

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

// ─── Tauri command wrappers ───────────────────────────────────────────────────

#[tauri::command]
pub fn git_repo_info(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<GitRepoInfo, String> {
    git_repo_info_impl(repo_path)
}

#[tauri::command]
pub fn git_list_branches(
    repo_path: String,
    include_remote: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitBranchInfo>, String> {
    git_list_branches_impl(repo_path, include_remote.unwrap_or(false))
}

#[tauri::command]
pub fn git_file_status(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitFileStatus>, String> {
    git_file_status_impl(repo_path)
}

#[tauri::command]
pub fn git_log(
    repo_path: String,
    branch: Option<String>,
    limit: Option<u32>,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitCommitInfo>, String> {
    git_log_impl(repo_path, branch, limit.unwrap_or(50))
}

#[tauri::command]
pub fn git_checkout_branch(
    repo_path: String,
    branch: String,
    create: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_checkout_branch_impl(repo_path, branch, create.unwrap_or(false))
}

#[tauri::command]
pub fn git_stage_files(
    repo_path: String,
    paths: Vec<String>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_stage_files_impl(repo_path, paths)
}

#[tauri::command]
pub fn git_stage_all(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_stage_all_impl(repo_path)
}

#[tauri::command]
pub fn git_commit(
    repo_path: String,
    message: String,
    _state: tauri::State<GitState>,
) -> Result<String, String> {
    git_commit_impl(repo_path, message)
}

#[tauri::command]
pub fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_push_impl(repo_path, remote, branch)
}

#[tauri::command]
pub fn git_create_worktree(
    input: CreateWorktreeInput,
    _state: tauri::State<GitState>,
) -> Result<WorktreeInfo, String> {
    git_create_worktree_impl(input)
}

#[tauri::command]
pub fn git_list_worktrees(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<WorktreeInfo>, String> {
    git_list_worktrees_impl(repo_path)
}

#[tauri::command]
pub fn git_remove_worktree(
    repo_path: String,
    name: String,
    force: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_remove_worktree_impl(repo_path, name, force.unwrap_or(false))
}

#[tauri::command]
pub fn git_worktree_status(
    repo_path: String,
    name: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitFileStatus>, String> {
    git_worktree_status_impl(repo_path, name)
}

#[tauri::command]
pub fn git_diff_working(
    repo_path: String,
    staged_only: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_working_impl(repo_path, staged_only.unwrap_or(false))
}

#[tauri::command]
pub fn git_diff_branches(
    repo_path: String,
    base: String,
    head: String,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_branches_impl(repo_path, base, head)
}

#[tauri::command]
pub fn git_diff_commit(
    repo_path: String,
    oid: String,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_commit_impl(repo_path, oid)
}

#[tauri::command]
pub fn git_explain_diff(
    repo_path: String,
    base: String,
    head: String,
    _git_state: tauri::State<GitState>,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<Vec<DiffExplanation>, String> {
    git_explain_diff_impl(repo_path, base, head, &migration_state)
}
