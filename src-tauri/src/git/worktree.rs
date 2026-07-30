use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cmd::{run_git, run_git_timeout};

/// Per-worktree enrichment shells out twice for every worktree in the list, so
/// none of those calls may hang the whole listing on an unresponsive filesystem
/// (a network mount, a stale automount). Short and deliberate.
const ENRICH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// One entry from `git worktree list`. `branch` is the short name (the
/// `refs/heads/` prefix stripped) or `None` when the worktree has a detached
/// HEAD. The first worktree git reports is the main one — the repository's
/// own working directory — which can never be removed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    pub is_locked: bool,
    /// Detached HEAD (no branch checked out). Mutually exclusive with `branch`.
    pub is_detached: bool,
    /// The worktree whose canonicalized path equals the `repo_path` the UI is
    /// currently viewing. At most one entry is `true`.
    pub is_current: bool,
    /// Has uncommitted changes (`git status --porcelain` produced any output).
    pub is_dirty: bool,
    /// Commits on this worktree's branch not on its upstream. 0 when there is no
    /// upstream or the HEAD is detached.
    pub ahead: u32,
    /// Commits on the upstream not on this worktree's branch. 0 when there is no
    /// upstream or the HEAD is detached.
    pub behind: u32,
    /// True when this worktree's dirty flag could not be read (its directory is
    /// gone, the `git status` there failed or timed out). `is_dirty` is false in
    /// that case, and false must not be read as "clean".
    pub status_unknown: bool,
    /// Git considers this worktree removable by `git worktree prune` — almost
    /// always because its directory no longer exists. Dropping this from the
    /// parse made a worktree whose directory had been deleted render as an
    /// ordinary row, and "open this worktree" then registered a workspace
    /// pointing at nothing, where every terminal spawned there fails.
    pub is_prunable: bool,
    /// Why git calls it prunable, verbatim from the porcelain, when it says.
    pub prunable_reason: Option<String>,
    /// A bare repository entry. It has no working tree, so it can never be
    /// dirty, opened or removed, and counting it as a worktree made the
    /// "create your first worktree" empty state disappear in a repo that has
    /// none.
    pub is_bare: bool,
}

/// Parse `git worktree list --porcelain`. Records are blank-line separated;
/// each is a set of `key value` lines. We care about `worktree` (path),
/// `HEAD` (oid), `branch` (ref), `detached`, and `locked`.
pub(crate) fn git_list_worktrees_impl(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    let stdout = run_git(&repo_path, &["worktree", "list", "--porcelain"])?;

    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    let mut first = true;

    let flush = |cur: &mut Option<WorktreeInfo>, out: &mut Vec<WorktreeInfo>| {
        if let Some(wt) = cur.take() {
            out.push(wt);
        }
    };

    for line in stdout.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            // Starting a new record. The very first one git emits is main.
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                branch: None,
                head: None,
                is_main: first,
                is_locked: false,
                is_detached: false,
                is_current: false,
                is_dirty: false,
                ahead: 0,
                behind: 0,
                status_unknown: false,
                is_prunable: false,
                prunable_reason: None,
                is_bare: false,
            });
            first = false;
        } else if let Some(wt) = cur.as_mut() {
            if let Some(oid) = line.strip_prefix("HEAD ") {
                wt.head = Some(oid.to_string());
            } else if let Some(branch) = line.strip_prefix("branch ") {
                wt.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
            } else if line == "detached" {
                wt.is_detached = true;
            } else if line == "locked" || line.starts_with("locked ") {
                wt.is_locked = true;
            } else if line == "bare" {
                wt.is_bare = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                wt.is_prunable = true;
                wt.prunable_reason = line
                    .strip_prefix("prunable ")
                    .map(|r| r.trim().to_string())
                    .filter(|r| !r.is_empty());
            }
        }
    }
    flush(&mut cur, &mut out);

    // Enrich each worktree with per-directory status. Every extra `run_git`
    // targets the worktree's *own* path and is guarded: a failure (e.g. no
    // upstream, detached HEAD, transient error) degrades that field to its
    // default and never aborts the whole listing.
    let repo_canon = std::fs::canonicalize(&repo_path).ok();
    for wt in out.iter_mut() {
        // Current = the worktree the UI is viewing. Compare canonicalized paths
        // so symlinks / trailing slashes don't cause a false miss; fall back to
        // raw string equality when either path can't be canonicalized.
        wt.is_current = match (repo_canon.as_ref(), std::fs::canonicalize(&wt.path).ok()) {
            (Some(a), Some(b)) => *a == b,
            _ => Path::new(&wt.path) == Path::new(&repo_path),
        };
    }

    // A bare entry has no working tree to inspect, so running `git status`
    // there costs two subprocesses to learn nothing and exits 128 — which the
    // enrichment then reports as `status_unknown`, painting a spurious "?" on
    // a row that is definitionally clean.
    let paths: Vec<String> = out
        .iter()
        .filter(|wt| !wt.is_bare)
        .map(|wt| wt.path.clone())
        .collect();
    let mut enriched = enrich_all(&paths).into_iter();
    for wt in out.iter_mut() {
        if wt.is_bare {
            continue;
        }
        let Some(e) = enriched.next() else { break };
        wt.is_dirty = e.is_dirty;
        wt.status_unknown = e.status_unknown;
        wt.ahead = e.ahead;
        wt.behind = e.behind;
    }

    Ok(out)
}

#[derive(Default)]
struct Enrichment {
    is_dirty: bool,
    status_unknown: bool,
    ahead: u32,
    behind: u32,
}

/// How many worktrees are enriched at once.
///
/// Bounded rather than "spawn one thread per worktree": the count is
/// user-controlled, and a repository with fifty worktrees would otherwise put
/// a hundred `git` processes on the machine in one go. Eight keeps a normal
/// listing fully parallel while capping the pathological case.
const ENRICH_CONCURRENCY: usize = 8;

/// Run the per-worktree enrichment concurrently, in input order.
///
/// This used to be a serial loop, which mattered more than it looks: it is two
/// `git` subprocesses per worktree, and the whole listing runs inside
/// `blocking_git!`'s per-repo mutex — so every other git surface waited behind
/// the *sum* of them. With the filesystem watcher now emitting a pulse whenever
/// the repository changes, that cost is paid far more often than it used to be.
///
/// Concurrency is safe here because each call targets a different worktree
/// directory and only reads: `status --porcelain` and `rev-list --count` take
/// no locks in the repositories they run against.
fn enrich_all(paths: &[String]) -> Vec<Enrichment> {
    let mut out = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(ENRICH_CONCURRENCY) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|path| scope.spawn(move || enrich_one(path)))
                .collect();
            for handle in handles {
                // A panicked enrichment thread degrades that one row to
                // "unknown" rather than taking the listing down. `false` for
                // `is_dirty` must never be read as clean, which is exactly what
                // `status_unknown` is for.
                out.push(handle.join().unwrap_or_else(|_| Enrichment {
                    status_unknown: true,
                    ..Enrichment::default()
                }));
            }
        });
    }
    out
}

fn enrich_one(path: &str) -> Enrichment {
    let mut enriched = Enrichment::default();

    // Dirty = any porcelain output (staged, unstaged, or untracked). A
    // failure here used to degrade silently to "clean", so a stale worktree
    // whose directory had been deleted confidently reported no changes.
    match run_git_timeout(path, &["status", "--porcelain"], ENRICH_TIMEOUT) {
        Ok(status) => enriched.is_dirty = !status.trim().is_empty(),
        Err(e) => {
            log::warn!("status for worktree {path} unavailable: {e}");
            enriched.status_unknown = true;
        }
    }

    // Ahead/behind vs upstream. `<upstream>...HEAD` with `--left-right
    // --count` prints "<behind>\t<ahead>" (left = commits only on upstream,
    // right = commits only on HEAD). Fails with no upstream / detached HEAD,
    // which we let fall through to the 0/0 default.
    if let Ok(counts) = run_git_timeout(
        path,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        ENRICH_TIMEOUT,
    ) {
        let mut parts = counts.split_whitespace();
        if let (Some(behind), Some(ahead)) = (parts.next(), parts.next()) {
            enriched.behind = behind.parse().unwrap_or(0);
            enriched.ahead = ahead.parse().unwrap_or(0);
        }
    }

    enriched
}

/// Create a worktree at `path`. Three shapes, matching `git worktree add`:
///   • new branch:       `branch=Some`, `new_branch=true`  → `add -b <branch> <path>`
///   • existing branch:  `branch=Some`, `new_branch=false` → `add <path> <branch>`
///   • auto (basename):  `branch=None`                      → `add <path>`
/// Returns the freshly-created worktree's info (re-listed by path).
pub(crate) fn git_add_worktree_impl(
    repo_path: String,
    path: String,
    branch: Option<String>,
    new_branch: bool,
) -> Result<WorktreeInfo, String> {
    if Path::new(&path).exists() {
        return Err(format!("path already exists: {path}"));
    }

    let mut args: Vec<&str> = vec!["worktree", "add"];
    match &branch {
        Some(b) if new_branch => {
            args.push("-b");
            args.push(b);
            args.push(&path);
        }
        Some(b) => {
            args.push(&path);
            args.push(b);
        }
        None => {
            args.push(&path);
        }
    }
    run_git(&repo_path, &args)?;

    // git canonicalizes the path it stores (symlinks, trailing slashes), so match
    // on the canonicalized path — matching on the basename alone returned the
    // *wrong* worktree whenever two of them shared a directory name, which is
    // routine (`~/code/app/feature-x` and `~/worktrees/app/feature-x`).
    let target = std::fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let list = git_list_worktrees_impl(repo_path)?;
    list.into_iter()
        .find(|wt| {
            let candidate =
                std::fs::canonicalize(&wt.path).unwrap_or_else(|_| PathBuf::from(&wt.path));
            candidate == target
        })
        .ok_or_else(|| format!("worktree created at {path} but not found in `git worktree list`"))
}

/// Remove the worktree at `path` and prune stale admin entries. `force`
/// passes `--force` (drops a worktree with uncommitted changes). The main
/// worktree can't be removed — git rejects that and we surface its error.
///
/// Returns a warning string (empty when there is nothing to say). The prune step
/// runs after a removal that already succeeded, so a prune failure must not be
/// reported as "removal failed" — but it used to be dropped on the floor
/// entirely, leaving stale admin entries nobody was told about.
pub(crate) fn git_remove_worktree_impl(
    repo_path: String,
    path: String,
    force: bool,
) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    run_git(&repo_path, &args)?;

    match run_git(&repo_path, &["worktree", "prune"]) {
        Ok(_) => Ok(String::new()),
        Err(e) => {
            log::warn!("worktree removed but prune failed: {e}");
            Ok(format!(
                "Worktree removed, but pruning stale entries failed: {e}"
            ))
        }
    }
}

/// `git worktree unlock`.
///
/// Without it a locked worktree was a dead end: `remove` refuses, `--force`
/// refuses too (git wants `remove -f -f` for a lock, which nothing here sends),
/// and there was no other command anywhere in the app that could clear the
/// lock. The only way out was to leave voidlink and use the CLI.
pub(crate) fn git_unlock_worktree_impl(repo_path: String, path: String) -> Result<(), String> {
    run_git(&repo_path, &["worktree", "unlock", &path]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    /// A worktree whose directory was deleted is still listed by git, marked
    /// `prunable`. Dropping that flag made it render as an ordinary row, and
    /// opening it registered a workspace pointing at nothing.
    #[test]
    fn a_deleted_worktree_directory_comes_back_marked_prunable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("main");
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        write_file(&root, "a.txt", "one\n");
        commit_all(&repo, "base");

        let linked = dir.path().join("linked");
        crate::git::cmd::run_git(
            &root.to_string_lossy(),
            &["worktree", "add", &linked.to_string_lossy(), "-b", "topic"],
        )
        .unwrap();
        std::fs::remove_dir_all(&linked).unwrap();

        let list = git_list_worktrees_impl(root.to_string_lossy().into_owned()).unwrap();
        let gone = list
            .iter()
            .find(|w| !w.is_main)
            .expect("git still lists a worktree whose directory is gone");
        assert!(
            gone.is_prunable,
            "an unopenable worktree must say so: {gone:?}"
        );
    }

    /// `git_list_worktrees_impl` zips this result straight onto the parsed
    /// worktrees, so a reordering would silently attach one worktree's dirty
    /// flag and ahead/behind counts to another — the kind of wrong that looks
    /// like a UI bug for weeks. Chunked concurrency makes that a real risk, so
    /// it is pinned here rather than assumed.
    #[test]
    fn enrichment_comes_back_in_input_order() {
        let dir = tempfile::tempdir().unwrap();
        // More than one chunk, so the boundary is exercised too.
        let count = ENRICH_CONCURRENCY + 3;

        let mut paths = Vec::new();
        let mut expected_dirty = Vec::new();
        for i in 0..count {
            let root = dir.path().join(format!("repo{i}"));
            std::fs::create_dir_all(&root).unwrap();
            let repo = init_repo(&root);
            write_file(&root, "a.txt", "one\n");
            commit_all(&repo, "base");

            // Alternate, so an order slip cannot pass by coincidence.
            let dirty = i % 2 == 0;
            if dirty {
                write_file(&root, "a.txt", "two\n");
            }
            paths.push(root.to_string_lossy().into_owned());
            expected_dirty.push(dirty);
        }

        let enriched = enrich_all(&paths);
        assert_eq!(enriched.len(), count);
        let got: Vec<bool> = enriched.iter().map(|e| e.is_dirty).collect();
        assert_eq!(got, expected_dirty);
        assert!(
            enriched.iter().all(|e| !e.status_unknown),
            "every repo here is readable",
        );
    }

    /// A worktree whose directory is gone must report `status_unknown`, not
    /// `is_dirty: false` — the UI treats the latter as "clean, safe to remove".
    #[test]
    fn a_missing_directory_is_unknown_not_clean() {
        let enriched = enrich_one("/nonexistent/path/that/cannot/be/read");
        assert!(enriched.status_unknown);
        assert!(!enriched.is_dirty);
    }
}
