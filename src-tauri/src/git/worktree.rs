use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::cmd::{run_git, run_git_bytes, run_git_timeout};

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

/// Parse `git worktree list --porcelain -z`.
///
/// `-z` (git 2.36+) terminates every attribute with a NUL and every record with
/// an empty attribute, which is the only form of this porcelain that survives a
/// path containing a newline. Without it such a path split across two "lines":
/// the row came back with a truncated path, and the remainder was silently
/// discarded as an unrecognized key. A newline in a directory name is legal on
/// every filesystem voidlink runs on, and the failure was invisible — a row
/// pointing somewhere that does not exist, with nothing saying so.
///
/// Records are NUL-terminated attributes; each is `key` or `key value`. We care
/// about `worktree` (path), `HEAD` (oid), `branch` (ref), `detached`, `locked`,
/// `bare` and `prunable`.
pub(crate) fn git_list_worktrees_impl(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
    // `-z` predates neither git 2.36 nor this app, but it is not universal, and
    // a worktree list that refuses to run is strictly worse than one that
    // mis-splits a path almost nobody has. Fall back rather than fail.
    let stdout = match run_git_bytes(&repo_path, &["worktree", "list", "--porcelain", "-z"]) {
        Ok(stdout) => stdout,
        Err(e) => {
            log::warn!("`worktree list --porcelain -z` unavailable ({e}); falling back");
            run_git_bytes(&repo_path, &["worktree", "list", "--porcelain"])?
        }
    };
    Ok(finish_listing(parse_porcelain(&stdout), &repo_path))
}

/// The parse half, split out so it can be tested against porcelain that is
/// awkward to produce on a real filesystem (a newline in a path, a path that is
/// not valid UTF-8).
///
/// Bytes rather than `&str`, because the alternative is `from_utf8_lossy`, and
/// a lossily-converted path is worse than no path at all: it *looks* like a
/// worktree, so the row renders with working buttons, and every one of them —
/// open, remove, spawn a terminal — addresses a path that does not exist,
/// because the `U+FFFD`s are not the bytes on disk. A record whose path we
/// cannot represent is dropped and logged instead. Unreachable on APFS, which
/// enforces UTF-8; ext4 stores whatever bytes it is handed.
///
/// Both terminators are handled, because the caller falls back to the non-`-z`
/// form on an old git. The presence of a NUL is what says which form this is,
/// and it cannot be ambiguous — the newline form can never contain one.
fn parse_porcelain(stdout: &[u8]) -> Vec<WorktreeInfo> {
    let sep = if stdout.contains(&0) { 0u8 } else { b'\n' };
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    let mut first = true;

    let flush = |cur: &mut Option<WorktreeInfo>, out: &mut Vec<WorktreeInfo>| {
        if let Some(wt) = cur.take() {
            out.push(wt);
        }
    };

    // A trailing terminator leaves one empty tail item that is not a record
    // boundary; an empty item *between* attributes is. `split` gives us both,
    // and flushing a `None` is a no-op, so neither needs special-casing.
    for raw in stdout.split(|b| *b == sep) {
        if raw.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        let Ok(line) = std::str::from_utf8(raw) else {
            // `first` still advances: if the *main* worktree is the one we had
            // to drop, promoting the next row to main would be a second, worse
            // lie on top of the first.
            if raw.starts_with(b"worktree ") {
                log::warn!(
                    "dropping a worktree whose path is not valid UTF-8: {}",
                    String::from_utf8_lossy(raw)
                );
                cur = None;
                first = false;
            }
            continue;
        };
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
    out
}

/// Mark the current worktree and enrich every row with per-directory status.
fn finish_listing(mut out: Vec<WorktreeInfo>, repo_path: &str) -> Vec<WorktreeInfo> {
    // Current = the worktree the UI is viewing. Compare canonicalized paths so
    // symlinks / trailing slashes don't cause a false miss.
    //
    // The fallback matters: when *either* side cannot be canonicalized — the
    // directory was deleted (a prunable worktree, which is exactly the row a
    // user is most likely to be sitting in when things go wrong), or it lives
    // on a mount that is momentarily unreadable — raw `Path` equality answers
    // `/tmp/x` vs `/private/tmp/x` and `/repo` vs `/repo/` with "no", and *no
    // row at all* gets marked current. So we normalize what we can without
    // touching the filesystem and compare that instead: pop empty and `.`
    // components, which is what a trailing slash and a `./` prefix are.
    let repo_canon = std::fs::canonicalize(repo_path).ok();
    let repo_lexical = lexical_key(Path::new(repo_path));
    for wt in out.iter_mut() {
        wt.is_current = match (repo_canon.as_ref(), std::fs::canonicalize(&wt.path).ok()) {
            (Some(a), Some(b)) => *a == b,
            _ => lexical_key(Path::new(&wt.path)) == repo_lexical,
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

    out
}

/// A path reduced to the parts that decide identity, without asking the
/// filesystem. `/repo/`, `/repo` and `/repo/./` all collapse to the same key;
/// `/tmp/x` and `/private/tmp/x` deliberately do **not**, because resolving
/// that needs the filesystem and this runs precisely when the filesystem
/// cannot answer.
fn lexical_key(path: &Path) -> PathBuf {
    path.components()
        .filter(|c| !matches!(c, std::path::Component::CurDir))
        .collect()
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

    /// A path with a newline in it splits the non-`-z` porcelain across two
    /// lines: the row came back truncated at the newline and the remainder was
    /// discarded as an unrecognized key, so a row rendered pointing at a
    /// directory that does not exist. `-z` is the only form that survives it.
    #[test]
    fn a_newline_in_a_path_does_not_split_the_record() {
        let porcelain = b"worktree /repos/we\nird\0HEAD abc123\0branch refs/heads/topic\0\0";
        let out = parse_porcelain(porcelain);
        assert_eq!(out.len(), 1, "one worktree, not a phantom second one");
        assert_eq!(out[0].path, "/repos/we\nird");
        assert_eq!(out[0].branch.as_deref(), Some("topic"));
    }

    /// The non-`-z` fallback path (an old git) must still parse. Same records,
    /// newline-terminated.
    #[test]
    fn the_newline_porcelain_still_parses() {
        let porcelain = b"worktree /repos/main\nHEAD abc123\nbranch refs/heads/main\n\n\
                          worktree /repos/topic\nHEAD def456\ndetached\n\n";
        let out = parse_porcelain(porcelain);
        assert_eq!(out.len(), 2);
        assert!(out[0].is_main && !out[1].is_main);
        assert!(out[1].is_detached);
    }

    /// A path that is not valid UTF-8 must not come back with `U+FFFD` where
    /// its bytes were: the row would render with working buttons, every one of
    /// which addresses a path that does not exist on disk. Dropped instead —
    /// and the *next* worktree must not be promoted to main by the drop.
    #[test]
    fn a_path_that_is_not_utf8_is_dropped_rather_than_mangled() {
        let mut porcelain: Vec<u8> = Vec::new();
        porcelain.extend_from_slice(b"worktree /repos/");
        porcelain.push(0xff);
        porcelain.extend_from_slice(b"bad\0HEAD abc123\0branch refs/heads/bad\0\0");
        porcelain.extend_from_slice(b"worktree /repos/fine\0HEAD def456\0branch refs/heads/fine\0\0");

        let out = parse_porcelain(&porcelain);
        assert_eq!(out.len(), 1, "the unrepresentable row is gone, not corrupted");
        assert_eq!(out[0].path, "/repos/fine");
        assert!(
            !out[0].is_main,
            "the dropped row was main; promoting this one would be a second lie",
        );
    }

    /// When neither path can be canonicalized — the usual reason being that the
    /// directory is gone, which is exactly the row a user is most likely to be
    /// sitting in — raw `Path` equality answered `/repo` vs `/repo/` with "no"
    /// and *nothing at all* was marked current.
    #[test]
    fn a_trailing_slash_does_not_lose_the_current_row() {
        let rows = vec![WorktreeInfo {
            path: "/gone/wt/".to_string(),
            branch: None,
            head: None,
            is_main: true,
            is_locked: false,
            is_detached: false,
            is_current: false,
            is_dirty: false,
            ahead: 0,
            behind: 0,
            status_unknown: false,
            is_prunable: false,
            prunable_reason: None,
            is_bare: true, // bare, so `finish_listing` skips the enrichment shell-outs
        }];
        let out = finish_listing(rows, "/gone/wt");
        assert!(out[0].is_current, "the row the UI is viewing must be marked");
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
