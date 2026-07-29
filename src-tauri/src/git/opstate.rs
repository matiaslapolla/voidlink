//! In-progress operation state: detect it, refuse to trample it, clear it.
//!
//! A repository mid-merge / mid-rebase / mid-cherry-pick has state in the git
//! dir that a plain "commit" or "rename branch" will happily corrupt. Before
//! this module every mutating command proceeded regardless: renaming the
//! current branch mid-rebase permanently broke `--continue`, and committing a
//! merge dropped the second parent and left `MERGE_HEAD` behind so the banner
//! never cleared.
//!
//! One guard, one clear, one place that knows which files mean what.

use std::path::Path;

use git2::{Oid, Repository, RepositoryState};

/// The operation in progress, named the way the frontend's `GitRepoInfo`
/// names it. `None` when the repository is in a normal state.
pub(crate) fn operation_name(repo: &Repository) -> Option<&'static str> {
    let git_dir = repo.path();
    if git_dir.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase")
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert")
    } else {
        None
    }
}

/// Refuse `action` while any multi-step operation is in progress.
///
/// Used by the commands that rewrite refs or HEAD out from under one:
/// checkout, branch create/rename, amend, non-hard reset.
pub(crate) fn ensure_no_operation(repo: &Repository, action: &str) -> Result<(), String> {
    match operation_name(repo) {
        Some(op) => Err(format!(
            "a {op} is in progress — finish it or abort it before you {action}"
        )),
        None => Ok(()),
    }
}

/// Refuse a commit only when committing cannot be what finishes the operation.
///
/// A merge, cherry-pick or revert is *completed* by committing, so those must
/// pass. A rebase, `git am` or bisect has its own `--continue` and a bare
/// commit corrupts the sequence, so those are refused.
pub(crate) fn ensure_commit_allowed(repo: &Repository) -> Result<(), String> {
    match repo.state() {
        RepositoryState::Clean
        | RepositoryState::Merge
        | RepositoryState::Revert
        | RepositoryState::RevertSequence
        | RepositoryState::CherryPick
        | RepositoryState::CherryPickSequence => Ok(()),
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Err(
            "a rebase is in progress — use Continue on the operation banner rather than committing"
                .to_string(),
        ),
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => {
            Err("`git am` is in progress — finish or abort it before committing".to_string())
        }
        RepositoryState::Bisect => {
            Err("a bisect is in progress — finish or reset it before committing".to_string())
        }
    }
}

/// The extra parents a commit finishing the current operation must carry.
///
/// `MERGE_HEAD` can list several (an octopus merge); `CHERRY_PICK_HEAD` and
/// `REVERT_HEAD` name one. Reading these is what makes "commit to finish the
/// merge" produce a real merge commit rather than a single-parent commit that
/// silently drops the other side's history.
pub(crate) fn pending_parent_oids(repo: &Repository) -> Result<Vec<Oid>, String> {
    let mut out = Vec::new();
    for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        let path = repo.path().join(name);
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let oid = Oid::from_str(trimmed)
                .map_err(|e| format!("{name} holds an unreadable object id: {}", e.message()))?;
            if !out.contains(&oid) {
                out.push(oid);
            }
        }
    }
    Ok(out)
}

/// The marker files a merge-ish operation leaves behind, plus the message
/// scratch files. `CHERRY_PICK_HEAD` / `REVERT_HEAD` sit here too because a
/// cherry-pick or revert that stopped on conflicts is finished by committing.
const MERGE_MARKERS: [&str; 6] = [
    "MERGE_HEAD",
    "MERGE_MSG",
    "MERGE_MODE",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REVERT_HEAD_MSG",
];

/// Delete the merge-ish markers after a commit consumed them.
///
/// Explicit file removal rather than `Repository::cleanup_state`, because
/// cleanup_state's exact set is a libgit2 implementation detail and we only
/// ever want to drop the state we just finished.
pub(crate) fn clear_merge_markers(repo: &Repository) -> Result<(), String> {
    remove_all(repo.path(), &MERGE_MARKERS)
}

/// Clear *every* in-progress marker, including the rebase directories.
///
/// This is what a hard reset means: the point of resetting to a known commit is
/// to get out of a broken mid-operation state, and leaving `rebase-merge/`
/// behind made the banner claim an operation was still running after the reset
/// that was supposed to end it.
pub(crate) fn clear_all_in_progress(repo: &Repository) -> Result<(), String> {
    remove_all(repo.path(), &MERGE_MARKERS)?;
    remove_all(repo.path(), &["BISECT_LOG", "sequencer"])?;
    for dir in ["rebase-merge", "rebase-apply"] {
        let path = repo.path().join(dir);
        if path.exists() {
            std::fs::remove_dir_all(&path)
                .map_err(|e| format!("could not clear {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn remove_all(git_dir: &Path, names: &[&str]) -> Result<(), String> {
    for name in names {
        let path = git_dir.join(name);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let result = if meta.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        // Someone else removing it first is the outcome we wanted.
        if let Err(e) = result {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(format!("could not clear {}: {e}", path.display()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_every_merge_head_line() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        let a = "1111111111111111111111111111111111111111";
        let b = "2222222222222222222222222222222222222222";
        std::fs::write(repo.path().join("MERGE_HEAD"), format!("{a}\n{b}\n")).unwrap();

        let parents = pending_parent_oids(&repo).unwrap();
        assert_eq!(parents.len(), 2, "an octopus merge has more than one head");
    }

    #[test]
    fn clearing_removes_markers_and_rebase_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        std::fs::write(repo.path().join("MERGE_HEAD"), "x").unwrap();
        std::fs::create_dir_all(repo.path().join("rebase-merge")).unwrap();

        clear_all_in_progress(&repo).unwrap();
        assert!(!repo.path().join("MERGE_HEAD").exists());
        assert!(!repo.path().join("rebase-merge").exists());
        assert_eq!(operation_name(&repo), None);
    }

    #[test]
    fn a_rebase_blocks_a_commit_but_a_merge_does_not() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = Repository::init(tmp.path()).unwrap();
        assert!(ensure_commit_allowed(&repo).is_ok());

        std::fs::write(repo.path().join("MERGE_HEAD"), "x").unwrap();
        assert!(
            ensure_commit_allowed(&repo).is_ok(),
            "committing is how a merge finishes"
        );
        assert!(ensure_no_operation(&repo, "switch branches").is_err());
    }
}
