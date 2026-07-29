//! Temp-repository fixtures for the git tests.
//!
//! Shared rather than copied into each module's `mod tests`: "make a repo with a
//! commit" and "make a repo stopped mid-merge with a conflict" are the two
//! setups almost every test here needs, and three hand-rolled variants of them
//! is how test suites start disagreeing about what a conflict looks like.

#![cfg(test)]

use std::path::Path;

use git2::{Repository, Signature};

/// A repository with an identity configured, so commits work without touching
/// the developer's global git config.
pub(crate) fn init_repo(path: &Path) -> Repository {
    let repo = Repository::init(path).unwrap();
    let mut cfg = repo.config().unwrap();
    cfg.set_str("user.name", "Test").unwrap();
    cfg.set_str("user.email", "test@example.com").unwrap();
    drop(cfg);
    repo
}

pub(crate) fn write_file(root: &Path, name: &str, contents: &str) {
    let path = root.join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, contents).unwrap();
}

/// Stage everything and commit onto the current HEAD.
pub(crate) fn commit_all(repo: &Repository, message: &str) -> git2::Oid {
    let tree_oid = {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        index.write_tree().unwrap()
    };
    let tree = repo.find_tree(tree_oid).unwrap();
    let sig = Signature::now("Test", "test@example.com").unwrap();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .unwrap()
}

/// A repository stopped in the middle of a conflicted merge, exactly as the UI
/// finds one: `MERGE_HEAD` written, the index holding stages 1–3 for `a.txt`,
/// conflict markers on disk.
///
/// Returns the oid of the commit being merged in (the second parent a correct
/// merge commit must carry).
pub(crate) fn start_conflicted_merge(root: &Path) -> (Repository, git2::Oid) {
    let repo = init_repo(root);
    write_file(root, "a.txt", "base\n");
    commit_all(&repo, "base");

    {
        let base = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("theirs", &base, false).unwrap();
    }

    // Ours, on the starting branch.
    write_file(root, "a.txt", "ours\n");
    commit_all(&repo, "ours");
    let ours_head = repo.head().unwrap().name().unwrap().to_string();

    // Theirs, built on the branch ref without disturbing the working tree.
    let theirs_oid = {
        repo.set_head("refs/heads/theirs").unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        repo.checkout_head(Some(&mut co)).unwrap();
        write_file(root, "a.txt", "theirs\n");
        let oid = commit_all(&repo, "theirs");
        repo.set_head(&ours_head).unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.force();
        repo.checkout_head(Some(&mut co)).unwrap();
        oid
    };

    {
        let annotated = repo.find_annotated_commit(theirs_oid).unwrap();
        repo.merge(&[&annotated], None, None).unwrap();
    }
    assert!(
        repo.index().unwrap().has_conflicts(),
        "fixture must actually conflict"
    );
    assert!(
        repo.path().join("MERGE_HEAD").exists(),
        "fixture must leave the merge state libgit2 writes"
    );
    (repo, theirs_oid)
}
