use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cmd::{run_git, run_git_timeout};

/// Per-worktree enrichment shells out twice for every worktree in the list, so
/// none of those calls may hang the whole listing on an unresponsive filesystem
/// (a network mount, a stale automount). Short and deliberate.
const ENRICH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

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
    /// True when this worktree's dirty flag could not be read (its directory is
    /// gone, the `git status` there failed or timed out). `is_dirty` is false in
    /// that case, and false must not be read as "clean".
    pub status_unknown: bool,
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
                status_unknown: false,
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

        // Dirty = any porcelain output (staged, unstaged, or untracked). A
        // failure here used to degrade silently to "clean", so a stale worktree
        // whose directory had been deleted confidently reported no changes.
        match run_git_timeout(&wt.path, &["status", "--porcelain"], ENRICH_TIMEOUT) {
            Ok(status) => wt.is_dirty = !status.trim().is_empty(),
            Err(e) => {
                log::warn!("status for worktree {} unavailable: {e}", wt.path);
                wt.status_unknown = true;
            }
        }

        // Ahead/behind vs upstream. `<upstream>...HEAD` with `--left-right
        // --count` prints "<behind>\t<ahead>" (left = commits only on upstream,
        // right = commits only on HEAD). Fails with no upstream / detached HEAD,
        // which we let fall through to the 0/0 default.
        if let Ok(counts) = run_git_timeout(
            &wt.path,
            &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
            ENRICH_TIMEOUT,
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

    // git canonicalizes the path it stores (symlinks, trailing slashes), so match
    // on the canonicalized path — matching on the basename alone returned the
    // *wrong* worktree whenever two of them shared a directory name, which is
    // routine (`~/code/app/feature-x` and `~/worktrees/app/feature-x`).
    let target = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let list = git_list_worktrees_impl(repo_path)?;
    list.into_iter()
        .find(|wt| {
            let candidate =
                std::fs::canonicalize(&wt.path).unwrap_or_else(|_| PathBuf::from(&wt.path));
            candidate == target
        })
        .ok_or_else(|| format!("worktree created at {path} but not found in `git worktree list`"))
}

/// Remove the worktree at `path` and prune stale admin entries. `force`
/// passes `--force` (drops a worktree with uncommitted changes). The main
/// worktree can't be removed — git rejects that and we surface its error.
///
/// Returns a warning string (empty when there is nothing to say). The prune step
/// runs after a removal that already succeeded, so a prune failure must not be
/// reported as "removal failed" — but it used to be dropped on the floor
/// entirely, leaving stale admin entries nobody was told about.
pub(crate) fn git_remove_worktree_impl(
    repo_path: String,
    path: String,
    force: bool,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    run_git(&repo_path, &args)?;

    match run_git(&repo_path, &["worktree", "prune"]) {
        Ok(_) => Ok(String::new()),
        Err(e) => {
            log::warn!("worktree removed but prune failed: {e}");
            Ok(format!(
                "Worktree removed, but pruning stale entries failed: {e}"
            ))
        }
    }
}
