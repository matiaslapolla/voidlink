use git2::{BranchType, Repository, StatusOptions};

use super::GitRepoInfo;

pub(crate) fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.message().to_string())
}

pub(crate) fn git_repo_info_impl(repo_path: String) -> Result<GitRepoInfo, String> {
    let repo = open_repo(&repo_path)?;

    let head = repo.head().map_err(|e| e.message().to_string())?;
    let current_branch = if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    };
    let head_oid = head.target().map(|o| o.to_string());
    let is_detached = repo.head_detached().unwrap_or(false);

    // Use include_untracked but skip recursing dirs — just need to know if anything is dirty.
    // This still collects all statuses; git2-rs doesn't expose a short-circuit callback.
    // But we at least avoid recursing into untracked directories for faster results.
    let mut status_opts = StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| e.message().to_string())?;
    let is_clean = statuses.is_empty();

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()));

    let (upstream, ahead, behind) = if let Some(ref name) = current_branch {
        match repo.find_branch(name, BranchType::Local) {
            Ok(branch) => match branch.upstream() {
                Ok(up) => {
                    let up_name = up.name().ok().flatten().map(|s| s.to_string());
                    let local_oid = branch.get().target();
                    let up_oid = up.get().target();
                    let (a, b) = match (local_oid, up_oid) {
                        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
                        _ => (0, 0),
                    };
                    (up_name, a as u32, b as u32)
                }
                Err(_) => (None, 0, 0),
            },
            Err(_) => (None, 0, 0),
        }
    } else {
        (None, 0, 0)
    };

    Ok(GitRepoInfo {
        repo_path,
        current_branch,
        head_oid,
        is_detached,
        is_clean,
        remote_url,
        upstream,
        ahead,
        behind,
    })
}
