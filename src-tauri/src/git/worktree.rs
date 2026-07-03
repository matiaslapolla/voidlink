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
    /// The worktree whose canonicalized path equals the `repo_path` the UI is
    /// currently viewing. At most one entry is `true`.
    pub is_current: bool,
    /// Has uncommitted changes (`git status --porcelain` produced any output).
    pub is_dirty: bool,
    /// Commits on this worktree's branch not on its upstream. 0 when there is no
    /// upstream or the HEAD is detached.
    pub ahead: u32,
    /// Commits on the upstream not on this worktree's branch. 0 when there is no
    /// upstream or the HEAD is detached.
    pub behind: u32,
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
                is_current: false,
                is_dirty: false,
                ahead: 0,
                behind: 0,
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

    // Enrich each worktree with per-directory status. Every extra `run_git`
    // targets the worktree's *own* path and is guarded: a failure (e.g. no
    // upstream, detached HEAD, transient error) degrades that field to its
    // default and never aborts the whole listing.
    let repo_canon = std::fs::canonicalize(&repo_path).ok();
    for wt in out.iter_mut() {
        // Current = the worktree the UI is viewing. Compare canonicalized paths
        // so symlinks / trailing slashes don't cause a false miss; fall back to
        // raw string equality when either path can't be canonicalized.
        wt.is_current = match (repo_canon.as_ref(), std::fs::canonicalize(&wt.path).ok()) {
            (Some(a), Some(b)) => *a == b,
            _ => Path::new(&wt.path) == Path::new(&repo_path),
        };

        // Dirty = any porcelain output (staged, unstaged, or untracked).
        if let Ok(status) = run_git(&wt.path, &["status", "--porcelain"]) {
            wt.is_dirty = !status.trim().is_empty();
        }

        // Ahead/behind vs upstream. `<upstream>...HEAD` with `--left-right
        // --count` prints "<behind>\t<ahead>" (left = commits only on upstream,
        // right = commits only on HEAD). Fails with no upstream / detached HEAD,
        // which we let fall through to the 0/0 default.
        if let Ok(counts) = run_git(
            &wt.path,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        ) {
            let mut parts = counts.split_whitespace();
            if let (Some(behind), Some(ahead)) = (parts.next(), parts.next()) {
                wt.behind = behind.parse().unwrap_or(0);
                wt.ahead = ahead.parse().unwrap_or(0);
            }
        }
    }

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
