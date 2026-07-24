pub(crate) mod agent;
pub(crate) mod ai_commit;
pub(crate) mod apply_hunk;
pub(crate) mod auth;
pub(crate) mod blame;
pub(crate) mod branch;
pub(crate) mod cli;
pub(crate) mod cmd;
pub(crate) mod compare;
pub(crate) mod conflict;
pub(crate) mod diff;
pub(crate) mod discard;
pub(crate) mod fetch;
pub(crate) mod graph;
pub(crate) mod ls_files;
pub(crate) mod merge;
pub(crate) mod pick;
pub(crate) mod push;
pub(crate) mod rebase;
pub(crate) mod refs;
pub(crate) mod remote;
pub(crate) mod reset;
pub(crate) mod repo;
pub(crate) mod safe_checkout;
pub(crate) mod stack;
pub(crate) mod staging;
pub(crate) mod stash;
pub(crate) mod status;
pub(crate) mod tag;
pub(crate) mod worktree;
pub(crate) mod worktree_setup;

use serde::{Deserialize, Serialize};

use crate::secrets::SecretBinding;

use agent::git_agent_query_impl;
use ai_commit::git_ai_generate_commit_impl;
use apply_hunk::{git_apply_hunk_impl, git_discard_hunk_impl};
use blame::{git_blame_file_impl, BlameLine};
use branch::{
    git_checkout_branch_impl, git_create_branch_impl, git_delete_branch_impl,
    git_list_branches_impl, git_rename_branch_impl,
};
use compare::git_diff_refs_impl;
use conflict::{
    git_conflict_versions_impl, git_list_conflicts_impl, git_resolve_conflict_impl,
    ConflictVersions,
};
use cmd::OpResult;
use diff::git_diff_working_impl;
use discard::{git_discard_all_impl, git_discard_file_impl};
use fetch::{git_fetch_impl, git_pull_impl, PullResult};
use graph::{git_commit_graph_impl, GraphCommit};
use ls_files::git_ls_files_impl;
use merge::{git_merge_abort_impl, git_merge_impl};
use pick::{
    git_cherry_pick_abort_impl, git_cherry_pick_continue_impl, git_cherry_pick_impl,
    git_revert_abort_impl, git_revert_continue_impl, git_revert_impl,
};
use rebase::{git_rebase_abort_impl, git_rebase_continue_impl, git_rebase_impl};
use reset::{git_amend_impl, git_reset_impl, git_undo_last_commit_impl};
use refs::git_list_refs_impl;
use remote::{
    git_add_remote_impl, git_list_remotes_impl, git_remove_remote_impl, git_rename_remote_impl,
    git_set_remote_url_impl, RemoteInfo,
};
use repo::git_repo_info_impl;
use safe_checkout::{git_safe_checkout_impl, SafeCheckoutResult};
use staging::{git_commit_impl, git_stage_all_impl, git_stage_files_impl, git_unstage_files_impl};
use stash::{
    git_stash_apply_impl, git_stash_drop_impl, git_stash_list_impl, git_stash_pop_impl,
    git_stash_save_impl, git_stash_show_impl, StashEntry,
};
use status::{git_file_status_impl, git_log_impl};
use tag::{git_create_tag_impl, git_delete_tag_impl, git_push_tag_impl};
use push::git_push_impl;
use worktree::{
    git_add_worktree_impl, git_list_worktrees_impl, git_remove_worktree_impl, WorktreeInfo,
};
use worktree_setup::{
    apply_setup, build_plan, write_defaults, DepAction, WorktreeDefaults, WorktreeSetupPlan,
    WorktreeSetupReport,
};

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
    /// Tracked upstream of the current branch, e.g. "origin/main". None when no upstream is set.
    pub upstream: Option<String>,
    /// Commits the current branch has that upstream does not. 0 if no upstream.
    pub ahead: u32,
    /// Commits upstream has that the current branch does not. 0 if no upstream.
    pub behind: u32,
    /// A multi-step operation currently in progress, detected from `.git`
    /// marker files: one of "merge" | "rebase" | "cherry-pick" | "revert".
    /// None when the working tree is in a normal state.
    pub operation: Option<String>,
    /// Whether the index currently has any conflicted entries. Drives the
    /// "resolve before continue" gate on the operation banner.
    pub has_conflicts: bool,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefList {
    pub branches: Vec<String>,
    pub tags: Vec<String>,
    pub recent_commits: Vec<RecentCommit>,
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
pub async fn git_commit_graph(
    repo_path: String,
    limit: Option<u32>,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<GraphCommit>, String> {
    let lim = limit.unwrap_or(200);
    blocking_git!(git_commit_graph_impl(repo_path, lim))
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
pub async fn git_fetch(
    repo_path: String,
    remote: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_fetch_impl(repo_path, remote))
}

#[tauri::command]
pub async fn git_pull(
    repo_path: String,
    mode: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<PullResult, String> {
    let m = mode.unwrap_or_else(|| "ff-only".to_string());
    blocking_git!(git_pull_impl(repo_path, m))
}

#[tauri::command]
pub async fn git_discard_file(
    repo_path: String,
    path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_discard_file_impl(repo_path, path))
}

#[tauri::command]
pub async fn git_discard_all(
    repo_path: String,
    include_untracked: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let inc = include_untracked.unwrap_or(false);
    blocking_git!(git_discard_all_impl(repo_path, inc))
}

#[tauri::command]
pub async fn git_discard_hunk(
    repo_path: String,
    file: FileDiff,
    hunk_index: usize,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_discard_hunk_impl(repo_path, file, hunk_index))
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

#[tauri::command]
pub async fn git_diff_refs(
    repo_path: String,
    base_ref: String,
    head_ref: String,
    use_merge_base: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<DiffResult, String> {
    let merge_base = use_merge_base.unwrap_or(true);
    blocking_git!(git_diff_refs_impl(repo_path, base_ref, head_ref, merge_base))
}

#[tauri::command]
pub async fn git_list_refs(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<RefList, String> {
    blocking_git!(git_list_refs_impl(repo_path))
}

#[tauri::command]
pub async fn git_ls_files(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<String>, String> {
    blocking_git!(git_ls_files_impl(repo_path))
}

#[tauri::command]
pub async fn git_safe_checkout(
    repo_path: String,
    branch: String,
    create: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<SafeCheckoutResult, String> {
    let c = create.unwrap_or(false);
    blocking_git!(git_safe_checkout_impl(repo_path, branch, c))
}

#[tauri::command]
pub async fn git_apply_hunk(
    repo_path: String,
    file: FileDiff,
    hunk_index: usize,
    reverse: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let rev = reverse.unwrap_or(false);
    blocking_git!(git_apply_hunk_impl(repo_path, file, hunk_index, rev))
}

#[tauri::command]
pub async fn git_ai_generate_commit(
    repo_path: String,
    command_template: String,
    secret_bindings: Vec<SecretBinding>,
    _state: tauri::State<'_, GitState>,
) -> Result<String, String> {
    blocking_git!(git_ai_generate_commit_impl(
        repo_path,
        command_template,
        secret_bindings
    ))
}

#[tauri::command]
pub async fn git_blame_file(
    repo_path: String,
    file_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<BlameLine>, String> {
    blocking_git!(git_blame_file_impl(repo_path, file_path))
}

#[tauri::command]
pub async fn git_list_conflicts(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<String>, String> {
    blocking_git!(git_list_conflicts_impl(repo_path))
}

#[tauri::command]
pub async fn git_conflict_versions(
    repo_path: String,
    file_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<ConflictVersions, String> {
    blocking_git!(git_conflict_versions_impl(repo_path, file_path))
}

#[tauri::command]
pub async fn git_resolve_conflict(
    repo_path: String,
    file_path: String,
    content: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_resolve_conflict_impl(repo_path, file_path, content))
}

#[tauri::command]
pub async fn git_agent_query(
    repo_path: String,
    command_template: String,
    prompt: String,
    secret_bindings: Vec<SecretBinding>,
    _state: tauri::State<'_, GitState>,
) -> Result<String, String> {
    blocking_git!(git_agent_query_impl(
        repo_path,
        command_template,
        prompt,
        secret_bindings
    ))
}

// ─── Branch lifecycle ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_create_branch(
    repo_path: String,
    name: String,
    start_point: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_create_branch_impl(repo_path, name, start_point))
}

#[tauri::command]
pub async fn git_delete_branch(
    repo_path: String,
    name: String,
    force: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let f = force.unwrap_or(false);
    blocking_git!(git_delete_branch_impl(repo_path, name, f))
}

#[tauri::command]
pub async fn git_rename_branch(
    repo_path: String,
    old_name: String,
    new_name: String,
    force: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let f = force.unwrap_or(false);
    blocking_git!(git_rename_branch_impl(repo_path, old_name, new_name, f))
}

// ─── Tags ────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_create_tag(
    repo_path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_create_tag_impl(repo_path, name, target, message))
}

#[tauri::command]
pub async fn git_delete_tag(
    repo_path: String,
    name: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_delete_tag_impl(repo_path, name))
}

#[tauri::command]
pub async fn git_push_tag(
    repo_path: String,
    name: String,
    remote: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_push_tag_impl(repo_path, name, remote))
}

// ─── Stash ───────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_stash_list(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<StashEntry>, String> {
    blocking_git!(git_stash_list_impl(repo_path))
}

#[tauri::command]
pub async fn git_stash_save(
    repo_path: String,
    message: Option<String>,
    keep_index: Option<bool>,
    include_untracked: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<String, String> {
    let keep = keep_index.unwrap_or(false);
    let untracked = include_untracked.unwrap_or(false);
    blocking_git!(git_stash_save_impl(repo_path, message, keep, untracked))
}

#[tauri::command]
pub async fn git_stash_apply(
    repo_path: String,
    index: usize,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_stash_apply_impl(repo_path, index))
}

#[tauri::command]
pub async fn git_stash_pop(
    repo_path: String,
    index: usize,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_stash_pop_impl(repo_path, index))
}

#[tauri::command]
pub async fn git_stash_drop(
    repo_path: String,
    index: usize,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_stash_drop_impl(repo_path, index))
}

#[tauri::command]
pub async fn git_stash_show(
    repo_path: String,
    index: usize,
    _state: tauri::State<'_, GitState>,
) -> Result<DiffResult, String> {
    blocking_git!(git_stash_show_impl(repo_path, index))
}

// ─── Remotes ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_list_remotes(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<RemoteInfo>, String> {
    blocking_git!(git_list_remotes_impl(repo_path))
}

#[tauri::command]
pub async fn git_add_remote(
    repo_path: String,
    name: String,
    url: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_add_remote_impl(repo_path, name, url))
}

#[tauri::command]
pub async fn git_remove_remote(
    repo_path: String,
    name: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_remove_remote_impl(repo_path, name))
}

#[tauri::command]
pub async fn git_rename_remote(
    repo_path: String,
    old_name: String,
    new_name: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_rename_remote_impl(repo_path, old_name, new_name))
}

#[tauri::command]
pub async fn git_set_remote_url(
    repo_path: String,
    name: String,
    url: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_set_remote_url_impl(repo_path, name, url))
}

// ─── Merge / rebase / cherry-pick / revert ───────────────────────────────────

#[tauri::command]
pub async fn git_merge(
    repo_path: String,
    branch: String,
    no_ff: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    let nf = no_ff.unwrap_or(false);
    blocking_git!(git_merge_impl(repo_path, branch, nf))
}

#[tauri::command]
pub async fn git_merge_abort(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_merge_abort_impl(repo_path))
}

#[tauri::command]
pub async fn git_rebase(
    repo_path: String,
    onto: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_rebase_impl(repo_path, onto))
}

#[tauri::command]
pub async fn git_rebase_continue(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_rebase_continue_impl(repo_path))
}

#[tauri::command]
pub async fn git_rebase_abort(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_rebase_abort_impl(repo_path))
}

#[tauri::command]
pub async fn git_cherry_pick(
    repo_path: String,
    oid: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_cherry_pick_impl(repo_path, oid))
}

#[tauri::command]
pub async fn git_cherry_pick_continue(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_cherry_pick_continue_impl(repo_path))
}

#[tauri::command]
pub async fn git_cherry_pick_abort(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_cherry_pick_abort_impl(repo_path))
}

#[tauri::command]
pub async fn git_revert(
    repo_path: String,
    oid: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_revert_impl(repo_path, oid))
}

#[tauri::command]
pub async fn git_revert_continue(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<OpResult, String> {
    blocking_git!(git_revert_continue_impl(repo_path))
}

#[tauri::command]
pub async fn git_revert_abort(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_revert_abort_impl(repo_path))
}

// ─── Amend / undo / reset ────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_amend(
    repo_path: String,
    message: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<String, String> {
    blocking_git!(git_amend_impl(repo_path, message))
}

#[tauri::command]
pub async fn git_undo_last_commit(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_undo_last_commit_impl(repo_path))
}

#[tauri::command]
pub async fn git_reset(
    repo_path: String,
    target: String,
    mode: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(git_reset_impl(repo_path, target, mode))
}

#[tauri::command]
pub async fn git_list_worktrees(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<WorktreeInfo>, String> {
    blocking_git!(git_list_worktrees_impl(repo_path))
}

#[tauri::command]
pub async fn git_add_worktree(
    repo_path: String,
    path: String,
    branch: Option<String>,
    new_branch: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<WorktreeInfo, String> {
    let nb = new_branch.unwrap_or(false);
    blocking_git!(git_add_worktree_impl(repo_path, path, branch, nb))
}

#[tauri::command]
pub async fn git_remove_worktree(
    repo_path: String,
    path: String,
    force: Option<bool>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    let f = force.unwrap_or(false);
    blocking_git!(git_remove_worktree_impl(repo_path, path, f))
}

// ─── Worktree setup (env files, dependency dirs, per-repo defaults) ──────────

/// Inspect `source_path` and report what a new worktree would need: which
/// `.env*` files exist and whether git ignores them, which dependency
/// directories we can populate, and any answers this repo has saved before.
/// Read-only — nothing on disk changes until `worktree_apply_setup`.
#[tauri::command]
pub async fn worktree_setup_plan(
    repo_path: String,
    source_path: Option<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<WorktreeSetupPlan, String> {
    let source = source_path.unwrap_or_else(|| repo_path.clone());
    blocking_git!(build_plan(
        std::path::Path::new(&repo_path),
        std::path::Path::new(&source)
    ))
}

/// Apply the wizard's answers to a worktree that already exists on disk.
/// Never aborts halfway: every step reports its own success or failure so the
/// caller can say exactly what worked and what didn't.
#[tauri::command]
pub async fn worktree_apply_setup(
    source_path: String,
    dest_path: String,
    env_files: Vec<String>,
    dep_actions: std::collections::BTreeMap<String, DepAction>,
    _state: tauri::State<'_, GitState>,
) -> Result<WorktreeSetupReport, String> {
    blocking_git!(apply_setup(
        std::path::Path::new(&source_path),
        std::path::Path::new(&dest_path),
        &env_files,
        &dep_actions
    ))
}

/// Persist the wizard's answers to `<repoRoot>/.voidlink/worktree.json`.
#[tauri::command]
pub async fn worktree_save_defaults(
    repo_path: String,
    defaults: WorktreeDefaults,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    blocking_git!(write_defaults(std::path::Path::new(&repo_path), &defaults))
}
