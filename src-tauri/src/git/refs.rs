use git2::{BranchType, Sort};

use super::repo::open_repo;
use super::{RecentCommit, RefList};

const RECENT_COMMITS_LIMIT: usize = 50;

/// Build the data feeding the ref-picker autocomplete: branches (local + remote),
/// tags, and the most recent commits across the whole repo.
///
/// The picker still accepts free text — this is just the suggestion list.
pub(crate) fn git_list_refs_impl(repo_path: String) -> Result<RefList, String> {
    let repo = open_repo(&repo_path)?;

    let mut branches = Vec::new();
    let iter = repo
        .branches(None)
        .map_err(|e| e.message().to_string())?;
    for item in iter {
        let (branch, btype) = item.map_err(|e| e.message().to_string())?;
        let raw = branch.name().map_err(|e| e.message().to_string())?;
        let Some(name) = raw else { continue };
        if name.is_empty() {
            continue;
        }
        // Remote refs come back as "origin/main" — that form is what
        // revparse_single accepts directly, so we keep the prefix.
        let entry = match btype {
            BranchType::Local => name.to_string(),
            BranchType::Remote => name.to_string(),
        };
        branches.push(entry);
    }
    branches.sort();
    branches.dedup();

    let mut tags = Vec::new();
    repo.tag_foreach(|_oid, name_bytes| {
        if let Ok(name) = std::str::from_utf8(name_bytes) {
            // Strip "refs/tags/" prefix to get the bare tag name.
            let bare = name.strip_prefix("refs/tags/").unwrap_or(name);
            tags.push(bare.to_string());
        }
        true
    })
    .map_err(|e| e.message().to_string())?;
    tags.sort();
    tags.dedup();

    let mut recent_commits = Vec::new();
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TIME).ok();
    // Walk all refs so commits unique to feature branches still show up, AND
    // HEAD, which is not one of them when it is detached. These used to be
    // `||`-chained, but `push_glob` returns Ok even when it matched nothing, so
    // `push_head` never ran and a detached HEAD's walk omitted exactly the
    // commits the user was standing on. Both pushes are attempted; both are
    // allowed to fail (an unborn HEAD has nothing to push and no history).
    walk.push_glob("refs/heads/*").ok();
    // Remote-tracking branches too. Without them a commit that exists only on a
    // fetched remote branch — which is every commit a colleague pushed and you
    // have not merged — could never be suggested, in a picker whose own branch
    // list offers `origin/foo` two fields above. Pick the branch and the
    // commits on it were not offered; that is the picker disagreeing with
    // itself.
    walk.push_glob("refs/remotes/*").ok();
    walk.push_head().ok();
    for oid in walk.take(RECENT_COMMITS_LIMIT).flatten() {
        let Ok(commit) = repo.find_commit(oid) else { continue };
        recent_commits.push(RecentCommit {
            oid: oid.to_string(),
            short_oid: oid.to_string().chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            time: commit.time().seconds(),
        });
    }

    Ok(RefList {
        branches,
        tags,
        recent_commits,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    #[test]
    fn a_repo_with_no_commits_returns_an_empty_ref_list() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let refs = git_list_refs_impl(tmp.path().to_string_lossy().to_string())
            .expect("an unborn HEAD must not error the ref picker");
        assert!(refs.branches.is_empty());
        assert!(refs.recent_commits.is_empty());
    }

    #[test]
    fn a_detached_head_still_lists_the_commit_you_are_standing_on() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        commit_all(&repo, "one");
        write_file(tmp.path(), "a.txt", "two\n");
        let tip = commit_all(&repo, "two");

        // Detach onto the tip and delete the branch, so the commits are reachable
        // only through HEAD. `push_glob` matching nothing used to short-circuit
        // `push_head`, which dropped exactly these commits.
        repo.set_head_detached(tip).unwrap();
        let branch_name = repo
            .branches(Some(git2::BranchType::Local))
            .unwrap()
            .flatten()
            .next()
            .map(|(b, _)| b.name().unwrap().unwrap().to_string())
            .unwrap();
        repo.find_branch(&branch_name, git2::BranchType::Local)
            .unwrap()
            .delete()
            .unwrap();

        let refs = git_list_refs_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(
            refs.recent_commits.iter().any(|c| c.oid == tip.to_string()),
            "the commit HEAD points at must be in the recent list"
        );
    }
}
