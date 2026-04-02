use git2::{Repository, StatusOptions};

use super::{GitRepoInfo};

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

    let mut status_opts = StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(false);
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| e.message().to_string())?;
    let is_clean = statuses.is_empty();

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()));

    Ok(GitRepoInfo {
        repo_path,
        current_branch,
        head_oid,
        is_detached,
        is_clean,
        remote_url,
    })
}
