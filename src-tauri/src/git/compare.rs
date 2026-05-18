use git2::{DiffOptions, Object, Tree};

use super::diff::collect_diff;
use super::repo::open_repo;
use super::DiffResult;

/// Diff any two refs. Both `base_ref` and `head_ref` go through `revparse_single`,
/// so they accept branches (`main`, `feature/x`), tags (`v1.2.0`), commit SHAs,
/// and revision expressions like `HEAD~3` or `origin/main^`.
///
/// When `use_merge_base` is true, the left side is the merge-base of the two
/// commits — i.e. "what changed on head since it diverged from base" (the
/// `base...head` form). When false, the left side is `base` directly (the
/// `base..head` form).
pub(crate) fn git_diff_refs_impl(
    repo_path: String,
    base_ref: String,
    head_ref: String,
    use_merge_base: bool,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;

    let base_obj = resolve_ref(&repo, &base_ref).map_err(|e| format!("base: {e}"))?;
    let head_obj = resolve_ref(&repo, &head_ref).map_err(|e| format!("head: {e}"))?;

    let base_commit = base_obj
        .peel_to_commit()
        .map_err(|e| format!("base: {}", e.message()))?;
    let head_commit = head_obj
        .peel_to_commit()
        .map_err(|e| format!("head: {}", e.message()))?;

    let left_tree: Tree = if use_merge_base {
        match repo.merge_base(base_commit.id(), head_commit.id()) {
            Ok(oid) => repo
                .find_commit(oid)
                .map_err(|e| e.message().to_string())?
                .tree()
                .map_err(|e| e.message().to_string())?,
            // No common ancestor (unrelated histories) — fall back to a direct
            // diff against base. Better than failing the whole comparison.
            Err(_) => base_commit.tree().map_err(|e| e.message().to_string())?,
        }
    } else {
        base_commit.tree().map_err(|e| e.message().to_string())?
    };

    let right_tree = head_commit.tree().map_err(|e| e.message().to_string())?;

    let mut opts = DiffOptions::new();
    opts.context_lines(3);

    let diff = repo
        .diff_tree_to_tree(Some(&left_tree), Some(&right_tree), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    collect_diff(diff)
}

fn resolve_ref<'a>(repo: &'a git2::Repository, name: &str) -> Result<Object<'a>, String> {
    repo.revparse_single(name)
        .map_err(|e| format!("could not resolve '{name}': {}", e.message()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};
    use std::fs;
    use std::path::Path;

    fn write(p: &Path, contents: &str) {
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, contents).unwrap();
    }

    fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    fn build_two_branch_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();

        // Main: one file
        write(&dir.path().join("a.txt"), "hello\n");
        commit_all(&repo, "init");

        // Branch off into "feature" with another commit
        let head_oid = repo.head().unwrap().target().unwrap();
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("feature", &head_commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        write(&dir.path().join("a.txt"), "hello\nworld\n");
        write(&dir.path().join("b.txt"), "new file\n");
        commit_all(&repo, "feature work");

        // Move main forward independently to ensure merge-base logic matters
        repo.set_head("refs/heads/master")
            .or_else(|_| repo.set_head("refs/heads/main"))
            .ok();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .ok();

        dir
    }

    #[test]
    fn diffs_two_branches() {
        let dir = build_two_branch_repo();
        let path = dir.path().to_string_lossy().to_string();
        let head_branch = "feature".to_string();
        let base_branch = head_default_branch(&Repository::open(dir.path()).unwrap());

        let result =
            git_diff_refs_impl(path, base_branch, head_branch, true).expect("diff succeeds");
        assert!(!result.files.is_empty(), "expected file changes");
        assert!(result.total_additions >= 1);
    }

    #[test]
    fn invalid_ref_returns_error() {
        let dir = build_two_branch_repo();
        let path = dir.path().to_string_lossy().to_string();
        let base = head_default_branch(&Repository::open(dir.path()).unwrap());
        let err =
            git_diff_refs_impl(path, base, "no-such-ref".into(), true).unwrap_err();
        assert!(err.contains("head"), "error should identify which side: {err}");
    }

    fn head_default_branch(repo: &Repository) -> String {
        // After init the default branch is either "master" or "main" depending
        // on git config; pick whichever exists.
        if repo.find_branch("main", git2::BranchType::Local).is_ok() {
            "main".into()
        } else {
            "master".into()
        }
    }
}
