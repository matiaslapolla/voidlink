pub(crate) mod branch;
pub(crate) mod diff;
pub(crate) mod push;
pub(crate) mod repo;
pub(crate) mod staging;
pub(crate) mod status;

use serde::{Deserialize, Serialize};

use branch::{git_checkout_branch_impl, git_list_branches_impl};
use diff::git_diff_working_impl;
use repo::git_repo_info_impl;
use staging::{git_commit_impl, git_stage_all_impl, git_stage_files_impl, git_unstage_files_impl};
use status::{git_file_status_impl, git_log_impl};
use push::git_push_impl;

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitState;

impl GitState {
    pub fn new() -> Self { Self }
}

// ─── Types ───────────────────────────────────────────────────────────────────

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

// ─── Tauri command wrappers ──────────────────────────────────────────────────

macro_rules! blocking_git {
    ($body:expr) => {
        tauri::async_runtime::spawn_blocking(move || $body)
            .await
            .map_err(|e| e.to_string())?
    };
}

#[tauri::command]
pub async fn git_repo_info(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<GitRepoInfo, String> {
    blocking_git!(git_repo_info_impl(repo_path))
}

#[tauri::command]
pub async fn git_list_branches(
    repo_path: String,
    include_remote: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<GitBranchInfo>, String> {
    let include = include_remote.unwrap_or(false);
    blocking_git!(git_list_branches_impl(repo_path, include))
}

#[tauri::command]
pub async fn git_file_status(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<GitFileStatus>, String> {
    blocking_git!(git_file_status_impl(repo_path))
}

#[tauri::command]
pub async fn git_log(
    repo_path: String,
    branch: Option<String>,
    limit: Option<u32>,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<GitCommitInfo>, String> {
    let lim = limit.unwrap_or(50);
    blocking_git!(git_log_impl(repo_path, branch, lim))
}

#[tauri::command]
pub async fn git_checkout_branch(
    repo_path: String,
    branch: String,
    create: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let c = create.unwrap_or(false);
    blocking_git!(git_checkout_branch_impl(repo_path, branch, c))
}

#[tauri::command]
pub async fn git_stage_files(
    repo_path: String,
    paths: Vec<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_stage_files_impl(repo_path, paths))
}

#[tauri::command]
pub async fn git_unstage_files(
    repo_path: String,
    paths: Vec<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_unstage_files_impl(repo_path, paths))
}

#[tauri::command]
pub async fn git_stage_all(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_stage_all_impl(repo_path))
}

#[tauri::command]
pub async fn git_commit(
    repo_path: String,
    message: String,
    _state: tauri::State<'_, GitState>,
) -> Result<String, String> {
    blocking_git!(git_commit_impl(repo_path, message))
}

#[tauri::command]
pub async fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_push_impl(repo_path, remote, branch))
}

#[tauri::command]
pub async fn git_diff_working(
    repo_path: String,
    staged_only: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<DiffResult, String> {
    let staged = staged_only.unwrap_or(false);
    blocking_git!(git_diff_working_impl(repo_path, staged))
}
