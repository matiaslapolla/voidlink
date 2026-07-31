//! Filesystem watching for open repositories.
//!
//! ## Why this exists
//!
//! Every git surface in the app refreshes off one pulse (`voidlink:refresh-git`),
//! and until now the *only* thing that ever emitted it was the app mutating the
//! repository itself. So anything that changed git state without going through a
//! button was invisible: `git commit` typed into VoidLink's own terminal, a
//! rebase driven from an external shell, an agent writing files, a branch
//! switched in another tool. The sidebars looked stale at random, which is
//! exactly how it was reported — "the sidebars sometimes do not get updated".
//!
//! The two cheap alternatives were considered and rejected on the evidence:
//!
//!   * **Refresh on window focus.** The terminal is *inside* this app, so
//!     running git there never changes window focus. It would fix only the case
//!     where the user leaves for another application.
//!   * **Hook the terminal's process poll.** `terminalWatch.ts` samples at
//!     1500ms and needs two consecutive busy samples to call a command finished.
//!     `git commit` returns in well under 100ms and is usually never observed
//!     as busy at all. It would catch a long rebase and miss every ordinary
//!     command.
//!
//! Only watching the filesystem catches all of it.
//!
//! ## What it costs, and how that is kept down
//!
//! A pulse is expensive — it wakes every git surface, and each fires at least
//! one git command behind a per-repo lock. Making pulses *frequent* therefore
//! has to come with making them *selective*, or a watcher turns a stale sidebar
//! into a slow one. Three filters do that work:
//!
//!   1. The debouncer collapses a burst (one `git commit` touches the index,
//!      HEAD, a ref and a log) into a single delivery.
//!   2. Inside the git directory only the files that actually describe repo
//!      state are accepted — never `objects/`, never `*.lock`. A fetch writes
//!      thousands of loose objects and would otherwise pulse thousands of times.
//!   3. In the working tree, ignored paths are dropped, so a `node_modules`
//!      install or a `target/` rebuild is silent.
//!
//! Anything that survives all three is coalesced *again* on the frontend by the
//! existing 40ms window before it reaches a subscriber.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use notify_debouncer_full::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Emitter, Manager};

/// Broadcast to every window when a watched repository changed on disk. The
/// payload is the repository root, so a window can ignore repositories it is
/// not showing.
pub const GIT_CHANGED_EVENT: &str = "voidlink://git-changed";

/// How long a burst is collected before one change is reported.
///
/// A single git command produces a scatter of writes; 250ms is comfortably
/// wider than that and still below the point where a refresh reads as lag. It
/// is deliberately larger than the frontend's 40ms coalescing window, which is
/// solving a different problem (several *callers* emitting at once).
const DEBOUNCE: Duration = Duration::from_millis(250);

type RepoDebouncer = Debouncer<RecommendedWatcher, RecommendedCache>;

struct Watched {
    /// Held purely to keep the watcher alive.
    ///
    /// Dropping a `Debouncer` stops its thread and releases the OS handles, so
    /// this field being "never read" *is* its job — storing it in the registry
    /// is how a repository stays watched, and removing it from the registry is
    /// how watching stops. Hence the allow rather than a rename: the compiler
    /// is right about the read and wrong about the conclusion.
    #[allow(dead_code)]
    debouncer: RepoDebouncer,
    /// What was actually watched, for the log line and for tests.
    roots: Vec<PathBuf>,
}

#[derive(Default)]
pub struct WatchState {
    repos: Mutex<HashMap<String, Watched>>,
}

/// Files inside the git directory whose contents describe repository state.
///
/// Matched against the path *relative to the git dir*, as a prefix, so
/// `refs/heads/main` and `rebase-merge/done` both land. Everything not listed
/// is noise for our purposes: `objects/` and `lfs/` are content-addressed and
/// say nothing about refs, `logs/` duplicates what refs already told us, and
/// `hooks/` and `info/` are configuration.
const GIT_DIR_INTERESTING: &[&str] = &[
    "HEAD",
    "ORIG_HEAD",
    "MERGE_HEAD",
    "MERGE_MSG",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "index",
    "packed-refs",
    "refs/",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "worktrees/",
    "config",
];

/// Does this path, inside a git directory, describe state we render?
///
/// `*.lock` is rejected first and that is load-bearing rather than tidy: git
/// creates and deletes `index.lock` around *every* operation including
/// read-only ones, so accepting it would pulse on commands that changed
/// nothing. The unlocked file it protects (`index`) is accepted, so the real
/// change is never missed by dropping the lock.
fn git_dir_path_is_interesting(rel: &Path) -> bool {
    let Some(rel) = rel.to_str() else {
        // A non-UTF-8 path inside .git is not something we know how to classify.
        // Refreshing on it is the safe direction: a spurious pulse costs a
        // refetch, a missed one leaves the UI lying.
        return true;
    };
    if rel.ends_with(".lock") {
        return false;
    }
    GIT_DIR_INTERESTING.iter().any(|prefix| rel.starts_with(prefix))
}

/// Split a path into "the part inside a `.git` directory" and the rest.
///
/// Returns `Some(relative_to_git_dir)` when the path passes through a `.git`
/// component. Worktree git dirs live at `<common>/worktrees/<id>/`, which this
/// also covers because that whole tree sits under the main `.git`.
fn inside_git_dir(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    while let Some(component) = components.next() {
        if let Component::Normal(name) = component {
            if name == ".git" {
                return Some(components.as_path().to_path_buf());
            }
        }
    }
    None
}

/// Should this filesystem event wake the git surfaces?
fn is_interesting(path: &Path, ignore: &Gitignore) -> bool {
    if let Some(rel) = inside_git_dir(path) {
        return git_dir_path_is_interesting(&rel);
    }
    // A working-tree file. `matched_path_or_any_parents` is what makes
    // `node_modules/.../x.js` cheap to reject: the rule matches the directory
    // and we never consult the thousands of files under it individually.
    //
    // `is_dir: false` unconditionally, because the event may well be a
    // deletion, and stat-ing a path that no longer exists to answer the
    // question would be both slower and wrong.
    !ignore.matched_path_or_any_parents(path, false).is_ignore()
}

/// The directories that have to be watched to see everything about one repo.
///
/// Usually one — the worktree root, which contains `.git`. A *linked* worktree
/// keeps its refs in the main repository's git dir, which is somewhere else
/// entirely, so that is watched too or a branch created in another worktree
/// would never reach this one.
fn roots_for(repo_path: &Path) -> Result<Vec<PathBuf>, String> {
    let repo = git2::Repository::open(repo_path)
        .map_err(|e| format!("could not open {}: {}", repo_path.display(), e.message()))?;

    let mut roots = Vec::new();
    if let Some(workdir) = repo.workdir() {
        roots.push(workdir.to_path_buf());
    }

    let common = common_dir(repo.path());
    let already_covered = roots.iter().any(|root| common.starts_with(root));
    if !already_covered {
        roots.push(common);
    }
    Ok(roots)
}

/// The git directory shared by every worktree of a repository.
///
/// For a main worktree that is just its `.git`. For a *linked* worktree
/// `repo.path()` is `<main>/.git/worktrees/<id>/`, which holds only that
/// worktree's HEAD and rebase state — the refs everyone shares live in the
/// common dir. Git records where that is in a `commondir` file next to them,
/// holding a path relative to the worktree's git dir (usually `../..`), and
/// reading it is the documented way to find it.
///
/// git2 0.19 exposes no `commondir()`, so the file is read directly rather than
/// reconstructed by trimming components — the relative path is git's to define,
/// not ours to guess.
fn common_dir(git_dir: &Path) -> PathBuf {
    let Ok(contents) = std::fs::read_to_string(git_dir.join("commondir")) else {
        return git_dir.to_path_buf();
    };
    let joined = git_dir.join(contents.trim());
    joined.canonicalize().unwrap_or(joined)
}

/// Build the ignore matcher for a repository.
///
/// Failures are swallowed into "match nothing": a repository without a
/// `.gitignore` is normal, and an unreadable one should cost extra refreshes
/// rather than no watching at all.
fn ignore_for(workdir: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(workdir);
    let _ = builder.add(workdir.join(".gitignore"));
    let _ = builder.add(workdir.join(".git/info/exclude"));
    // `.git` itself is handled by `inside_git_dir` before the matcher is
    // consulted, so it deliberately is not an ignore rule here.
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn start_watching(app: &AppHandle, repo_path: &str) -> Result<Watched, String> {
    let root = PathBuf::from(repo_path);
    let roots = roots_for(&root)?;
    let ignore = ignore_for(&root);

    let handle = app.clone();
    let repo_for_event = repo_path.to_string();

    let mut debouncer = new_debouncer(
        DEBOUNCE,
        None,
        move |result: DebounceEventResult| {
            let events = match result {
                Ok(events) => events,
                Err(errors) => {
                    // A watch error is worth a line in the log but must not be
                    // fatal: losing one repository's watcher should not take
                    // down the others, and the UI still has its manual refresh.
                    for error in errors {
                        log::warn!("watch error for {repo_for_event}: {error}");
                    }
                    return;
                }
            };
            let relevant = events
                .iter()
                .any(|event| event.event.paths.iter().any(|p| is_interesting(p, &ignore)));
            if !relevant {
                return;
            }
            if let Err(e) = handle.emit(GIT_CHANGED_EVENT, &repo_for_event) {
                log::warn!("could not broadcast a git change for {repo_for_event}: {e}");
            }
            // Strictly after the pulse. Working out *what* changed costs a
            // couple of ref reads, and a refresh the user is watching for must
            // never queue behind bookkeeping.
            crate::journal::note_repo_change(&handle, &repo_for_event);
        },
    )
    .map_err(|e| format!("could not start a watcher for {repo_path}: {e}"))?;

    for dir in &roots {
        debouncer
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| format!("could not watch {}: {e}", dir.display()))?;
    }

    Ok(Watched { debouncer, roots })
}

/// Replace the set of watched repositories with exactly `repo_paths`.
///
/// Set semantics rather than `watch_one`/`unwatch_one` on purpose: the caller
/// is a reactive effect over the open workspaces, and a frontend that misses an
/// unwatch — a crash, a window closing mid-update, a race between two
/// workspaces closing — would otherwise leak an OS watch handle per repository
/// for the life of the process. Sending the whole set makes every call
/// self-correcting.
///
/// A repository that fails to start is reported and skipped, not fatal: one
/// unreadable repo must not cost the others their watchers.
#[tauri::command]
pub fn watch_repos(app: AppHandle, repo_paths: Vec<String>) -> Result<Vec<String>, String> {
    let state = app.state::<WatchState>();
    let mut repos = state
        .repos
        .lock()
        .map_err(|_| "the watcher registry is poisoned".to_string())?;

    repos.retain(|path, _| repo_paths.contains(path));

    let mut failures = Vec::new();
    for path in repo_paths {
        if repos.contains_key(&path) {
            continue;
        }
        match start_watching(&app, &path) {
            Ok(watched) => {
                log::info!(
                    "watching {path} ({} root{})",
                    watched.roots.len(),
                    if watched.roots.len() == 1 { "" } else { "s" }
                );
                repos.insert(path, watched);
            }
            Err(e) => {
                log::warn!("{e}");
                failures.push(e);
            }
        }
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_dir_state_files_are_interesting_and_noise_is_not() {
        for path in [
            "HEAD",
            "index",
            "packed-refs",
            "refs/heads/main",
            "refs/remotes/origin/main",
            "rebase-merge/done",
            "worktrees/wt1/HEAD",
            "MERGE_HEAD",
        ] {
            assert!(
                git_dir_path_is_interesting(Path::new(path)),
                "{path} describes repo state",
            );
        }

        for path in [
            "objects/ab/cdef",
            "logs/HEAD",
            "hooks/pre-commit",
            "info/attributes",
            "lfs/objects/x",
            "FETCH_HEAD",
        ] {
            assert!(
                !git_dir_path_is_interesting(Path::new(path)),
                "{path} is noise",
            );
        }
    }

    /// The one that matters most for pulse cost: git takes `index.lock` around
    /// operations that change nothing at all.
    #[test]
    fn lock_files_never_count() {
        assert!(!git_dir_path_is_interesting(Path::new("index.lock")));
        assert!(!git_dir_path_is_interesting(Path::new(
            "refs/heads/main.lock"
        )));
        // …while the file the lock protects still does.
        assert!(git_dir_path_is_interesting(Path::new("index")));
    }

    #[test]
    fn finds_the_git_dir_component_anywhere_in_the_path() {
        assert_eq!(
            inside_git_dir(Path::new("/repo/.git/refs/heads/main")),
            Some(PathBuf::from("refs/heads/main")),
        );
        // A linked worktree's git dir.
        assert_eq!(
            inside_git_dir(Path::new("/repo/.git/worktrees/wt1/HEAD")),
            Some(PathBuf::from("worktrees/wt1/HEAD")),
        );
        assert_eq!(inside_git_dir(Path::new("/repo/src/main.rs")), None);
        // A *file* called .gitignore is not a git directory.
        assert_eq!(inside_git_dir(Path::new("/repo/.gitignore")), None);
    }

    #[test]
    fn ignored_working_tree_paths_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        let ignore = ignore_for(root);

        assert!(!is_interesting(&root.join("node_modules/x/index.js"), &ignore));
        assert!(!is_interesting(&root.join("debug.log"), &ignore));
        assert!(is_interesting(&root.join("src/main.rs"), &ignore));
        // Inside .git the gitignore never gets a say.
        assert!(is_interesting(&root.join(".git/refs/heads/main"), &ignore));
        assert!(!is_interesting(&root.join(".git/objects/ab/cd"), &ignore));
    }

    #[test]
    fn a_main_worktree_needs_only_one_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        crate::git::testfix::init_repo(root);
        let roots = roots_for(root).unwrap();
        assert_eq!(roots.len(), 1, "the git dir lives under the worktree");
    }

    /// A linked worktree keeps its refs somewhere else entirely, so watching
    /// only its own directory would miss every branch, commit and stash made
    /// from another worktree of the same repository.
    #[test]
    fn a_linked_worktree_also_watches_the_shared_git_dir() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        let repo = crate::git::testfix::init_repo(&main);
        crate::git::testfix::write_file(&main, "a.txt", "one\n");
        crate::git::testfix::commit_all(&repo, "base");

        let linked = dir.path().join("linked");
        repo.worktree("wt1", &linked, None).unwrap();

        let roots = roots_for(&linked).unwrap();
        assert_eq!(roots.len(), 2, "the worktree and the shared git dir");

        // The second root must be the *common* dir — `main/.git` — and not the
        // per-worktree directory under it, or refs changes never arrive.
        let common = roots[1].canonicalize().unwrap();
        let expected = main.join(".git").canonicalize().unwrap();
        assert_eq!(common, expected);
    }

    /// The filter list is a claim about what git writes, so it is checked
    /// against git rather than against my memory of it.
    ///
    /// A live watcher over a real commit: if `GIT_DIR_INTERESTING` were missing
    /// the files that actually move — or if `*.lock` filtering were greedy
    /// enough to swallow them — every unit test above would still pass and the
    /// feature would silently never fire.
    #[test]
    fn a_real_commit_produces_an_event_the_filter_accepts() {
        let dir = tempfile::tempdir().unwrap();
        // Canonicalized because macOS reports events under `/private/var` while
        // `tempdir()` hands back `/var`, and the paths have to be comparable.
        let root = dir.path().canonicalize().unwrap();
        let repo = crate::git::testfix::init_repo(&root);
        crate::git::testfix::write_file(&root, "a.txt", "one\n");
        crate::git::testfix::commit_all(&repo, "base");

        let ignore = ignore_for(&root);
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = new_debouncer(Duration::from_millis(100), None, tx).unwrap();
        debouncer.watch(&root, RecursiveMode::Recursive).unwrap();

        // Let the watcher settle before making the change it is meant to see.
        std::thread::sleep(Duration::from_millis(300));
        crate::git::testfix::write_file(&root, "a.txt", "two\n");
        crate::git::testfix::commit_all(&repo, "second");

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut accepted: Vec<PathBuf> = Vec::new();
        while std::time::Instant::now() < deadline && accepted.is_empty() {
            let Ok(result) = rx.recv_timeout(Duration::from_millis(500)) else {
                continue;
            };
            let Ok(events) = result else { continue };
            for event in events {
                for path in event.event.paths {
                    if is_interesting(&path, &ignore) {
                        accepted.push(path);
                    }
                }
            }
        }

        assert!(
            !accepted.is_empty(),
            "a commit must reach the git surfaces; nothing passed the filter",
        );
        // The stronger claim, and the one `GIT_DIR_INTERESTING` is actually
        // making: the *repository state* change was seen, not merely the
        // working-tree edit that preceded it. A commit with no working-tree
        // change at all (an amend, a `git commit --allow-empty`, a branch
        // switch) has nothing but this to go on.
        assert!(
            accepted.iter().any(|p| inside_git_dir(p).is_some()),
            "only working-tree paths passed; git-dir state was filtered out: {accepted:?}",
        );
    }

    #[test]
    fn common_dir_of_a_plain_repo_is_itself() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();
        assert_eq!(common_dir(&git_dir), git_dir);
    }
}
