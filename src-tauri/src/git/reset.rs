use git2::ResetType;

use super::repo::open_repo;

/// Amend the most recent commit: re-commit the current index tree onto HEAD's
/// parents, optionally replacing the message. Author and committer are
/// preserved when `message` is None (and the original message kept too).
pub(crate) fn git_amend_impl(
    repo_path: String,
    message: Option<String>,
    identity: Option<super::staging::CommitIdentity>,
) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    // Amending mid-rebase rewrites the commit the sequence is standing on and
    // corrupts the rest of it.
    super::opstate::ensure_no_operation(&repo, "amend")?;
    let head_commit = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;

    // `None` keeps the original commit's author and committer, which is the
    // right default for an amend — you are fixing your own commit, not
    // reattributing it. An explicit identity overrides both.
    let sig = match identity {
        Some(id) => Some(super::staging::signature_for(&id)?),
        None => None,
    };

    let msg = message.as_deref().filter(|m| !m.trim().is_empty());
    let new_oid = head_commit
        .amend(Some("HEAD"), sig.as_ref(), sig.as_ref(), None, msg, Some(&tree))
        .map_err(|e| e.message().to_string())?;
    Ok(new_oid.to_string())
}

/// Undo the last commit, keeping its changes staged (soft reset to HEAD~1).
///
/// Refuses a merge commit. `head.parent(0)` would quietly pick the first parent
/// and reset to it, which does not "undo the merge" — it throws away the second
/// parent's line of history from HEAD while leaving its content staged, a state
/// no user asked for and one git itself makes you spell out (`git reset --hard
/// ORIG_HEAD`, `git revert -m`).
pub(crate) fn git_undo_last_commit_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    super::opstate::ensure_no_operation(&repo, "undo the last commit")?;
    let head = repo
        .head()
        .map_err(|e| e.message().to_string())?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;

    if head.parent_count() > 1 {
        return Err(format!(
            "HEAD is a merge commit with {} parents — undoing it would drop one side's history. \
             Use a reset to a specific commit, or revert the merge instead.",
            head.parent_count()
        ));
    }

    let parent = head
        .parent(0)
        .map_err(|_| "this is the first commit — there is nothing to undo to".to_string())?;
    super::locking::retry_on_lock(&repo_path, || {
        repo.reset(parent.as_object(), ResetType::Soft, None)
            .map_err(|e| e.message().to_string())
    })
}

/// Reset HEAD (and optionally index/working tree) to `target`. `mode` is
/// "soft" | "mixed" | "hard". Hard is destructive — the UI guards it.
pub(crate) fn git_reset_impl(
    repo_path: String,
    target: String,
    mode: String,
) -> Result<(), String> {
    // An unrecognized mode used to fall through to Mixed, so a typo or a future
    // caller's "keep" silently did something the user did not ask for.
    let kind = match mode.as_str() {
        "soft" => ResetType::Soft,
        "mixed" => ResetType::Mixed,
        "hard" => ResetType::Hard,
        other => {
            return Err(format!(
                "unknown reset mode '{other}' — expected soft, mixed or hard"
            ))
        }
    };

    let repo = open_repo(&repo_path)?;
    // A soft/mixed reset mid-operation leaves the operation half-applied against
    // a different HEAD. A hard reset is the opposite case: it is *how* you get
    // out of a stuck operation, so it is allowed and cleans up after itself.
    if kind != ResetType::Hard {
        super::opstate::ensure_no_operation(&repo, "reset")?;
    }

    let obj = repo
        .revparse_single(&target)
        .map_err(|e| format!("could not resolve '{target}': {}", e.message()))?;

    super::locking::retry_on_lock(&repo_path, || {
        repo.reset(&obj, kind, None)
            .map_err(|e| e.message().to_string())
    })?;

    if kind == ResetType::Hard {
        // Without this, `MERGE_HEAD` / `rebase-merge/` survived the reset and the
        // operation banner kept insisting a merge was in progress — after the
        // very action the user took to get rid of it.
        super::opstate::clear_all_in_progress(&repo)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Repository, Signature};

    fn repo_with_one_commit(path: &std::path::Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        let tree_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("a.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        {
            let tree = repo.find_tree(tree_oid).unwrap();
            let sig = Signature::now("test", "test@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
                .unwrap();
        }
        repo
    }

    #[test]
    fn an_unknown_mode_is_refused_rather_than_treated_as_mixed() {
        let tmp = tempfile::tempdir().unwrap();
        repo_with_one_commit(tmp.path());
        let err = git_reset_impl(
            tmp.path().to_string_lossy().to_string(),
            "HEAD".to_string(),
            "keep".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("unknown reset mode"), "got: {err}");
    }

    #[test]
    fn a_hard_reset_clears_the_in_progress_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_one_commit(tmp.path());
        let head = repo.head().unwrap().target().unwrap();
        std::fs::write(repo.path().join("MERGE_HEAD"), format!("{head}\n")).unwrap();
        std::fs::create_dir_all(repo.path().join("rebase-merge")).unwrap();

        git_reset_impl(
            tmp.path().to_string_lossy().to_string(),
            "HEAD".to_string(),
            "hard".to_string(),
        )
        .unwrap();

        assert!(!repo.path().join("MERGE_HEAD").exists());
        assert!(!repo.path().join("rebase-merge").exists());
    }

    #[test]
    fn undo_refuses_a_merge_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = repo_with_one_commit(tmp.path());
        let base = repo.head().unwrap().peel_to_commit().unwrap();

        // A side commit to merge in, then a two-parent commit on HEAD.
        std::fs::write(tmp.path().join("b.txt"), "two\n").unwrap();
        let tree_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("b.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        let sig = Signature::now("test", "test@example.com").unwrap();
        {
            let tree = repo.find_tree(tree_oid).unwrap();
            let side_oid = repo
                .commit(None, &sig, &sig, "side", &tree, &[&base])
                .unwrap();
            let side = repo.find_commit(side_oid).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "merge", &tree, &[&base, &side])
                .unwrap();
        }

        let err = git_undo_last_commit_impl(tmp.path().to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("merge commit"), "got: {err}");
    }
}
