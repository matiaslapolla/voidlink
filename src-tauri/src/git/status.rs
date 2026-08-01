use git2::{Sort, Status, StatusOptions};

use super::repo::open_repo;
use super::{GitCommitInfo, GitFileStatus};

/// How the index differs from HEAD, if it does.
///
/// Note the deliberate omission of a fallback arm: `None` means "the index
/// matches HEAD", which is a different fact from "changed somehow". Only the
/// caller may invent a status for an entry neither side explained.
fn index_status(s: Status) -> Option<&'static str> {
    if s.is_index_new() {
        Some("added")
    } else if s.is_index_modified() {
        Some("modified")
    } else if s.is_index_deleted() {
        Some("deleted")
    } else if s.is_index_renamed() {
        Some("renamed")
    } else if s.is_index_typechange() {
        Some("typechange")
    } else {
        None
    }
}

/// How the working tree differs from the index, if it does.
fn worktree_status(s: Status) -> Option<&'static str> {
    if s.is_wt_new() {
        Some("untracked")
    } else if s.is_wt_modified() {
        Some("modified")
    } else if s.is_wt_deleted() {
        Some("deleted")
    } else if s.is_wt_renamed() {
        Some("renamed")
    } else if s.is_wt_typechange() {
        Some("typechange")
    } else {
        None
    }
}

/// The working tree's changed files, **one row per side that changed**.
///
/// A file can differ from HEAD in the index *and* differ from the index in the
/// working tree at the same time — `MM` in `git status --short`, which is what
/// you get by staging a file and then editing it again. Git models that as two
/// independent facts and so does every git UI worth using: the file belongs in
/// the Staged list *and* in the Changes list, and the two rows stage, unstage
/// and diff separately.
///
/// This used to be a single `if / else if` chain that stopped at the first
/// match, so an `MM` file produced exactly one row — the staged half — and the
/// unstaged edit was invisible. Not merely mislabelled: absent. Committing then
/// silently left the newer edit behind, with the changes list insisting there
/// was nothing else to commit.
pub(crate) fn git_file_status_impl(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&repo_path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        // Rename detection, without which `git mv a.txt b.txt` shows up as an
        // unrelated deleted `a.txt` plus added `b.txt` — two rows for one
        // action, and the `is_index_renamed()` / `is_wt_renamed()` arms below
        // were unreachable code. `StatusBadge` has always had an `R` to draw.
        //
        // `renames_from_rewrites` additionally lets a file that was replaced
        // wholesale still be paired with its old path rather than splitting.
        .renames_head_to_index(true)
        .renames_index_to_workdir(true)
        .renames_from_rewrites(true);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut result = Vec::new();
    for entry in statuses.iter() {
        // `entry.path()` yields `None` when the path is not valid UTF-8, and
        // the file was then skipped — dropped out of the changes list without a
        // trace. That is the one outcome worse than a broken row: the user
        // reads the list, commits, and the file is left behind having never
        // been mentioned. Decode lossily and mark it instead.
        let (path, lossy_path) = match std::str::from_utf8(entry.path_bytes()) {
            Ok(p) => (p.to_string(), false),
            Err(_) => (
                String::from_utf8_lossy(entry.path_bytes()).into_owned(),
                true,
            ),
        };
        let s = entry.status();

        // Where the file is *now*, per side.
        //
        // `entry.path()` is the delta's **old** path, so with rename detection
        // on it names a file that no longer exists — the row would say
        // `renamed old.txt`, and staging, discarding or diffing it would act on
        // a path git no longer has. Git itself shows the new name (the right of
        // its `old -> new`), and so does every row action here, which takes a
        // path. Each side is asked separately because a file can be renamed in
        // the index and renamed again in the working tree.
        let current_path = |delta: Option<git2::DiffDelta>| {
            delta
                .and_then(|d| d.new_file().path().map(|p| p.to_string_lossy().into_owned()))
                .unwrap_or_else(|| path.clone())
        };

        // Conflicted FIRST, and alone. libgit2 sets `WT_MODIFIED` alongside
        // `CONFLICTED` — a conflicted file is, after all, modified in the working
        // tree — so testing the working tree earlier meant every real conflict
        // was reported as an ordinary modification and the Conflicts section
        // stayed empty exactly when it mattered. It also means the two-row split
        // below must not apply here: a conflict is one thing to resolve, not a
        // staged half and an unstaged half.
        if s.is_conflicted() {
            result.push(GitFileStatus {
                path,
                status: "conflicted".to_string(),
                staged: false,
                lossy_path,
            });
            continue;
        }

        let index = index_status(s);
        let worktree = worktree_status(s);

        if let Some(status) = index {
            result.push(GitFileStatus {
                path: current_path(entry.head_to_index()),
                status: status.to_string(),
                staged: true,
                lossy_path,
            });
        }
        if let Some(status) = worktree {
            result.push(GitFileStatus {
                path: current_path(entry.index_to_workdir()),
                status: status.to_string(),
                staged: false,
                lossy_path,
            });
        } else if index.is_none() {
            // Neither side named a change, yet libgit2 handed us the entry. That
            // should not happen with these options, but dropping the file would
            // hide a real change; showing it as an unstaged modification is the
            // conservative guess and keeps it clickable.
            result.push(GitFileStatus {
                path,
                status: "modified".to_string(),
                staged: false,
                lossy_path,
            });
        }
    }

    Ok(result)
}

pub(crate) fn git_log_impl(
    repo_path: String,
    branch: Option<String>,
    limit: u32,
) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;

    if let Some(ref b) = branch {
        let oid = repo
            .revparse_single(b)
            .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", b)))
            .map_err(|e| e.message().to_string())?
            .id();
        revwalk.push(oid).map_err(|e| e.message().to_string())?;
    } else if revwalk.push_head().is_err() {
        // Unborn HEAD: a repo with no commits has an empty history, which is a
        // fact about the repo rather than an error. Erroring here white-screened
        // the sidebar, since `log()` is read inside a memo with no boundary.
        return Ok(Vec::new());
    }

    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| e.message().to_string())?;

    let mut commits = Vec::new();
    for item in revwalk.take(limit as usize) {
        let oid = item.map_err(|e| e.message().to_string())?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| e.message().to_string())?;
        let author = commit.author();
        let parent_oids = commit.parent_ids().map(|o| o.to_string()).collect();
        commits.push(GitCommitInfo {
            oid: oid.to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
            body: commit
                .body()
                .filter(|b| !b.is_empty())
                .map(|b| b.to_string()),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            time: commit.time().seconds(),
            parent_oids,
        });
    }

    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, start_conflicted_merge, write_file};

    fn statuses_of(root: &std::path::Path) -> Vec<GitFileStatus> {
        git_file_status_impl(root.to_string_lossy().to_string()).unwrap()
    }

    fn rows_for<'a>(statuses: &'a [GitFileStatus], path: &str) -> Vec<&'a GitFileStatus> {
        statuses.iter().filter(|s| s.path == path).collect()
    }

    #[test]
    fn a_staged_then_edited_file_appears_in_both_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        commit_all(&repo, "base");

        // Stage an edit, then edit again without staging — git's `MM`.
        write_file(tmp.path(), "a.txt", "two\n");
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        write_file(tmp.path(), "a.txt", "three\n");

        let rows = statuses_of(tmp.path());
        let a = rows_for(&rows, "a.txt");
        assert_eq!(
            a.len(),
            2,
            "an MM file is two independent facts; one row hides the unstaged edit \
             entirely and the user commits without it"
        );
        assert!(a.iter().any(|r| r.staged && r.status == "modified"));
        assert!(a.iter().any(|r| !r.staged && r.status == "modified"));
    }

    #[test]
    fn a_file_changed_on_one_side_only_stays_a_single_row() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        write_file(tmp.path(), "b.txt", "one\n");
        commit_all(&repo, "base");

        // a.txt: staged only. b.txt: working tree only. c.txt: untracked.
        write_file(tmp.path(), "a.txt", "two\n");
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();
        write_file(tmp.path(), "b.txt", "two\n");
        write_file(tmp.path(), "c.txt", "new\n");

        let rows = statuses_of(tmp.path());
        assert_eq!(rows_for(&rows, "a.txt").len(), 1);
        assert!(rows_for(&rows, "a.txt")[0].staged);
        assert_eq!(rows_for(&rows, "b.txt").len(), 1);
        assert!(!rows_for(&rows, "b.txt")[0].staged);
        let c = rows_for(&rows, "c.txt");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].status, "untracked");
        assert!(!c[0].staged);
    }

    #[test]
    fn a_staged_add_then_edited_reports_added_and_modified() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "seed.txt", "seed\n");
        commit_all(&repo, "base");

        write_file(tmp.path(), "new.txt", "one\n");
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("new.txt")).unwrap();
        index.write().unwrap();
        write_file(tmp.path(), "new.txt", "two\n");

        let rows = statuses_of(tmp.path());
        let n = rows_for(&rows, "new.txt");
        assert_eq!(n.len(), 2);
        // The two sides carry *different* statuses, which is the reason the
        // badge has to come from the row rather than from the file.
        assert!(n.iter().any(|r| r.staged && r.status == "added"));
        assert!(n.iter().any(|r| !r.staged && r.status == "modified"));
    }

    #[test]
    fn a_staged_rename_is_one_row_not_a_delete_plus_an_add() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "old.txt", "the quick brown fox\njumps over\nthe lazy dog\n");
        commit_all(&repo, "base");

        std::fs::rename(tmp.path().join("old.txt"), tmp.path().join("new.txt")).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(std::path::Path::new("old.txt")).unwrap();
        index.add_path(std::path::Path::new("new.txt")).unwrap();
        index.write().unwrap();

        let rows = statuses_of(tmp.path());
        assert_eq!(
            rows.len(),
            1,
            "a rename is one action; two rows made the list disagree with git \
             and left the R badge unreachable — got {rows:?}"
        );
        assert_eq!(rows[0].status, "renamed");
        assert!(rows[0].staged);
        assert_eq!(rows[0].path, "new.txt");
    }

    #[test]
    fn a_conflicted_file_reports_conflicted_not_modified() {
        let tmp = tempfile::tempdir().unwrap();
        start_conflicted_merge(tmp.path());

        let statuses = git_file_status_impl(tmp.path().to_string_lossy().to_string()).unwrap();
        let entry = statuses
            .iter()
            .find(|s| s.path == "a.txt")
            .expect("the conflicted file must appear");
        assert_eq!(
            entry.status, "conflicted",
            "libgit2 sets WT_MODIFIED too, so order in the chain decides — and \
             'modified' means the Conflicts section renders empty during a conflict"
        );
        assert!(!entry.staged);
    }

    #[test]
    fn a_repo_with_no_commits_has_an_empty_log_rather_than_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let log = git_log_impl(tmp.path().to_string_lossy().to_string(), None, 50)
            .expect("an unborn HEAD is an empty history, not a failure");
        assert!(log.is_empty());
    }
}
