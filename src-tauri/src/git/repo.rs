use git2::{BranchType, Repository, StatusOptions};

use super::GitRepoInfo;

pub(crate) fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.message().to_string())
}

pub(crate) fn git_repo_info_impl(repo_path: String) -> Result<GitRepoInfo, String> {
    let repo = open_repo(&repo_path)?;

    // A repository with no commits yet (`git init`, or a fresh orphan branch)
    // has no resolvable HEAD. That used to hard-error, and because `repoInfo()`
    // is read unguarded all over the sidebar's JSX, the error rethrew into
    // render and white-screened the whole git surface. An unborn HEAD is a
    // perfectly ordinary repo state, so it gets a valid shape: the branch name
    // git *intends* (read from the symbolic ref) and no oid.
    let head = repo.head().ok();
    let current_branch = match &head {
        Some(h) if h.is_branch() => h.shorthand().map(|s| s.to_string()),
        Some(_) => None,
        None => unborn_branch_name(&repo),
    };
    let head_oid = head.as_ref().and_then(|h| h.target()).map(|o| o.to_string());
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
    let has_conflicts = statuses.iter().any(|e| e.status().is_conflicted());

    // Detect an in-progress multi-step operation from the marker files git
    // writes into the git dir. One detector, shared with the guard that refuses
    // to mutate mid-operation — see `opstate.rs`.
    let operation = super::opstate::operation_name(&repo).map(|s| s.to_string());

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()));

    let mut ahead_behind_unknown = false;
    let (upstream, ahead, behind) = if let Some(ref name) = current_branch {
        match repo.find_branch(name, BranchType::Local) {
            Ok(branch) => match branch.upstream() {
                Ok(up) => {
                    let up_name = up.name().ok().flatten().map(|s| s.to_string());
                    let local_oid = branch.get().target();
                    let up_oid = up.get().target();
                    // A shallow clone is missing the objects the walk needs, and
                    // the old `unwrap_or((0, 0))` turned that error into a
                    // confident "in sync". Now the caller is told the numbers are
                    // unavailable rather than shown a fabricated zero.
                    let (a, b) = match (local_oid, up_oid) {
                        (Some(l), Some(u)) => match repo.graph_ahead_behind(l, u) {
                            Ok(counts) => counts,
                            Err(e) => {
                                log::warn!("ahead/behind for {name} unavailable: {e}");
                                ahead_behind_unknown = true;
                                (0, 0)
                            }
                        },
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
        ahead_behind_unknown,
        operation,
        has_conflicts,
    })
}

/// The branch an unborn HEAD points at, e.g. `main` right after `git init`.
///
/// `repo.head()` cannot resolve it (there is no commit to resolve to), but the
/// symbolic ref is right there in `.git/HEAD`.
fn unborn_branch_name(repo: &Repository) -> Option<String> {
    let head_ref = repo.find_reference("HEAD").ok()?;
    let target = head_ref.symbolic_target()?;
    Some(target.strip_prefix("refs/heads/").unwrap_or(target).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_repo_with_no_commits_reports_a_valid_shape() {
        let tmp = tempfile::tempdir().unwrap();
        Repository::init(tmp.path()).unwrap();

        let info = git_repo_info_impl(tmp.path().to_string_lossy().to_string())
            .expect("an unborn HEAD is an ordinary repo state, not an error");
        assert!(info.head_oid.is_none());
        assert!(!info.is_detached);
        assert_eq!(info.operation, None);
        assert!(!info.has_conflicts);
        assert!(
            info.current_branch.is_some(),
            "the branch git intends is readable from the symbolic ref"
        );
    }
}
