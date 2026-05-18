use git2::{Signature, StashFlags, StatusOptions};

use super::repo::open_repo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCheckoutResult {
    pub branch: String,
    /// Set when the working tree was dirty and we created an auto-stash before
    /// switching. The frontend can show "Stashed N changes" or offer to pop it
    /// back later. The message is the stash message used by `git stash list`.
    pub auto_stashed: Option<String>,
}

/// Checkout a branch, auto-stashing the working tree if it's dirty so the
/// switch never fails with the unfriendly "your local changes would be
/// overwritten" error. Mirrors the behavior of `git stash --include-untracked
/// && git checkout B`. If `auto_pop` is true and the target branch has a
/// matching auto-stash created against it, we pop it back so the user's
/// changes survive a round-trip.
pub(crate) fn git_safe_checkout_impl(
    repo_path: String,
    branch: String,
    create: bool,
) -> Result<SafeCheckoutResult, String> {
    let mut repo = open_repo(&repo_path)?;

    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    let dirty = is_dirty(&repo)?;
    let auto_stashed = if dirty {
        let from = current_branch.as_deref().unwrap_or("detached");
        let message = format!("voidlink-auto: pre-switch from {} → {}", from, branch);
        let sig = repo
            .signature()
            .or_else(|_| Signature::now("voidlink", "voidlink@local"))
            .map_err(|e| e.message().to_string())?;
        // INCLUDE_UNTRACKED only — *not* KEEP_INDEX. KEEP_INDEX would leave
        // staged changes in the index, and the imminent checkout would then
        // overwrite the index with the target branch's HEAD, silently losing
        // the user's staged work. Stashing everything (staged + unstaged +
        // untracked) makes `git stash pop` a complete round-trip.
        repo.stash_save(&sig, &message, Some(StashFlags::INCLUDE_UNTRACKED))
            .map_err(|e| e.message().to_string())?;
        Some(message)
    } else {
        None
    };

    if create {
        let head_commit = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        repo.branch(&branch, &head_commit, false)
            .map_err(|e| e.message().to_string())?;
    }

    let treeish = repo
        .revparse_single(&format!("refs/heads/{}", branch))
        .map_err(|e| e.message().to_string())?;

    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder.safe();
    repo.checkout_tree(&treeish, Some(&mut checkout_builder))
        .map_err(|e| e.message().to_string())?;

    repo.set_head(&format!("refs/heads/{}", branch))
        .map_err(|e| e.message().to_string())?;

    Ok(SafeCheckoutResult {
        branch,
        auto_stashed,
    })
}

fn is_dirty(repo: &git2::Repository) -> Result<bool, String> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;
    Ok(!statuses.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Repository};
    use std::fs;

    fn init_repo(path: &std::path::Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        repo
    }

    fn commit_all(repo: &Repository, msg: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap()
    }

    #[test]
    fn auto_stash_preserves_both_staged_and_unstaged_changes() {
        // The original implementation used StashFlags::KEEP_INDEX, which left
        // staged changes in the index; the checkout then silently overwrote
        // them. This test would fail loudly if that regression returned.
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        let file_a = tmp.path().join("a.txt");
        fs::write(&file_a, "original\n").unwrap();
        commit_all(&repo, "init");

        // Create a second branch off main.
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &head, false).unwrap();

        // Modify a.txt, stage the change.
        fs::write(&file_a, "staged change\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        // Then modify it again — now there's a staged version AND an
        // unstaged-on-top version.
        fs::write(&file_a, "unstaged change\n").unwrap();

        let result = git_safe_checkout_impl(
            tmp.path().to_string_lossy().to_string(),
            "other".to_string(),
            false,
        )
        .unwrap();
        assert!(result.auto_stashed.is_some(), "dirty tree should have stashed");

        // After checkout the working file is the original from `other` branch.
        let after = fs::read_to_string(&file_a).unwrap();
        assert_eq!(after, "original\n");

        // Now pop the stash. Both the staged AND unstaged changes should
        // come back — with KEEP_INDEX the staged change would be lost.
        let mut repo_mut = Repository::open(tmp.path()).unwrap();
        let mut opts = git2::StashApplyOptions::new();
        repo_mut.stash_pop(0, Some(&mut opts)).unwrap();

        let recovered = fs::read_to_string(&file_a).unwrap();
        assert_eq!(
            recovered, "unstaged change\n",
            "the user's most recent on-disk content must come back — anything else \
             is silent data loss. (Plain `git stash pop` collapses staged + unstaged \
             into the working tree, matching CLI git behavior; the user can re-stage.)"
        );
    }
}
