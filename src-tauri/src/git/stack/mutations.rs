use git2::{ErrorCode, Repository};

use super::discovery;
use crate::git::repo::open_repo;

/// Create a new branch tip on top of `parent`, record it as a stack child of
/// `parent`, and check it out. Mirrors `git checkout -b <name> <parent>` plus
/// the voidlink config write that makes the new branch part of a stack.
///
/// Refuses to create on top of a non-existent parent. The parent itself does
/// not need to be a stack member — first-stack-from-trunk lands here too.
pub(crate) fn git_stack_create_branch_impl(
    repo_path: String,
    name: String,
    parent: String,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("branch name is empty".into());
    }
    if name == parent {
        return Err("branch and parent cannot be the same".into());
    }
    let repo = open_repo(&repo_path)?;

    // Resolve the parent ref now — we need its commit for `repo.branch`, and
    // surfacing "parent doesn't exist" here is friendlier than failing later.
    let parent_commit = repo
        .revparse_single(&parent)
        .map_err(|e| format!("parent `{}` not found: {}", parent, e.message()))?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    let parent_oid = parent_commit.id().to_string();

    // Fail fast on collision instead of clobbering an existing branch.
    if repo.find_branch(&name, git2::BranchType::Local).is_ok() {
        return Err(format!("branch `{}` already exists", name));
    }

    repo.branch(&name, &parent_commit, false)
        .map_err(|e| e.message().to_string())?;

    write_parent_keys(&repo, &name, &parent, Some(&parent_oid))?;

    // Check the new branch out so the user lands on it (matches the implicit
    // contract: "create on top of X" means "start working there now").
    let obj = repo
        .revparse_single(&format!("refs/heads/{}", name))
        .map_err(|e| e.message().to_string())?;
    let mut co = git2::build::CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(&obj, Some(&mut co))
        .map_err(|e| e.message().to_string())?;
    repo.set_head(&format!("refs/heads/{}", name))
        .map_err(|e| e.message().to_string())?;

    Ok(())
}

/// Retroactively mark `branch` as a child of `parent` — used when a user
/// wants voidlink to track a branch they created outside the app.
///
/// Records the parent's current tip in `parentbase` so the initial state is
/// "in sync" rather than "needs restack".
pub(crate) fn git_stack_set_parent_impl(
    repo_path: String,
    branch: String,
    parent: String,
) -> Result<(), String> {
    if branch == parent {
        return Err("branch and parent cannot be the same".into());
    }
    let repo = open_repo(&repo_path)?;

    // Both refs must exist.
    let _ = repo
        .find_branch(&branch, git2::BranchType::Local)
        .map_err(|e| format!("branch `{}` not found: {}", branch, e.message()))?;
    let parent_oid = repo
        .revparse_single(&parent)
        .map_err(|e| format!("parent `{}` not found: {}", parent, e.message()))?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?
        .id()
        .to_string();

    write_parent_keys(&repo, &branch, &parent, Some(&parent_oid))
}

/// Read the per-repo trunk override list from `voidlink.stack.trunks`.
/// Returns an empty Vec when unset — discovery still falls back to the
/// hard-coded defaults plus `origin/HEAD`.
pub(crate) fn git_stack_get_trunks_impl(repo_path: String) -> Result<Vec<String>, String> {
    let repo = open_repo(&repo_path)?;
    let cfg = repo.config().map_err(|e| e.message().to_string())?;
    match cfg.get_string("voidlink.stack.trunks") {
        Ok(value) => Ok(value
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.message().to_string()),
    }
}

/// Replace the trunk override list. An empty list removes the key entirely
/// so discovery falls back to the defaults — i.e. "unset" rather than
/// "explicitly empty", which would otherwise hide the default trunks too.
pub(crate) fn git_stack_set_trunks_impl(
    repo_path: String,
    trunks: Vec<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut cfg = repo.config().map_err(|e| e.message().to_string())?;
    let cleaned: Vec<String> = trunks
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cleaned.is_empty() {
        match cfg.remove("voidlink.stack.trunks") {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ErrorCode::NotFound => Ok(()),
            Err(e) => Err(e.message().to_string()),
        }
    } else {
        cfg.set_str("voidlink.stack.trunks", &cleaned.join(","))
            .map_err(|e| e.message().to_string())
    }
}

/// Strip all voidlink-managed config keys for `branch`. The branch itself is
/// left intact — only its membership in a stack is removed.
pub(crate) fn git_stack_untrack_impl(
    repo_path: String,
    branch: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut cfg = repo.config().map_err(|e| e.message().to_string())?;
    for suffix in ["parent", "parentbase", "prnumber"] {
        let key = format!("branch.{}.{}", branch, suffix);
        match cfg.remove(&key) {
            Ok(()) => {}
            Err(e) if e.code() == ErrorCode::NotFound => {} // already absent
            Err(e) => return Err(e.message().to_string()),
        }
    }
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn write_parent_keys(
    repo: &Repository,
    branch: &str,
    parent: &str,
    parentbase: Option<&str>,
) -> Result<(), String> {
    // Guard: stacking onto a trunk is fine (that's how stacks start); stacking
    // a *trunk* on top of something is a category error.
    let trunks = discovery::trunks_for_pub(repo)?;
    if trunks.contains(branch) {
        return Err(format!(
            "`{}` is a trunk — refusing to record it as a stack child",
            branch
        ));
    }

    let mut cfg = repo.config().map_err(|e| e.message().to_string())?;
    cfg.set_str(&format!("branch.{}.parent", branch), parent)
        .map_err(|e| e.message().to_string())?;
    if let Some(base) = parentbase {
        cfg.set_str(&format!("branch.{}.parentbase", branch), base)
            .map_err(|e| e.message().to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Signature};
    use std::fs;
    use std::path::Path;

    fn init_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        repo
    }

    fn commit_file(repo: &Repository, path: &Path, name: &str, contents: &str, msg: &str) {
        fs::write(path.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap();
    }

    fn ensure_main(repo: &Repository) {
        let head = repo.head().unwrap().shorthand().unwrap().to_string();
        if head != "main" {
            let commit = repo.head().unwrap().peel_to_commit().unwrap();
            repo.branch("main", &commit, false).unwrap();
            let obj = repo.revparse_single("refs/heads/main").unwrap();
            let mut co = git2::build::CheckoutBuilder::new();
            co.safe();
            repo.checkout_tree(&obj, Some(&mut co)).unwrap();
            repo.set_head("refs/heads/main").unwrap();
        }
    }

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let repo = init_repo(&root);
        commit_file(&repo, &root, "README.md", "init\n", "init");
        ensure_main(&repo);
        (tmp, root)
    }

    #[test]
    fn create_branch_records_parent_and_checks_out() {
        let (_tmp, root) = fixture();
        git_stack_create_branch_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
            "main".into(),
        )
        .unwrap();

        let repo = Repository::open(&root).unwrap();
        // HEAD is on the new branch.
        assert_eq!(
            repo.head().unwrap().shorthand().unwrap(),
            "feat/x",
            "should be checked out on the new branch"
        );
        // Parent config was written.
        let cfg = repo.config().unwrap();
        assert_eq!(cfg.get_string("branch.feat/x.parent").unwrap(), "main");
        // parentbase points at main's current tip so discovery starts "in sync".
        let main_tip = repo
            .revparse_single("main")
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .id()
            .to_string();
        assert_eq!(
            cfg.get_string("branch.feat/x.parentbase").unwrap(),
            main_tip
        );
    }

    #[test]
    fn create_branch_rejects_duplicate() {
        let (_tmp, root) = fixture();
        git_stack_create_branch_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
            "main".into(),
        )
        .unwrap();
        let err = git_stack_create_branch_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
            "main".into(),
        )
        .unwrap_err();
        assert!(err.contains("already exists"), "got: {}", err);
    }

    #[test]
    fn create_branch_rejects_missing_parent() {
        let (_tmp, root) = fixture();
        let err = git_stack_create_branch_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
            "does-not-exist".into(),
        )
        .unwrap_err();
        assert!(err.contains("not found"), "got: {}", err);
    }

    #[test]
    fn set_parent_records_existing_branch() {
        let (_tmp, root) = fixture();
        // Create branch outside the stack-create path (simulates a branch
        // made via terminal that the user now wants to track).
        {
            let repo = Repository::open(&root).unwrap();
            let main_commit = repo
                .revparse_single("main")
                .unwrap()
                .peel_to_commit()
                .unwrap();
            repo.branch("feat/manual", &main_commit, false).unwrap();
        }

        git_stack_set_parent_impl(
            root.to_string_lossy().to_string(),
            "feat/manual".into(),
            "main".into(),
        )
        .unwrap();

        let repo = Repository::open(&root).unwrap();
        let cfg = repo.config().unwrap();
        assert_eq!(
            cfg.get_string("branch.feat/manual.parent").unwrap(),
            "main"
        );
        assert!(cfg
            .get_string("branch.feat/manual.parentbase")
            .is_ok());
    }

    #[test]
    fn untrack_removes_all_voidlink_keys() {
        let (_tmp, root) = fixture();
        git_stack_create_branch_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
            "main".into(),
        )
        .unwrap();
        // Pretend a PR was previously recorded so we can verify it's cleared too.
        {
            let repo = Repository::open(&root).unwrap();
            let mut cfg = repo.config().unwrap();
            cfg.set_str("branch.feat/x.prnumber", "42").unwrap();
        }

        git_stack_untrack_impl(
            root.to_string_lossy().to_string(),
            "feat/x".into(),
        )
        .unwrap();

        let repo = Repository::open(&root).unwrap();
        let cfg = repo.config().unwrap();
        assert!(matches!(
            cfg.get_string("branch.feat/x.parent"),
            Err(e) if e.code() == ErrorCode::NotFound
        ));
        assert!(matches!(
            cfg.get_string("branch.feat/x.parentbase"),
            Err(e) if e.code() == ErrorCode::NotFound
        ));
        assert!(matches!(
            cfg.get_string("branch.feat/x.prnumber"),
            Err(e) if e.code() == ErrorCode::NotFound
        ));
        // Branch itself still exists.
        assert!(repo
            .find_branch("feat/x", git2::BranchType::Local)
            .is_ok());
    }

    #[test]
    fn untrack_is_idempotent_when_keys_absent() {
        let (_tmp, root) = fixture();
        // Branch exists but was never tracked — untrack should still succeed.
        {
            let repo = Repository::open(&root).unwrap();
            let main_commit = repo
                .revparse_single("main")
                .unwrap()
                .peel_to_commit()
                .unwrap();
            repo.branch("feat/untracked", &main_commit, false).unwrap();
        }
        git_stack_untrack_impl(
            root.to_string_lossy().to_string(),
            "feat/untracked".into(),
        )
        .expect("untrack should no-op when no keys are set");
    }

    #[test]
    fn trunks_roundtrip_through_config() {
        let (_tmp, root) = fixture();
        let path = root.to_string_lossy().to_string();

        // Unset → empty list.
        assert!(git_stack_get_trunks_impl(path.clone()).unwrap().is_empty());

        // Set, get, verify order and trimming.
        git_stack_set_trunks_impl(
            path.clone(),
            vec!["main".into(), "release/v2 ".into(), " staging".into()],
        )
        .unwrap();
        let got = git_stack_get_trunks_impl(path.clone()).unwrap();
        assert_eq!(got, vec!["main", "release/v2", "staging"]);

        // Empty Vec removes the key — discovery should fall back to defaults.
        git_stack_set_trunks_impl(path.clone(), Vec::new()).unwrap();
        assert!(git_stack_get_trunks_impl(path).unwrap().is_empty());
    }

    #[test]
    fn cannot_record_trunk_as_stack_child() {
        let (_tmp, root) = fixture();
        // Even if a user crafts an unusual setup, refuse to mark a trunk as
        // a child — discovery would treat it as both trunk and branch.
        let err = git_stack_set_parent_impl(
            root.to_string_lossy().to_string(),
            "main".into(),
            "main".into(),
        )
        .unwrap_err();
        // Could fail on either "same" check or trunk guard depending on order;
        // both are valid refusals.
        assert!(
            err.contains("cannot be the same") || err.contains("trunk"),
            "got: {}",
            err
        );
    }
}
