//! Repository serialization.
//!
//! Every git command used to `Repository::discover` independently and mutate
//! whatever it found, so two commands fired from one click (the sidebar fans
//! out ~14) could interleave inside libgit2's read-modify-write of the index or
//! a ref. Nothing in the Rust layer stopped them.
//!
//! Two mechanisms, because there are two kinds of contention:
//!
//!   * **In-process**: one `Mutex` per repository, keyed by the canonicalized
//!     git dir and held across the whole command body. Commands touching
//!     different repositories still run in parallel; commands touching the same
//!     one queue.
//!   * **Cross-process**: an external `git` (the app's own terminal, an editor
//!     plugin, a CI hook) can hold `.git/index.lock` while we try to write.
//!     That one can only be waited out, so [`retry_on_lock`] retries with
//!     backoff and, when the lock looks abandoned, says so instead of
//!     reporting libgit2's "File exists".

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

/// Per-repository locks, keyed by canonicalized git dir.
#[derive(Clone, Default)]
pub struct RepoLocks {
    inner: Arc<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>>,
}

impl RepoLocks {
    /// The lock guarding `repo_path`'s repository.
    ///
    /// Keyed by the *git dir* rather than the path the frontend passed, so a
    /// subdirectory, a symlinked workdir and the repo root all map to the same
    /// lock. A path we cannot resolve to a repository still gets a lock, keyed
    /// by the raw string — an unopenable repo makes the command fail anyway,
    /// and failing while serialized is strictly safer than failing in parallel.
    pub fn for_repo(&self, repo_path: &str) -> Arc<Mutex<()>> {
        let key = git_dir_key(repo_path);
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.entry(key).or_default().clone()
    }
}

/// Resolve a path to the key its lock lives under.
///
/// Worktrees deliberately share the *common* dir key: `git worktree` state,
/// refs and the object database are shared, so two worktrees of one repository
/// must serialize against each other.
fn git_dir_key(repo_path: &str) -> PathBuf {
    if let Ok(repo) = git2::Repository::discover(repo_path) {
        let dir = repo.path().to_path_buf();
        // A linked worktree's git dir is `<main>/.git/worktrees/<name>`, and it
        // records where the shared dir is in a `commondir` file. git2 0.19 has
        // no `commondir()` accessor, so we read it — the fallback is the
        // worktree's own dir, which is still a correct (just narrower) key.
        let common = std::fs::read_to_string(dir.join("commondir"))
            .ok()
            .map(|rel| dir.join(rel.trim()))
            .unwrap_or_else(|| dir.clone());
        return std::fs::canonicalize(&common).unwrap_or(common);
    }
    let raw = PathBuf::from(repo_path);
    std::fs::canonicalize(&raw).unwrap_or(raw)
}

/// How long a lock file has to sit untouched before we call it abandoned.
const STALE_LOCK_AFTER: Duration = Duration::from_secs(30);
/// Backoff schedule for a contended lock: ~1.2s total across five retries.
const BACKOFF_MS: [u64; 5] = [25, 50, 100, 200, 400];

/// Run `f`, retrying while another process holds a git lock file.
///
/// Only lock-file failures are retried; every other error returns on the first
/// attempt, because retrying a genuine failure just delays the message. When
/// the retries run out we look at the lock file itself: one that has not been
/// touched in [`STALE_LOCK_AFTER`] is almost certainly left over from a git
/// process that died, and saying so is the difference between a user waiting
/// and a user knowing what to delete.
pub(crate) fn retry_on_lock<T, F>(repo_path: &str, mut f: F) -> Result<T, String>
where
    F: FnMut() -> Result<T, String>,
{
    let mut last = match f() {
        Ok(v) => return Ok(v),
        Err(e) if is_lock_error(&e) => e,
        Err(e) => return Err(e),
    };

    for wait in BACKOFF_MS {
        std::thread::sleep(Duration::from_millis(wait));
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if is_lock_error(&e) => last = e,
            Err(e) => return Err(e),
        }
    }

    match stale_lock_path(repo_path) {
        Some(path) => Err(format!(
            "another git process is holding {} and has not touched it in {}s — if no git command is running, delete that file and retry (original error: {last})",
            path.display(),
            STALE_LOCK_AFTER.as_secs(),
        )),
        None => Err(format!(
            "another git process is using this repository — try again in a moment ({last})"
        )),
    }
}

/// Does this error message describe a git lock file we should wait out?
fn is_lock_error(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains(".lock") || (m.contains("lock") && m.contains("exists"))
}

/// The abandoned lock file, if there is one.
fn stale_lock_path(repo_path: &str) -> Option<PathBuf> {
    let repo = git2::Repository::discover(repo_path).ok()?;
    let candidates = [
        repo.path().join("index.lock"),
        repo.path().join("HEAD.lock"),
        repo.path().join("config.lock"),
    ];
    for path in candidates {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let age = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .unwrap_or_default();
        if age >= STALE_LOCK_AFTER {
            return Some(path);
        }
    }
    None
}

/// Write the index, waiting out a concurrent `git` process.
///
/// The one place index writes funnel through, so every staging path inherits
/// the retry instead of each remembering to ask for it.
pub(crate) fn write_index(repo_path: &str, index: &mut git2::Index) -> Result<(), String> {
    retry_on_lock(repo_path, || {
        index.write().map_err(|e| e.message().to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_repo_maps_to_one_lock_even_from_a_subdirectory() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let sub = tmp.path().join("nested/deeper");
        std::fs::create_dir_all(&sub).unwrap();

        let locks = RepoLocks::default();
        let a = locks.for_repo(&tmp.path().to_string_lossy());
        let b = locks.for_repo(&sub.to_string_lossy());
        assert!(Arc::ptr_eq(&a, &b), "a subdirectory must share the repo lock");
    }

    #[test]
    fn different_repos_do_not_share_a_lock() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        git2::Repository::init(one.path()).unwrap();
        git2::Repository::init(two.path()).unwrap();

        let locks = RepoLocks::default();
        let a = locks.for_repo(&one.path().to_string_lossy());
        let b = locks.for_repo(&two.path().to_string_lossy());
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn a_non_lock_error_is_not_retried() {
        let tmp = tempfile::tempdir().unwrap();
        let mut calls = 0;
        let out: Result<(), String> = retry_on_lock(&tmp.path().to_string_lossy(), || {
            calls += 1;
            Err("no such branch".to_string())
        });
        assert!(out.is_err());
        assert_eq!(calls, 1, "only lock contention is worth waiting out");
    }

    #[test]
    fn a_lock_error_that_clears_succeeds() {
        let tmp = tempfile::tempdir().unwrap();
        let mut calls = 0;
        let out: Result<u8, String> = retry_on_lock(&tmp.path().to_string_lossy(), || {
            calls += 1;
            if calls < 3 {
                Err("failed to create locked file '.git/index.lock': File exists".to_string())
            } else {
                Ok(7)
            }
        });
        assert_eq!(out.unwrap(), 7);
        assert_eq!(calls, 3);
    }
}
