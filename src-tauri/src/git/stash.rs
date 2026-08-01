use git2::StashFlags;
use serde::{Deserialize, Serialize};

use super::cmd::{has_unmerged_paths, OpResult};
use super::repo::open_repo;

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

/// Classify the outcome of an apply or a pop.
///
/// Applying a stash is a merge, and a merge can stop on conflicts. libgit2
/// reports that as an error like any other, so the pane showed a red toast with
/// a raw porcelain message and no route anywhere — while the working tree was
/// sitting there with conflict markers in it and the index holding unmerged
/// entries. Every other operation that can halt this way (pull, merge, rebase,
/// cherry-pick) already returns [`OpResult`] and the UI routes `conflicted` to
/// the merge editor; there was no reason for stash to be the exception.
///
/// The index is asked rather than the return code trusted, for the same reason
/// [`super::cmd::run_git_op`] asks it — and here there is a second reason: a
/// conflicting `stash_apply` returns **`Ok`**. libgit2 writes the conflict
/// markers, leaves the unmerged entries in the index and reports success, so a
/// caller looking only at the `Result` says "Applied stash" over a working tree
/// full of `<<<<<<<`. Only the index knows.
fn classify_stash_result(repo_path: &str, outcome: Result<(), String>) -> Result<OpResult, String> {
    let conflicted = has_unmerged_paths(repo_path);
    match outcome {
        Ok(()) if !conflicted => Ok(OpResult {
            ok: true,
            conflicted: false,
            message: String::new(),
        }),
        Ok(()) => Ok(OpResult {
            ok: false,
            conflicted: true,
            message: "the stash applied with conflicts".to_string(),
        }),
        Err(message) if conflicted => Ok(OpResult {
            ok: false,
            conflicted: true,
            message,
        }),
        Err(message) => Err(message),
    }
}

pub(crate) fn git_stash_apply_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<OpResult, String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    let outcome = super::locking::retry_on_lock(&repo_path, || {
        repo.stash_apply(index, None)
            .map_err(|e| e.message().to_string())
    });
    classify_stash_result(&repo_path, outcome)
}

pub(crate) fn git_stash_pop_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<OpResult, String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    let outcome = super::locking::retry_on_lock(&repo_path, || {
        repo.stash_pop(index, None)
            .map_err(|e| e.message().to_string())
    });
    // A pop that stops on conflicts leaves the stash in place — libgit2 drops
    // it only after the apply half succeeds — so the entry the user sees after
    // a conflicted pop is genuinely still there, not a stale row.
    classify_stash_result(&repo_path, outcome)
}

pub(crate) fn git_stash_drop_impl(
    repo_path: String,
    index: usize,
    oid: String,
) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    verify_stash_oid(&mut repo, index, &oid)?;
    // Dropping rewrites `refs/stash` and its reflog, so it contends for
    // `.git/refs/stash.lock` exactly like apply and pop contend for the index —
    // an external `git stash` running at the same moment made this the one
    // stash mutation that failed with libgit2's "File exists" instead of
    // waiting the lock out. It was the odd one out for no stated reason.
    super::locking::retry_on_lock(&repo_path, || {
        repo.stash_drop(index).map_err(|e| e.message().to_string())
    })
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

    /// Applying a stash onto a working tree that changed the same lines is a
    /// merge that halts. It must come back as `conflicted` — the flag the UI
    /// routes to the merge editor — rather than as a raw error the pane can
    /// only put in a red toast, while the working tree sits there conflicted.
    #[test]
    fn a_conflicting_apply_is_reported_as_conflicted_not_as_a_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "base\n");
        commit_all(&repo, "base");
        let path = tmp.path().to_string_lossy().to_string();

        write_file(tmp.path(), "a.txt", "stashed\n");
        git_stash_save_impl(path.clone(), Some("wip".into()), false, false).unwrap();
        let entry = git_stash_list_impl(path.clone()).unwrap()[0].clone();

        // The same line, changed differently and committed, so the stash cannot
        // apply cleanly.
        write_file(tmp.path(), "a.txt", "diverged\n");
        commit_all(&repo, "diverged");

        let res = git_stash_apply_impl(path.clone(), entry.index, entry.oid.clone())
            .expect("a conflict is an outcome to route, not an error to throw");
        assert!(!res.ok);
        assert!(
            res.conflicted,
            "the pane needs this flag to open the merge editor — got {res:?}",
        );

        // And the stash survives, so the row the user sees is real.
        assert_eq!(git_stash_list_impl(path).unwrap().len(), 1);
    }

    /// A clean apply still reports `ok`, so the conflict plumbing above did not
    /// turn every success into a failure.
    #[test]
    fn a_clean_apply_reports_ok() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "base\n");
        commit_all(&repo, "base");
        let path = tmp.path().to_string_lossy().to_string();

        write_file(tmp.path(), "a.txt", "stashed\n");
        git_stash_save_impl(path.clone(), Some("wip".into()), false, false).unwrap();
        let entry = git_stash_list_impl(path.clone()).unwrap()[0].clone();

        let res = git_stash_apply_impl(path, entry.index, entry.oid).unwrap();
        assert!(res.ok && !res.conflicted, "got {res:?}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("a.txt")).unwrap(),
            "stashed\n"
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
