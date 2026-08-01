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

/// Fetch, using git2 so we share the SSH-agent / GITHUB_TOKEN credential path
/// with push. Empty refspecs make git2 use the remote's configured fetch
/// refspecs, exactly like a bare `git fetch`.
///
/// `remote` names one remote; `None` fetches **every** configured remote. It
/// used to default to `"origin"`, which meant a remote added through the
/// Remotes dialog was never fetched by any code path in the app — its branches
/// simply never appeared, and adding an `upstream` produced no visible change,
/// ever.
///
/// Pruning is on. Without it a branch deleted on the server stayed in the
/// branch list forever, with an ahead/behind chip computed against a ref that
/// no longer exists anywhere but here.
pub(crate) fn git_fetch_impl(repo_path: String, remote: Option<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;

    let names: Vec<String> = match remote {
        Some(name) => vec![name],
        None => repo
            .remotes()
            .map_err(|e| e.message().to_string())?
            .iter()
            .flatten()
            .map(|n| n.to_string())
            .collect(),
    };

    if names.is_empty() {
        return Err("This repository has no remotes configured".to_string());
    }

    // One remote failing must not silently cancel the others — but it must not
    // be swallowed either, so failures are collected and reported together
    // after every remote has had its turn.
    let mut failures: Vec<String> = Vec::new();
    for name in &names {
        if let Err(e) = fetch_one(&repo, name) {
            failures.push(format!("{name}: {e}"));
        }
    }

    if failures.is_empty() {
        Ok(())
    } else if failures.len() == names.len() {
        Err(failures.join("; "))
    } else {
        // Some worked. Still an error — the caller shows it — but worded so it
        // is clear the fetch was not a total loss.
        Err(format!(
            "Fetched {} of {} remotes; {}",
            names.len() - failures.len(),
            names.len(),
            failures.join("; ")
        ))
    }
}

fn fetch_one(repo: &git2::Repository, name: &str) -> Result<(), String> {
    let mut remote_obj = repo
        .find_remote(name)
        .map_err(|e| e.message().to_string())?;
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(default_remote_callbacks());
    opts.prune(git2::FetchPrune::On);
    let empty: &[&str] = &[];
    remote_obj
        .fetch(empty, Some(&mut opts), None)
        .map_err(|e| e.message().to_string())
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
