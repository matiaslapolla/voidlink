use std::path::Path;

use serde::{Deserialize, Serialize};

use super::cmd::run_git;

/// One entry from `git worktree list`. `branch` is the short name (the
/// `refs/heads/` prefix stripped) or `None` when the worktree has a detached
/// HEAD. The first worktree git reports is the main one — the repository's
/// own working directory — which can never be removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub is_locked: bool,
    /// Detached HEAD (no branch checked out). Mutually exclusive with `branch`.
    pub is_detached: bool,
}

/// Parse `git worktree list --porcelain`. Records are blank-line separated;
/// each is a set of `key value` lines. We care about `worktree` (path),
/// `HEAD` (oid), `branch` (ref), `detached`, and `locked`.
pub(crate) fn git_list_worktrees_impl(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let stdout = run_git(&repo_path, &["worktree", "list", "--porcelain"])?;

    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    let mut first = true;

    let flush = |cur: &mut Option<WorktreeInfo>, out: &mut Vec<WorktreeInfo>| {
        if let Some(wt) = cur.take() {
            out.push(wt);
        }
    };

    for line in stdout.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Starting a new record. The very first one git emits is main.
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                branch: None,
                head: None,
                is_main: first,
                is_locked: false,
                is_detached: false,
            });
            first = false;
        } else if let Some(wt) = cur.as_mut() {
            if let Some(oid) = line.strip_prefix("HEAD ") {
                wt.head = Some(oid.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                wt.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
            } else if line == "detached" {
                wt.is_detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                wt.is_locked = true;
            }
        }
    }
    flush(&mut cur, &mut out);

    Ok(out)
}

/// Create a worktree at `path`. Three shapes, matching `git worktree add`:
///   • new branch:       `branch=Some`, `new_branch=true`  → `add -b <branch> <path>`
///   • existing branch:  `branch=Some`, `new_branch=false` → `add <path> <branch>`
///   • auto (basename):  `branch=None`                      → `add <path>`
/// Returns the freshly-created worktree's info (re-listed by path).
pub(crate) fn git_add_worktree_impl(
    repo_path: String,
    path: String,
    branch: Option<String>,
    new_branch: bool,
) -> Result<WorktreeInfo, String> {
    if Path::new(&path).exists() {
        return Err(format!("path already exists: {path}"));
    }

    let mut args: Vec<&str> = vec!["worktree", "add"];
    match &branch {
        Some(b) if new_branch => {
            args.push("-b");
            args.push(b);
            args.push(&path);
        }
        Some(b) => {
            args.push(&path);
            args.push(b);
        }
        None => {
            args.push(&path);
        }
    }
    run_git(&repo_path, &args)?;

    // git canonicalizes the path it stores (symlinks, trailing slashes), so we
    // match on the basename rather than the raw string we passed in.
    let target = Path::new(&path);
    let list = git_list_worktrees_impl(repo_path)?;
    list.into_iter()
        .find(|wt| Path::new(&wt.path).file_name() == target.file_name())
        .ok_or_else(|| "worktree created but not found in list".to_string())
}

/// Remove the worktree at `path` and prune stale admin entries. `force`
/// passes `--force` (drops a worktree with uncommitted changes). The main
/// worktree can't be removed — git rejects that and we surface its error.
pub(crate) fn git_remove_worktree_impl(
    repo_path: String,
    path: String,
    force: bool,
) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    run_git(&repo_path, &args)?;
    // Best-effort cleanup of any now-stale entries; ignore failures.
    let _ = run_git(&repo_path, &["worktree", "prune"]);
    Ok(())
}
