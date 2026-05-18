//! Stacked-PR primitive. See `docs/specs/2026-05-17-stacked-prs-design.md`.
//!
//! A *stack* is an ordered chain of branches rooted at a trunk (e.g. `main`).
//! Each non-trunk branch carries a `branch.<name>.parent` entry in
//! `.git/config` pointing at the branch it was built on top of. The chain is
//! reconstructed by walking those pointers.
//!
//! v0 (this module) covers read-only discovery + per-branch status. Create /
//! restack / submit live in sibling files and land in later waves.

pub(crate) mod discovery;
pub(crate) mod mutations;
pub(crate) mod restack;
pub(crate) mod submit;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stack {
    /// Trunk branch the stack is rooted at (e.g. `main`). Never appears in
    /// `branches`; trunks themselves are not part of a stack.
    pub trunk: String,
    /// Chain ordered from the branch closest to trunk up to the topmost.
    /// `branches[0].parent == trunk`; `branches[i].parent == branches[i-1].name`.
    pub branches: Vec<StackBranch>,
    /// Convenience aggregate — true if any branch in the chain shows drift
    /// between its recorded `parentbase` and the parent's current tip.
    pub needs_restack: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackBranch {
    pub name: String,
    pub parent: String,
    pub is_head: bool,
    /// Commits this branch has that parent does not.
    pub ahead_of_parent: u32,
    /// Commits parent has that this branch does not (parent moved past us).
    pub behind_parent: u32,
    /// SHA the parent pointed at when we last restacked this branch.
    /// Recorded in `branch.<name>.parentbase`. Used to detect drift in a way
    /// that's cheaper than walking merge-bases on every render.
    pub last_known_parent_tip: Option<String>,
    /// GitHub PR number if voidlink has previously submitted this branch.
    /// Recorded in `branch.<name>.prnumber`.
    pub pr_number: Option<u32>,
}

// ─── Tauri command wrappers ──────────────────────────────────────────────────

use super::GitState;

#[tauri::command]
pub async fn git_stack_current(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Option<Stack>, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::current_impl(repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_list(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<Stack>, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::list_impl(repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_create_branch(
    repo_path: String,
    name: String,
    parent: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutations::git_stack_create_branch_impl(repo_path, name, parent)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_set_parent(
    repo_path: String,
    branch: String,
    parent: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutations::git_stack_set_parent_impl(repo_path, branch, parent)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_untrack(
    repo_path: String,
    branch: String,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutations::git_stack_untrack_impl(repo_path, branch)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_get_trunks(
    repo_path: String,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || mutations::git_stack_get_trunks_impl(repo_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_set_trunks(
    repo_path: String,
    trunks: Vec<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        mutations::git_stack_set_trunks_impl(repo_path, trunks)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_restack(
    repo_path: String,
    branch: String,
    _state: tauri::State<'_, GitState>,
) -> Result<restack::RestackResult, String> {
    tauri::async_runtime::spawn_blocking(move || restack::restack_one_impl(repo_path, branch))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_restack_all(
    repo_path: String,
    branches: Vec<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<restack::RestackResult>, String> {
    tauri::async_runtime::spawn_blocking(move || restack::restack_all_impl(repo_path, branches))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_stack_submit(
    repo_path: String,
    branches: Vec<String>,
    _state: tauri::State<'_, GitState>,
) -> Result<Vec<submit::SubmitResult>, String> {
    tauri::async_runtime::spawn_blocking(move || submit::submit_impl(repo_path, branches))
        .await
        .map_err(|e| e.to_string())?
}
