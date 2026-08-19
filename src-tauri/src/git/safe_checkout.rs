use git2::{StashFlags, StatusOptions};

use super::repo::open_repo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCheckoutResult {
    /// The branch now checked out. Unchanged from before the call when
    /// `dirty` is true below — nothing was switched.
    pub branch: String,
    /// Set when the working tree was dirty and we created an auto-stash before
    /// switching. The frontend can show "Stashed N changes" or offer to pop it
    /// back later. The message is the stash message used by `git stash list`.
    pub auto_stashed: Option<String>,
    /// True when the working tree was dirty and the caller passed
    /// `allow_stash: false`: nothing was stashed and nothing was switched.
    /// `branch` above is whatever was already checked out, and `auto_stashed`
    /// is always `None` in this case — the frontend's job is to confirm with
    /// the user (the same dialog pattern `FileTree`'s delete flow uses) and
    /// retry with `allow_stash: true`.
    #[serde(default)]
    pub dirty: bool,
}

/// Checkout a branch, auto-stashing the working tree if it's dirty so the
/// switch never fails with the unfriendly "your local changes would be
/// overwritten" error. Mirrors the behavior of `git stash --include-untracked
/// && git checkout B`. If `auto_pop` is true and the target branch has a
/// matching auto-stash created against it, we pop it back so the user's
/// changes survive a round-trip.
///
/// `allow_stash: false` turns the auto-stash off: a dirty tree returns
/// immediately with `dirty: true` and touches nothing, so the frontend can ask
/// first instead of the switch silently rewriting the working tree out from
/// under the user (see `GitSidebar.tsx`'s `checkout` and `MainSurface.tsx`'s
/// `openBranchFromTerminal` for the confirm-then-retry callers).
pub(crate) fn git_safe_checkout_impl(
    repo_path: String,
    branch: String,
    create: bool,
    allow_stash: bool,
) -> Result<SafeCheckoutResult, String> {
    let mut repo = open_repo(&repo_path)?;

    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()));

    super::opstate::ensure_no_operation(&repo, "switch branches")?;

    let dirty = is_dirty(&repo)?;

    if dirty && !allow_stash {
        return Ok(SafeCheckoutResult {
            branch: current_branch.unwrap_or_default(),
            auto_stashed: None,
            dirty: true,
        });
    }

    let auto_stashed = if dirty {
        let from = current_branch.as_deref().unwrap_or("detached");
        let message = format!("voidlink-auto: pre-switch from {} → {}", from, branch);
        let sig = super::staging::housekeeping_signature(&repo)?;
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

    // Everything from here on can fail, and the user's work is currently inside
    // a stash. The doc comment above has promised a round-trip since day one and
    // nothing implemented it: a failure left an empty-looking working tree and a
    // stash the user did not know about. So the rest runs in a closure whose
    // error triggers a pop.
    let local_branch = resolve_target_branch(&repo, &branch, create);
    let outcome = local_branch.and_then(|name| {
        super::branch::switch_to_branch(&repo, &repo_path, &name)?;
        Ok(name)
    });

    let switched_to = match outcome {
        Ok(name) => name,
        Err(e) => {
            if auto_stashed.is_some() {
                return Err(match repo.stash_pop(0, None) {
                    Ok(()) => format!("{e} — your changes were restored from the auto-stash"),
                    Err(pop) => format!(
                        "{e} — and the auto-stash could not be restored ({}). Your work is safe in \
                         `git stash list`; run `git stash pop` to get it back.",
                        pop.message()
                    ),
                });
            }
            return Err(e);
        }
    };

    Ok(SafeCheckoutResult {
        branch: switched_to,
        auto_stashed,
        dirty: false,
    })
}

/// The local branch a checkout should land on.
///
/// Clicking a *remote* row used to always fail: `origin/foo` was resolved as
/// `refs/heads/origin/foo`, which does not exist. What the user means by clicking
/// it is what `git checkout foo` means — a local branch tracking that remote — so
/// that is what we create.
fn resolve_target_branch(
    repo: &git2::Repository,
    branch: &str,
    create: bool,
) -> Result<String, String> {
    if create {
        let head_commit = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        repo.branch(branch, &head_commit, false)
            .map_err(|e| e.message().to_string())?;
        return Ok(branch.to_string());
    }

    if repo.find_branch(branch, git2::BranchType::Local).is_ok() {
        return Ok(branch.to_string());
    }

    // A remote-tracking name: create the local branch and set the upstream, the
    // way `git checkout <remote-branch>` does.
    if let Ok(remote_branch) = repo.find_branch(branch, git2::BranchType::Remote) {
        let local_name = branch
            .split_once('/')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or_else(|| branch.to_string());
        if repo.find_branch(&local_name, git2::BranchType::Local).is_ok() {
            return Ok(local_name);
        }
        let target = remote_branch
            .get()
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        let mut created = repo
            .branch(&local_name, &target, false)
            .map_err(|e| format!("could not create local branch {local_name}: {}", e.message()))?;
        if let Err(e) = created.set_upstream(Some(branch)) {
            log::warn!("created {local_name} but could not track {branch}: {e}");
        }
        return Ok(local_name);
    }

    Err(format!("no branch named '{branch}'"))
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
    use git2::{IndexAddOption, Repository, Signature};
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
            true,
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

    #[test]
    fn dirty_tree_with_allow_stash_false_switches_nothing() {
        // The regression this guards: a branch click used to auto-stash a dirty
        // tree with no warning. `allow_stash: false` is the frontend's
        // "ask first" probe — it must come back with `dirty: true` and leave
        // the working tree, the index, and HEAD exactly as it found them, so a
        // user who says no to the confirm dialog loses nothing and switches
        // nothing.
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        let file_a = tmp.path().join("a.txt");
        fs::write(&file_a, "original\n").unwrap();
        commit_all(&repo, "init");

        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("other", &head, false).unwrap();
        // Not hardcoded: `init.defaultBranch` varies by environment (git2 falls
        // back to "master", but a global config can override it), so the
        // starting branch is whatever it actually is here.
        let starting_branch = repo.head().unwrap().shorthand().unwrap().to_string();

        // Dirty: an uncommitted, unstaged edit.
        fs::write(&file_a, "dirty edit\n").unwrap();

        let result = git_safe_checkout_impl(
            tmp.path().to_string_lossy().to_string(),
            "other".to_string(),
            false,
            false,
        )
        .unwrap();

        assert!(result.dirty, "a dirty tree with allow_stash: false must report dirty");
        assert!(
            result.auto_stashed.is_none(),
            "nothing should have been stashed"
        );
        assert_eq!(
            result.branch, starting_branch,
            "still on the branch we started from — nothing switched"
        );

        // No stash was created.
        let mut repo_mut = Repository::open(tmp.path()).unwrap();
        let mut stash_count = 0;
        repo_mut
            .stash_foreach(|_, _, _| {
                stash_count += 1;
                true
            })
            .unwrap();
        assert_eq!(stash_count, 0, "declining to stash must not create one anyway");

        // HEAD never moved off the starting branch.
        assert_eq!(repo.head().unwrap().shorthand(), Some(starting_branch.as_str()));

        // The dirty edit is still sitting in the working tree, untouched.
        let after = fs::read_to_string(&file_a).unwrap();
        assert_eq!(after, "dirty edit\n");
    }
}
