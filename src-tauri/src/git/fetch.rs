use git2::FetchOptions;
use serde::{Deserialize, Serialize};

use super::auth::default_remote_callbacks;
use super::cmd::run_git_allow_fail;
use super::repo::open_repo;

/// Outcome of a pull. `ok` is the porcelain exit status; `conflicted` is true
/// when the pull stopped on merge/rebase conflicts (the UI then routes the
/// conflicted paths into the ConflictTab and shows the operation banner).
/// `message` carries git's own stdout/stderr for display either way.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub ok: bool,
    pub conflicted: bool,
    pub message: String,
}

/// Fetch from `remote` (default "origin") using git2 so we share the SSH-agent
/// / GITHUB_TOKEN credential path with push. Empty refspecs make git2 use the
/// remote's configured fetch refspecs, exactly like a bare `git fetch`.
pub(crate) fn git_fetch_impl(repo_path: String, remote: Option<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin");
    let mut remote_obj = repo
        .find_remote(remote_name)
        .map_err(|e| e.message().to_string())?;
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(default_remote_callbacks());
    let empty: &[&str] = &[];
    remote_obj
        .fetch(empty, Some(&mut opts), None)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Pull via the porcelain so conflict mid-state (MERGE_HEAD / rebase-merge) is
/// written exactly as the user expects and our operation detection picks it up.
/// `mode` is "ff-only" | "merge" | "rebase". Auth here rides on the user's git
/// credential helper, not the git2 callback (see auth.rs note).
pub(crate) fn git_pull_impl(repo_path: String, mode: String) -> Result<PullResult, String> {
    let mode_arg = match mode.as_str() {
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        // default and explicit "ff-only"
        _ => "--ff-only",
    };
    let (ok, stdout, stderr) = run_git_allow_fail(&repo_path, &["pull", mode_arg])?;
    let combined = format!("{stdout}\n{stderr}").trim().to_string();
    // Same reasoning as `run_git_op`: ask the index whether there are unmerged
    // paths rather than grepping git's prose for "CONFLICT".
    let conflicted = !ok && super::cmd::has_unmerged_paths(&repo_path);
    Ok(PullResult {
        ok,
        conflicted,
        message: combined,
    })
}
