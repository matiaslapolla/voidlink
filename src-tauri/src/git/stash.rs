use git2::StashFlags;
use serde::{Deserialize, Serialize};

use super::compare::git_diff_refs_impl;
use super::repo::open_repo;
use super::DiffResult;

/// One entry from the stash stack. `index` is the position (0 = most recent,
/// the `stash@{0}` git addresses by). `message` is the auto- or user-supplied
/// description; `oid` is the stash commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

pub(crate) fn git_stash_list_impl(repo_path: String) -> Result<Vec<StashEntry>, String> {
    // stash_foreach needs &mut Repository even though it only reads.
    let mut repo = open_repo(&repo_path)?;
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        out.push(StashEntry {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })
    .map_err(|e| e.message().to_string())?;
    Ok(out)
}

/// Save the working tree (and optionally untracked files) to a new stash.
/// `keep_index` leaves staged changes in the index after stashing.
pub(crate) fn git_stash_save_impl(
    repo_path: String,
    message: Option<String>,
    keep_index: bool,
    include_untracked: bool,
) -> Result<String, String> {
    let mut repo = open_repo(&repo_path)?;
    // A stash's author is metadata nobody reads; refusing to stash because
    // `user.name` is unset is a wall in front of the one operation that saves
    // the user's work. Same helper the auto-stash on checkout uses.
    let sig = super::staging::housekeeping_signature(&repo)?;
    let mut flags = StashFlags::DEFAULT;
    if keep_index {
        flags |= StashFlags::KEEP_INDEX;
    }
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    let oid = repo
        .stash_save2(&sig, message.as_deref(), Some(flags))
        .map_err(|e| e.message().to_string())?;
    Ok(oid.to_string())
}

/// Confirm the stash at `index` is still the one the caller meant.
///
/// The stash is a stack, so *any* new stash shifts every existing entry down:
/// the Stash button, the auto-stash on branch switch, or a `git stash` typed
/// into the app's own terminal all insert at 0. A UI that remembers a position
/// and then applies — or drops, which is irreversible — hits the wrong stash.
/// libgit2 addresses stashes only by index, so instead of pretending otherwise
/// we make the caller state which commit it saw there and refuse on a mismatch.
fn verify_stash_oid(repo: &mut git2::Repository, index: usize, oid: &str) -> Result<(), String> {
    let mut found: Option<String> = None;
    let mut total = 0usize;
    repo.stash_foreach(|i, _message, entry_oid| {
        total += 1;
        if i == index {
            found = Some(entry_oid.to_string());
        }
        true
    })
    .map_err(|e| e.message().to_string())?;

    match found {
        Some(actual) if actual == oid => Ok(()),
        Some(actual) => Err(format!(
            "the stash list changed — stash@{{{index}}} is now {}, not {}. Refresh and try again.",
            short(&actual),
            short(oid)
        )),
        None => Err(format!(
            "stash@{{{index}}} no longer exists ({total} stash(es) left) — refresh and try again"
        )),
    }
}

fn short(oid: &str) -> String {
    oid.chars().take(7).collect()
}

pub(crate) fn git_stash_apply_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    super::locking::retry_on_lock(&repo_path, || {
        repo.stash_apply(index, None)
            .map_err(|e| e.message().to_string())
    })
}

pub(crate) fn git_stash_pop_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    super::locking::retry_on_lock(&repo_path, || {
        repo.stash_pop(index, None)
            .map_err(|e| e.message().to_string())
    })
}

pub(crate) fn git_stash_drop_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    repo.stash_drop(index).map_err(|e| e.message().to_string())
}

/// Diff a stash against the commit it was created from — reuses the ref-diff
/// machinery via the `stash@{N}` revision syntax.
pub(crate) fn git_stash_show_impl(repo_path: String, index: usize) -> Result<DiffResult, String> {
    let head = format!("stash@{{{index}}}");
    let base = format!("stash@{{{index}}}^1");
    git_diff_refs_impl(repo_path, base, head, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    /// Two stashes, then the *older* one addressed by the position it used to
    /// hold. Positional identity alone would apply the wrong stash; with the oid
    /// it errors instead.
    #[test]
    fn applying_a_shifted_stash_by_stale_index_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "base\n");
        commit_all(&repo, "base");
        let path = tmp.path().to_string_lossy().to_string();

        write_file(tmp.path(), "a.txt", "first change\n");
        git_stash_save_impl(path.clone(), Some("first".into()), false, false).unwrap();
        let first = git_stash_list_impl(path.clone()).unwrap();
        let first_oid = first[0].oid.clone();
        assert_eq!(first[0].index, 0);

        // A second stash pushes the first one down to index 1.
        write_file(tmp.path(), "a.txt", "second change\n");
        git_stash_save_impl(path.clone(), Some("second".into()), false, false).unwrap();

        let err = git_stash_apply_impl(path.clone(), 0, first_oid.clone()).unwrap_err();
        assert!(err.contains("stash list changed"), "got: {err}");

        // The same stash at its real position still works.
        git_stash_apply_impl(path.clone(), 1, first_oid).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "first change\n"
        );
    }

    #[test]
    fn dropping_a_stash_that_no_longer_exists_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "base\n");
        commit_all(&repo, "base");
        let path = tmp.path().to_string_lossy().to_string();

        let err = git_stash_drop_impl(path, 0, "0".repeat(40)).unwrap_err();
        assert!(err.contains("no longer exists"), "got: {err}");
    }

    #[test]
    fn stashing_works_without_a_configured_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        {
            // Commit with an explicit signature so the repo has a HEAD but no
            // user.name in its own config.
            write_file(tmp.path(), "a.txt", "base\n");
            let tree_oid = {
                let mut index = repo.index().unwrap();
                index.add_path(std::path::Path::new("a.txt")).unwrap();
                index.write().unwrap();
                index.write_tree().unwrap()
            };
            let tree = repo.find_tree(tree_oid).unwrap();
            let sig = git2::Signature::now("x", "x@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "base", &tree, &[])
                .unwrap();
            let mut cfg = repo.config().unwrap();
            cfg.remove("user.name").ok();
            cfg.remove("user.email").ok();
        }
        write_file(tmp.path(), "a.txt", "dirty\n");
        let path = tmp.path().to_string_lossy().to_string();
        git_stash_save_impl(path, Some("wip".into()), false, false)
            .expect("a stash must not need user.name — it is how work gets saved");
    }
}
