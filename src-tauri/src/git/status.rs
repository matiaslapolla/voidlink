use git2::{Sort, StatusOptions};

use super::repo::open_repo;
use super::{GitCommitInfo, GitFileStatus};

pub(crate) fn git_file_status_impl(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&repo_path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut result = Vec::new();
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let s = entry.status();

        // Conflicted FIRST. libgit2 usually sets `WT_MODIFIED` alongside
        // `CONFLICTED` — a conflicted file is, after all, modified in the working
        // tree — so testing `is_wt_modified()` earlier in this chain meant every
        // real conflict was reported as an ordinary modification: the Conflicts
        // section stayed empty exactly when it mattered.
        let (status_str, staged) = if s.is_conflicted() {
            ("conflicted", false)
        } else if s.is_index_new() {
            ("added", true)
        } else if s.is_index_modified() {
            ("modified", true)
        } else if s.is_index_deleted() {
            ("deleted", true)
        } else if s.is_index_renamed() {
            ("renamed", true)
        } else if s.is_wt_new() {
            ("untracked", false)
        } else if s.is_wt_modified() {
            ("modified", false)
        } else if s.is_wt_deleted() {
            ("deleted", false)
        } else if s.is_wt_renamed() {
            ("renamed", false)
        } else {
            ("modified", false)
        };

        result.push(GitFileStatus {
            path,
            status: status_str.to_string(),
            staged,
        });
    }

    Ok(result)
}

pub(crate) fn git_log_impl(
    repo_path: String,
    branch: Option<String>,
    limit: u32,
) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;

    if let Some(ref b) = branch {
        let oid = repo
            .revparse_single(b)
            .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", b)))
            .map_err(|e| e.message().to_string())?
            .id();
        revwalk.push(oid).map_err(|e| e.message().to_string())?;
    } else if revwalk.push_head().is_err() {
        // Unborn HEAD: a repo with no commits has an empty history, which is a
        // fact about the repo rather than an error. Erroring here white-screened
        // the sidebar, since `log()` is read inside a memo with no boundary.
        return Ok(Vec::new());
    }

    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| e.message().to_string())?;

    let mut commits = Vec::new();
    for item in revwalk.take(limit as usize) {
        let oid = item.map_err(|e| e.message().to_string())?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| e.message().to_string())?;
        let author = commit.author();
        let parent_oids = commit.parent_ids().map(|o| o.to_string()).collect();
        commits.push(GitCommitInfo {
            oid: oid.to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
            body: commit
                .body()
                .filter(|b| !b.is_empty())
                .map(|b| b.to_string()),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            time: commit.time().seconds(),
            parent_oids,
        });
    }

    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{init_repo, start_conflicted_merge};

    #[test]
    fn a_conflicted_file_reports_conflicted_not_modified() {
        let tmp = tempfile::tempdir().unwrap();
        start_conflicted_merge(tmp.path());

        let statuses = git_file_status_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        let entry = statuses
            .iter()
            .find(|s| s.path == "a.txt")
            .expect("the conflicted file must appear");
        assert_eq!(
            entry.status, "conflicted",
            "libgit2 sets WT_MODIFIED too, so order in the chain decides — and \
             'modified' means the Conflicts section renders empty during a conflict"
        );
        assert!(!entry.staged);
    }

    #[test]
    fn a_repo_with_no_commits_has_an_empty_log_rather_than_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let log = git_log_impl(tmp.path().to_string_lossy().to_string(), None, 50)
            .expect("an unborn HEAD is an empty history, not a failure");
        assert!(log.is_empty());
    }
}
