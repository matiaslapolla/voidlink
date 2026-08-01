use git2::{DiffFindOptions, DiffOptions};
use std::cell::RefCell;

use super::repo::open_repo;
use super::{DiffHunk, DiffLine, DiffResult, FileDiff};

/// Turn add+delete pairs back into the rename or copy they actually were.
///
/// libgit2 has rename detection off by default, so a moved file arrives as two
/// unrelated deltas: a `deleted` at the old path and an `added` at the new one.
/// Every consequence of that is visible — the file count disagrees with
/// `git diff -M`, the diff of a renamed file shows every line added and every
/// line deleted rather than the edit inside it, and `StatusBadge`'s `R` and `C`
/// letters were dead code because nothing ever produced those statuses.
///
/// Shared by the working-tree and branch-compare paths, which had drifted:
/// only the compare path detected renames, so the same file moved on the same
/// branch read as one row in one surface and two in the other.
pub(crate) fn detect_renames(diff: &mut git2::Diff) -> Result<(), String> {
    let mut find = DiffFindOptions::new();
    find.renames(true).copies(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| e.message().to_string())
}

/// The diff options every working-tree diff shares.
///
/// `include_typechange` matters for the same reason it does on the compare
/// path: without it a symlink that became a regular file is reported as a
/// Deleted *and* an Added delta sharing one path, and a UI that looks files up
/// by path can only ever reach the first of the two.
fn working_diff_opts(ignore_whitespace: bool) -> DiffOptions {
    let mut opts = DiffOptions::new();
    opts.include_typechange(true);
    apply_whitespace(&mut opts, ignore_whitespace);
    opts
}

/// "Ignore whitespace", as a property of the diff rather than of the render.
///
/// This used to be a pure client-side transform that dropped lines and hunks
/// after the fact, which made the surrounding UI lie: the file list, the
/// `+/−` counts and the footer totals all came from the *unfiltered* diff, so
/// a whitespace-only change was listed as `+3 −3` and then rendered an empty
/// pane. The numbers and the content disagreed because they were computed from
/// two different diffs.
///
/// libgit2 knows how to do this properly. `ignore_whitespace` covers changes
/// in the amount of whitespace; the EOL variant catches CRLF churn, which is
/// the other thing people mean by the phrase.
pub(crate) fn apply_whitespace(opts: &mut DiffOptions, ignore: bool) {
    if ignore {
        opts.ignore_whitespace(true);
        opts.ignore_whitespace_eol(true);
    }
}

pub(crate) fn git_diff_working_impl(
    repo_path: String,
    staged_only: bool,
    ignore_whitespace: bool,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut diff = if staged_only {
        // `git diff --cached` — HEAD against the index.
        let mut opts = working_diff_opts(ignore_whitespace);
        repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    } else {
        // `git diff` — the index against the working tree.
        //
        // This used to be `diff_tree_to_workdir_with_index(head)`, which is
        // `git diff HEAD`: it folds the staged changes back in. The symptom was
        // that staging did nothing. Stage a hunk, and it stayed on screen,
        // because the view being asked for was "everything since the last
        // commit" rather than "everything not yet staged" — so the caller had
        // no way to render the two halves of a partially-staged file apart, and
        // the one diff surface with a Stage button appeared inert.
        let mut opts = working_diff_opts(ignore_whitespace);
        opts.include_untracked(true);
        // Untracked directories otherwise arrive as a single entry for the
        // directory rather than one per file inside it.
        opts.recurse_untracked_dirs(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    };

    detect_renames(&mut diff)?;
    collect_diff(diff, ignore_whitespace)
}

/// Walk a diff into the shape the UI renders.
///
/// `drop_whitespace_only` exists because libgit2's `ignore_whitespace` removes
/// a file's *hunks* but keeps its delta — the blob really did change, after
/// all. `git diff -w` shows nothing at all for such a file, and so should we:
/// leaving the delta in produced a file listed as changed that renders an empty
/// pane, which is the same visible bug the flag was supposed to fix.
///
/// Only files whose content is the entire story are dropped. A mode change or a
/// typechange also yields zero hunks and is a real answer the user needs to
/// see — `NoTextChange` exists to render exactly that.
///
/// ## Why there is a budget
///
/// Every hunk of every file was serialized into one JSON blob with no ceiling,
/// and git work in a repository is serialized behind a per-repo mutex. So a
/// single compare across a vendored directory or a generated lockfile — the
/// kind that runs to millions of lines — held that mutex for the whole
/// serialization *and* handed the frontend a payload no one can read anyway.
/// Every other git command in that repository queued behind it: the status
/// pulse, the branch list, the sidebar.
///
/// The caps below bound the payload rather than the walk, which is the half
/// that is ours to bound. `additions`/`deletions` keep counting past the cap,
/// so the tree and the footer still report the true size of the change; what
/// stops is storing line content nobody was going to scroll through. The file
/// carries `truncated` so the renderer can say so instead of quietly showing
/// half a diff.
const MAX_LINES_PER_FILE: usize = 20_000;
/// A second ceiling across the whole diff, because ten thousand files of two
/// lines each is the same problem arriving by a different route.
const MAX_LINES_TOTAL: usize = 200_000;

pub(crate) fn collect_diff(
    diff: git2::Diff,
    drop_whitespace_only: bool,
) -> Result<DiffResult, String> {
    let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());
    // Parallel to `files`: did this delta change the file's mode? Kept
    // alongside rather than on `FileDiff` because nothing downstream needs it.
    let mode_changed: RefCell<Vec<bool>> = RefCell::new(Vec::new());
    // Lines stored so far across every file, against `MAX_LINES_TOTAL`.
    let stored_total = std::cell::Cell::new(0usize);
    // Lines stored so far for the file currently being walked. Counted rather
    // than derived from the hunks, because a truncated file stops growing them.
    let stored_in_file = std::cell::Cell::new(0usize);

    diff.foreach(
        &mut |delta, _progress| {
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            // `StatusBadge` already knows how to letter every one of these, so
            // folding them into "modified" threw away information the UI was
            // built to show — an untracked file and a symlink-turned-file both
            // rendered as an ordinary edit.
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Modified => "modified",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Copied => "copied",
                git2::Delta::Untracked => "untracked",
                git2::Delta::Typechange => "typechange",
                git2::Delta::Conflicted => "conflicted",
                _ => "modified",
            };
            // A zero oid means "no old side" (added / untracked), which is a
            // different thing from "we do not know", so it is dropped rather
            // than shipped as a string of zeroes the verifier would compare.
            let old_id = delta.old_file().id();
            let old_blob_oid = (!old_id.is_zero()).then(|| old_id.to_string());
            mode_changed
                .borrow_mut()
                .push(delta.old_file().mode() != delta.new_file().mode());
            files.borrow_mut().push(FileDiff {
                old_path,
                new_path,
                status: status.to_string(),
                hunks: vec![],
                is_binary: delta.old_file().is_binary() || delta.new_file().is_binary(),
                additions: 0,
                deletions: 0,
                old_blob_oid,
                truncated: false,
            });
            stored_in_file.set(0);
            true
        },
        Some(&mut |_delta, _progress| true),
        Some(&mut |_delta, hunk| {
            if let Some(file) = files.borrow_mut().last_mut() {
                // An empty hunk renders as a header with nothing under it, so
                // once the budget is gone the hunk is not opened at all.
                if file.truncated {
                    return true;
                }
                let header = std::str::from_utf8(hunk.header())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                file.hunks.push(DiffHunk {
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    header,
                    lines: vec![],
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            if let Some(file) = files.borrow_mut().last_mut() {
                // Counted before the budget check, and unconditionally: the
                // tree rows, the folder rollups and the footer totals all read
                // these, and a capped file reporting `+0 −0` would look like
                // the mode-only case rather than like a huge change.
                match line.origin() {
                    '+' => file.additions += 1,
                    '-' => file.deletions += 1,
                    _ => {}
                }
                // Ahead of the `to_string` below, which is the allocation the
                // budget exists to stop making.
                if stored_in_file.get() >= MAX_LINES_PER_FILE
                    || stored_total.get() >= MAX_LINES_TOTAL
                {
                    file.truncated = true;
                    return true;
                }
                stored_in_file.set(stored_in_file.get() + 1);
                stored_total.set(stored_total.get() + 1);
                let origin = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    ' ' => " ",
                    _ => "~",
                };
                let content = std::str::from_utf8(line.content())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine {
                        origin: origin.to_string(),
                        content,
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    });
                }
            }
            true
        }),
    )
    .map_err(|e| e.message().to_string())?;

    let mut files = files.into_inner();
    if drop_whitespace_only {
        let modes = mode_changed.into_inner();
        let mut i = 0;
        files.retain(|f| {
            let mode_moved = modes.get(i).copied().unwrap_or(false);
            i += 1;
            // Keep unless content was the entire story and there is no content
            // left to show.
            !f.hunks.is_empty() || f.is_binary || mode_moved || f.status != "modified"
        });
    }
    let files = files;
    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(DiffResult {
        files,
        total_additions,
        total_deletions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    /// Twelve lines, so a staged edit at the top and an unstaged one at the
    /// bottom land in separate hunks with the default three lines of context.
    fn numbered(marks: &[(usize, &str)]) -> String {
        let mut lines: Vec<String> = (1..=12).map(|i| format!("line {i}")).collect();
        for (i, text) in marks {
            lines[*i - 1] = (*text).to_string();
        }
        lines.join("\n") + "\n"
    }

    /// "Ignore whitespace" has to be a property of the **diff**, not of the
    /// render. As a client-side filter it left the file list, the `+/−` counts
    /// and the footer totals computed from the unfiltered diff, so a
    /// whitespace-only change was listed as changed with counts on it and then
    /// rendered an empty pane — the numbers and the content disagreeing because
    /// they came from two different diffs.
    #[test]
    fn ignoring_whitespace_removes_the_file_from_the_diff_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "a.txt", "alpha\nbeta\ngamma\n");
        write_file(root, "real.txt", "one\n");
        commit_all(&repo, "base");

        // Indentation only.
        write_file(root, "a.txt", "alpha\n    beta\ngamma\n");
        // A genuine edit, so we can tell "ignored everything" from "worked".
        write_file(root, "real.txt", "two\n");

        let path = root.to_string_lossy().to_string();

        let plain = git_diff_working_impl(path.clone(), false, false).unwrap();
        assert_eq!(plain.files.len(), 2, "got {:?}", plain.files);

        let ignoring = git_diff_working_impl(path, false, true).unwrap();
        let names: Vec<_> = ignoring.files.iter().filter_map(|f| f.new_path.as_deref()).collect();
        assert_eq!(names, vec!["real.txt"], "whitespace-only file must be gone entirely");
        // And the totals must agree with what is left, which was the whole
        // problem with filtering after the fact.
        assert_eq!(ignoring.total_additions, 1);
        assert_eq!(ignoring.total_deletions, 1);
    }

    /// ...but a mode-only change must survive it. It also has zero hunks, and
    /// it is a real answer the user needs — `NoTextChange` renders exactly this
    /// case. Dropping every empty delta would have swallowed it.
    #[cfg(unix)]
    #[test]
    fn ignoring_whitespace_does_not_swallow_a_mode_change() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "run.sh", "#!/bin/sh\necho hi\n");
        commit_all(&repo, "base");

        let script = root.join("run.sh");
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let out =
            git_diff_working_impl(root.to_string_lossy().to_string(), false, true).unwrap();
        assert!(
            out.files.iter().any(|f| f.new_path.as_deref() == Some("run.sh")),
            "a chmod is a change with no lines, not a whitespace-only change: {:?}",
            out.files
        );
    }

    /// A rename must survive as a rename in the staged view too — the compare
    /// path detected them and this one did not, so the same move read as one
    /// file in one surface and two in the other.
    #[test]
    fn a_staged_rename_is_one_entry_in_the_staged_diff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "old.txt", &numbered(&[]));
        commit_all(&repo, "base");

        std::fs::rename(root.join("old.txt"), root.join("new.txt")).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(std::path::Path::new("old.txt")).unwrap();
        index.add_path(std::path::Path::new("new.txt")).unwrap();
        index.write().unwrap();

        let out = git_diff_working_impl(root.to_string_lossy().to_string(), true, false).unwrap();
        assert_eq!(out.files.len(), 1, "got {:?}", out.files);
        assert_eq!(out.files[0].status, "renamed");
        assert_eq!(out.files[0].old_path.as_deref(), Some("old.txt"));
        assert_eq!(out.files[0].new_path.as_deref(), Some("new.txt"));
    }

    /// The regression this module exists for.
    ///
    /// `staged_only = false` has to mean `git diff` — what is *not* yet staged.
    /// It used to mean `git diff HEAD`, which includes the index, so a file
    /// edited twice reported both edits in both views and staging one of them
    /// changed nothing on screen.
    #[test]
    fn unstaged_view_excludes_what_is_already_staged() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "a.txt", &numbered(&[]));
        commit_all(&repo, "base");

        // Edit line 2, stage it.
        write_file(root, "a.txt", &numbered(&[(2, "INDEX ONLY")]));
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();

        // Edit line 11 on top, leave it unstaged.
        write_file(
            root,
            "a.txt",
            &numbered(&[(2, "INDEX ONLY"), (11, "WORKDIR ONLY")]),
        );

        let path = root.to_string_lossy().into_owned();

        let staged = git_diff_working_impl(path.clone(), true, false).unwrap();
        assert_eq!(staged.files.len(), 1);
        assert_eq!(staged.files[0].hunks.len(), 1, "staged view: only line 2");
        assert!(hunk_text(&staged.files[0]).contains("INDEX ONLY"));
        assert!(!hunk_text(&staged.files[0]).contains("WORKDIR ONLY"));

        let unstaged = git_diff_working_impl(path, false, false).unwrap();
        assert_eq!(unstaged.files.len(), 1);
        assert_eq!(
            unstaged.files[0].hunks.len(),
            1,
            "unstaged view must not carry the staged hunk back in",
        );
        assert!(hunk_text(&unstaged.files[0]).contains("WORKDIR ONLY"));
        assert!(!hunk_text(&unstaged.files[0]).contains("INDEX ONLY"));
    }

    /// Staging the whole file empties the unstaged view rather than leaving the
    /// diff sitting there looking like the Stage button did nothing.
    #[test]
    fn staging_everything_leaves_nothing_unstaged() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);

        write_file(root, "a.txt", "one\n");
        commit_all(&repo, "base");
        write_file(root, "a.txt", "two\n");

        let path = root.to_string_lossy().into_owned();
        assert_eq!(git_diff_working_impl(path.clone(), false, false).unwrap().files.len(), 1);

        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("a.txt")).unwrap();
        index.write().unwrap();

        assert!(
            git_diff_working_impl(path.clone(), false, false)
                .unwrap()
                .files
                .is_empty(),
            "a fully staged file has no unstaged changes left",
        );
        assert_eq!(git_diff_working_impl(path, true, false).unwrap().files.len(), 1);
    }

    /// Untracked files still show up, and one row per file rather than one per
    /// directory — `recurse_untracked_dirs` is what buys the second half.
    #[test]
    fn untracked_files_are_listed_individually() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "a.txt", "one\n");
        commit_all(&repo, "base");

        write_file(root, "fresh/one.txt", "1\n");
        write_file(root, "fresh/two.txt", "2\n");

        let result = git_diff_working_impl(root.to_string_lossy().into_owned(), false, false).unwrap();
        let mut paths: Vec<&str> = result
            .files
            .iter()
            .filter_map(|f| f.new_path.as_deref())
            .collect();
        paths.sort_unstable();
        assert_eq!(paths, vec!["fresh/one.txt", "fresh/two.txt"]);
    }

    /// CMP-F10. Every hunk of every file went into one JSON blob with no
    /// ceiling, behind a per-repo mutex — so one compare across a vendored
    /// directory queued every other git command in the repository behind a
    /// payload nobody was going to read.
    #[test]
    fn a_huge_file_is_capped_but_still_reports_its_real_size() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "small.txt", "kept\n");
        write_file(root, "generated.txt", "seed\n");
        commit_all(&repo, "base");

        let over = MAX_LINES_PER_FILE + 500;
        let generated: String = (0..over).map(|i| format!("line {i}\n")).collect();
        write_file(root, "generated.txt", &generated);

        let out = git_diff_working_impl(root.to_string_lossy().into_owned(), false, false).unwrap();
        let file = out
            .files
            .iter()
            .find(|f| f.new_path.as_deref() == Some("generated.txt"))
            .expect("the file is still listed — capping is not dropping");

        assert!(file.truncated, "the renderer has to be told it is seeing part");
        assert_eq!(
            file.additions as usize, over,
            "the counts keep counting past the cap, or the tree row lies about the size"
        );
        let stored: usize = file.hunks.iter().map(|h| h.lines.len()).sum();
        assert!(
            stored <= MAX_LINES_PER_FILE,
            "stored {stored} lines against a cap of {MAX_LINES_PER_FILE}"
        );
    }

    /// ...and an ordinary diff never sets the flag, or the notice becomes noise
    /// the user learns to ignore.
    #[test]
    fn an_ordinary_file_is_not_marked_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let repo = init_repo(root);
        write_file(root, "a.txt", "one\n");
        commit_all(&repo, "base");
        write_file(root, "a.txt", "two\n");

        let out = git_diff_working_impl(root.to_string_lossy().into_owned(), false, false).unwrap();
        assert!(out.files.iter().all(|f| !f.truncated));
    }

    fn hunk_text(file: &FileDiff) -> String {
        file.hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .map(|l| l.content.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}
