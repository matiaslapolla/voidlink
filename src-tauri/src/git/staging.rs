use std::path::Path;

use serde::{Deserialize, Serialize};

use super::repo::open_repo;

/// Who a commit is attributed to.
///
/// Both fields are required: git rejects an empty name or email, and a
/// half-filled identity is a mistake we would rather catch here than let
/// libgit2 report as a cryptic signature error.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

impl CommitIdentity {
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("author name cannot be empty".to_string());
        }
        if self.email.trim().is_empty() {
            return Err("author email cannot be empty".to_string());
        }
        // git stores these inside `Name <email>`, so a stray angle bracket or
        // newline would corrupt the commit header.
        for (field, value) in [("name", &self.name), ("email", &self.email)] {
            if value.contains('<') || value.contains('>') || value.contains('\n') {
                return Err(format!("author {field} cannot contain <, > or a newline"));
            }
        }
        Ok(())
    }
}

/// Build a signature from an explicit identity, validating it first.
/// Shared with the amend path in `reset.rs`.
pub(crate) fn signature_for(identity: &CommitIdentity) -> Result<git2::Signature<'static>, String> {
    identity.validate()?;
    git2::Signature::now(identity.name.trim(), identity.email.trim())
        .map_err(|e| e.message().to_string())
}

/// A signature for a housekeeping object (a stash, an annotated tag) when the
/// user has no `user.name` configured.
///
/// A commit must be attributed honestly, so `resolve_signature` still fails
/// loudly there. But refusing to *stash* because git config is empty is a
/// pointless wall in front of an operation whose author nobody ever reads —
/// `safe_checkout` already synthesized one for exactly that reason, and this is
/// that behaviour made shared rather than copied.
pub(crate) fn housekeeping_signature(
    repo: &git2::Repository,
) -> Result<git2::Signature<'static>, String> {
    match repo.signature() {
        Ok(sig) => git2::Signature::now(
            sig.name().unwrap_or("voidlink"),
            sig.email().unwrap_or("voidlink@local"),
        )
        .map_err(|e| e.message().to_string()),
        Err(_) => git2::Signature::now("voidlink", "voidlink@local")
            .map_err(|e| e.message().to_string()),
    }
}

/// The signature a commit should carry.
///
/// With no override this is `repo.signature()` — exactly what plain `git
/// commit` would use, honouring the full config cascade (repo → global →
/// system). An override replaces *both* author and committer, which is what
/// `git -c user.name=… -c user.email=…` does and what someone switching
/// between a work and a personal identity expects.
fn resolve_signature<'a>(
    repo: &'a git2::Repository,
    identity: Option<&CommitIdentity>,
) -> Result<git2::Signature<'a>, String> {
    match identity {
        Some(id) => signature_for(id),
        None => repo.signature().map_err(|e| {
            // The default message here is "config value 'user.name' was not
            // found", which does not tell a GUI user what to do about it.
            format!(
                "{} — set an author in the commit box, or run `git config user.name` and `user.email`",
                e.message()
            )
        }),
    }
}

/// Read the identity git would use for a commit in this repository, without
/// committing anything. Feeds the commit box's author fields so an override
/// starts from the real default rather than an empty form.
pub(crate) fn git_config_identity_impl(
    repo_path: String,
) -> Result<Option<CommitIdentity>, String> {
    let repo = open_repo(&repo_path)?;
    Ok(repo.signature().ok().and_then(|sig| {
        match (sig.name(), sig.email()) {
            (Some(name), Some(email)) => Some(CommitIdentity {
                name: name.to_string(),
                email: email.to_string(),
            }),
            _ => None,
        }
    }))
}

pub(crate) fn git_stage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();
    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    for path_str in &paths {
        let rel = Path::new(path_str);
        let abs = workdir.join(rel);
        // `symlink_metadata` rather than `exists()`: a staged symlink whose
        // target is gone still needs staging as a symlink, not recording as a
        // deletion. And the deletion branch uses `update_all`, which reads the
        // working tree itself instead of trusting our own earlier answer — the
        // old `exists()` + `remove_path` pair raced the status read, so a file
        // recreated between the two got staged as deleted.
        if abs.symlink_metadata().is_ok() {
            index.add_path(rel).map_err(|e| e.message().to_string())?;
        } else {
            index
                .update_all([rel].iter(), None)
                .map_err(|e| e.message().to_string())?;
        }
    }

    super::locking::write_index(&repo_path, &mut index)?;
    Ok(())
}

pub(crate) fn git_stage_all_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    super::locking::write_index(&repo_path, &mut index)?;
    Ok(())
}

/// Unstage paths: restore each index entry from HEAD, or drop it when HEAD has
/// no such file.
///
/// This used to hand-build an `IndexEntry` with `flags: 0`, which was wrong in
/// two ways. On a conflicted path it wrote a stage-0 entry *on top of* stages
/// 1–3 instead of replacing them, leaving a mixed index that git tools then
/// disagreed about. And the zeroed `ctime`/`mtime`/`file_size` defeated the
/// index's stat cache, so the next status scan re-hashed the file and the row
/// flickered between "modified" and clean.
///
/// `reset_default` is libgit2's own path for this — the same call `git reset
/// <paths>` makes — so the entry comes back with correct stat data, and
/// `conflict_remove` drops all three conflict stages first so nothing mixes.
pub(crate) fn git_unstage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let head_object = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.into_object());
    let head_tree = match &head_object {
        Some(obj) => obj.peel_to_tree().ok(),
        None => None,
    };

    // Conflict stages first: reset_default writes stage 0, and any stage 1–3
    // entry left over from a conflict would survive next to it.
    {
        let mut index = repo.index().map_err(|e| e.message().to_string())?;
        let mut touched = false;
        for path_str in &paths {
            let rel = Path::new(path_str);
            // git2 0.19 exposes no `conflict_remove`, so drop the three stages
            // by hand. All of them: leaving any behind is exactly the mixed-index
            // state this is here to prevent.
            for stage in 1..=3 {
                if index.get_path(rel, stage).is_some() {
                    index
                        .remove(rel, stage)
                        .map_err(|e| e.message().to_string())?;
                    touched = true;
                }
            }
        }
        if touched {
            super::locking::write_index(&repo_path, &mut index)?;
        }
    }

    // Split by whether HEAD knows the path: known paths are restored from the
    // HEAD tree, unknown ones (a newly added file) leave the index entirely.
    let mut from_head: Vec<&str> = Vec::new();
    let mut drop_entirely: Vec<&str> = Vec::new();
    for path_str in &paths {
        let in_head = head_tree
            .as_ref()
            .is_some_and(|t| t.get_path(Path::new(path_str)).is_ok());
        if in_head {
            from_head.push(path_str);
        } else {
            drop_entirely.push(path_str);
        }
    }

    if !from_head.is_empty() {
        let target = head_object
            .as_ref()
            .ok_or_else(|| "no HEAD commit to unstage against".to_string())?;
        super::locking::retry_on_lock(&repo_path, || {
            repo.reset_default(Some(target), from_head.iter())
                .map_err(|e| e.message().to_string())
        })?;
    }
    if !drop_entirely.is_empty() {
        super::locking::retry_on_lock(&repo_path, || {
            repo.reset_default(None, drop_entirely.iter())
                .map_err(|e| e.message().to_string())
        })?;
    }

    Ok(())
}

/// Commit the index.
///
/// Carries the *whole* parent set, not just HEAD: when a merge, cherry-pick or
/// revert stopped for the user to resolve conflicts, committing is what
/// finishes it, and the other side's head is recorded in `MERGE_HEAD` /
/// `CHERRY_PICK_HEAD` / `REVERT_HEAD`. Committing with HEAD alone produced a
/// single-parent commit that silently dropped the merged history *and* left the
/// marker files in place, so the operation banner claimed a merge was still in
/// progress forever.
pub(crate) fn git_commit_impl(
    repo_path: String,
    message: String,
    identity: Option<CommitIdentity>,
) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    super::opstate::ensure_commit_allowed(&repo)?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    if index.has_conflicts() {
        return Err(
            "the index still has conflicts — resolve every conflicted file before committing"
                .to_string(),
        );
    }

    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| e.message().to_string())?;
    let sig = resolve_signature(&repo, identity.as_ref())?;

    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let pending = super::opstate::pending_parent_oids(&repo)?;
    let mut extra = Vec::new();
    for oid in pending {
        // Skip a head that is already HEAD (a no-op merge) so we never write a
        // commit listing the same parent twice.
        if head_commit.as_ref().is_some_and(|c| c.id() == oid) {
            continue;
        }
        extra.push(
            repo.find_commit(oid)
                .map_err(|e| format!("merge parent {oid} is missing: {}", e.message()))?,
        );
    }

    let mut parents: Vec<&git2::Commit> = head_commit.iter().collect();
    parents.extend(extra.iter());

    let oid = super::locking::retry_on_lock(&repo_path, || {
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
            .map_err(|e| e.message().to_string())
    })?;

    // The commit consumed the markers; leaving them behind is what wedged the
    // banner. Only after the commit landed, so a failed commit is still
    // resumable.
    super::opstate::clear_merge_markers(&repo)?;

    Ok(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str, email: &str) -> CommitIdentity {
        CommitIdentity {
            name: name.to_string(),
            email: email.to_string(),
        }
    }

    #[test]
    fn accepts_a_normal_identity() {
        assert!(id("Ada Lovelace", "ada@example.com").validate().is_ok());
    }

    #[test]
    fn rejects_blank_fields() {
        assert!(id("", "ada@example.com").validate().is_err());
        assert!(id("   ", "ada@example.com").validate().is_err());
        assert!(id("Ada", "").validate().is_err());
        assert!(id("Ada", "  ").validate().is_err());
    }

    #[test]
    fn rejects_characters_that_would_corrupt_the_commit_header() {
        // `Name <email>` is the on-disk format, so these would break parsing.
        assert!(id("Ada <hax>", "ada@example.com").validate().is_err());
        assert!(id("Ada", "ada@example.com>").validate().is_err());
        assert!(id("Ada\nCommitter: Eve", "ada@example.com").validate().is_err());
    }

    #[test]
    fn finishing_a_merge_writes_two_parents_and_clears_the_merge_state() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, theirs) = crate::git::testfix::start_conflicted_merge(tmp.path());
        let path = tmp.path().to_string_lossy().to_string();

        // A conflicted index must refuse the commit outright.
        let err = git_commit_impl(path.clone(), "merge".to_string(), None).unwrap_err();
        assert!(err.contains("conflicts"), "got: {err}");

        // Resolve, then finish the merge the way the UI does: a plain commit.
        crate::git::testfix::write_file(tmp.path(), "a.txt", "resolved\n");
        git_stage_files_impl(path.clone(), vec!["a.txt".to_string()]).unwrap();
        let oid = git_commit_impl(path.clone(), "merge theirs".to_string(), None).unwrap();

        let commit = repo.find_commit(git2::Oid::from_str(&oid).unwrap()).unwrap();
        assert_eq!(
            commit.parent_count(),
            2,
            "a merge commit that drops the second parent loses that history"
        );
        assert!(commit.parent_ids().any(|p| p == theirs));
        assert!(
            !repo.path().join("MERGE_HEAD").exists(),
            "MERGE_HEAD left behind is what wedged the operation banner forever"
        );
        assert!(!repo.path().join("MERGE_MSG").exists());
        assert_eq!(crate::git::opstate::operation_name(&repo), None);
    }

    #[test]
    fn unstaging_a_conflicted_path_leaves_no_stray_stages() {
        let tmp = tempfile::tempdir().unwrap();
        let (repo, _theirs) = crate::git::testfix::start_conflicted_merge(tmp.path());
        let path = tmp.path().to_string_lossy().to_string();

        crate::git::testfix::write_file(tmp.path(), "a.txt", "resolved\n");
        git_stage_files_impl(path.clone(), vec!["a.txt".to_string()]).unwrap();
        git_unstage_files_impl(path.clone(), vec!["a.txt".to_string()]).unwrap();

        // Our handle cached the index before the impl rewrote it on disk.
        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        assert!(
            !index.has_conflicts(),
            "unstaging must clear stages 1-3, not write stage 0 next to them"
        );
        assert!(
            index.get_path(Path::new("a.txt"), 0).is_some(),
            "the HEAD version comes back at stage 0"
        );

        // With the working file matching HEAD again, the restored entry must
        // carry real stat data — the old hand-built entry zeroed ctime/mtime/size,
        // which defeated the index stat cache and made the row flap between
        // "modified" and clean on every status scan.
        crate::git::testfix::write_file(tmp.path(), "a.txt", "ours\n");
        let path = tmp.path().to_string_lossy().to_string();
        git_stage_files_impl(path.clone(), vec!["a.txt".to_string()]).unwrap();
        git_unstage_files_impl(path, vec!["a.txt".to_string()]).unwrap();
        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
        assert_ne!(entry.file_size, 0, "stat data must be real, not zeroed");
    }

    #[test]
    fn concurrent_staging_calls_both_succeed_under_the_repo_lock() {
        // Without the per-repo lock these two interleave inside libgit2's
        // read-modify-write of the index and one of them loses its entry (or
        // fails outright on index.lock).
        let tmp = tempfile::tempdir().unwrap();
        let repo = crate::git::testfix::init_repo(tmp.path());
        crate::git::testfix::write_file(tmp.path(), "seed.txt", "seed\n");
        crate::git::testfix::commit_all(&repo, "seed");
        crate::git::testfix::write_file(tmp.path(), "one.txt", "1\n");
        crate::git::testfix::write_file(tmp.path(), "two.txt", "2\n");

        let path = tmp.path().to_string_lossy().to_string();
        let locks = crate::git::locking::RepoLocks::default();

        let handles: Vec<_> = ["one.txt", "two.txt"]
            .into_iter()
            .map(|file| {
                let lock = locks.for_repo(&path);
                let path = path.clone();
                std::thread::spawn(move || {
                    let _guard = lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    git_stage_files_impl(path, vec![file.to_string()])
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap().expect("staging under the lock must succeed");
        }

        let mut index = repo.index().unwrap();
        index.read(true).unwrap();
        assert!(index.get_path(Path::new("one.txt"), 0).is_some());
        assert!(index.get_path(Path::new("two.txt"), 0).is_some());
    }

    #[test]
    fn signature_trims_surrounding_whitespace() {
        let sig = signature_for(&id("  Ada Lovelace  ", "  ada@example.com  ")).unwrap();
        assert_eq!(sig.name(), Some("Ada Lovelace"));
        assert_eq!(sig.email(), Some("ada@example.com"));
    }
}
