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
    // ...and remotes and tags, which used to be absent. A `git fetch` brings
    // commits that exist only under `refs/remotes/*`, and those are exactly the
    // ones a comparison is usually about — "what did upstream just land". They
    // were unpickable by summary or short sha until someone created a local
    // branch for them. Tags are the same story for a release the user never
    // checked out.
    walk.push_glob("refs/remotes/*").ok();
    walk.push_glob("refs/tags/*").ok();
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

    // Only when detached. On a branch, HEAD is a second name for something the
    // branch list already offers, and duplicating it would just push a real
    // choice off the top of the dropdown.
    let detached_head = repo
        .head()
        .ok()
        .filter(|h| !h.is_branch())
        .and_then(|h| h.peel_to_commit().ok())
        .map(|commit| RecentCommit {
            oid: commit.id().to_string(),
            short_oid: commit.id().to_string().chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            time: commit.time().seconds(),
        });

    Ok(RefList {
        branches,
        tags,
        recent_commits,
        detached_head,
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

    /// CMP-F15. Being *on* a commit no ref names is an ordinary state — mid
    /// bisect, mid rebase, or after checking out a tag — and the picker listed
    /// only branches, so the position the user was standing on was the one
    /// thing they could not pick.
    #[test]
    fn a_detached_head_is_offered_as_a_ref_of_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let first = commit_all(&repo, "one");
        write_file(tmp.path(), "a.txt", "two\n");
        commit_all(&repo, "two");

        assert!(
            git_list_refs_impl(tmp.path().to_string_lossy().to_string())
                .unwrap()
                .detached_head
                .is_none(),
            "on a branch, HEAD is a duplicate of a name already listed"
        );

        repo.set_head_detached(first).unwrap();
        let refs = git_list_refs_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        let head = refs.detached_head.expect("a detached HEAD must be offered");
        assert_eq!(head.oid, first.to_string());
        assert_eq!(head.summary, "one");
    }

    /// CMP-F16. The walk was seeded from `refs/heads/*` and HEAD only, so a
    /// commit that arrived on `origin/main` a moment ago — the usual reason to
    /// open a compare at all — could not be found by summary or short sha
    /// until someone made a local branch for it.
    #[test]
    fn a_commit_only_a_remote_ref_names_is_still_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let base = commit_all(&repo, "one");

        // A commit reachable only from `refs/remotes/origin/main`, exactly as a
        // fetch leaves one.
        write_file(tmp.path(), "a.txt", "upstream\n");
        let upstream = commit_all(&repo, "landed upstream");
        repo.reference("refs/remotes/origin/main", upstream, true, "fetch")
            .unwrap();
        repo.set_head_detached(base).unwrap();
        for (branch, _) in repo.branches(Some(BranchType::Local)).unwrap().flatten() {
            let mut branch = branch;
            branch.delete().unwrap();
        }

        let refs = git_list_refs_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(
            refs.recent_commits
                .iter()
                .any(|c| c.oid == upstream.to_string()),
            "a fetched commit with no local branch must still be pickable"
        );
    }

    /// The tag half of the same finding: a release tag no branch reaches.
    #[test]
    fn a_commit_only_a_tag_names_is_still_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        let base = commit_all(&repo, "one");
        write_file(tmp.path(), "a.txt", "released\n");
        let released = commit_all(&repo, "v1.0");
        repo.reference("refs/tags/v1.0", released, true, "tag").unwrap();
        repo.set_head_detached(base).unwrap();
        for (branch, _) in repo.branches(Some(BranchType::Local)).unwrap().flatten() {
            let mut branch = branch;
            branch.delete().unwrap();
        }

        let refs = git_list_refs_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        assert!(
            refs.recent_commits
                .iter()
                .any(|c| c.oid == released.to_string()),
            "a tagged commit off every branch must still be pickable"
        );
    }
}
