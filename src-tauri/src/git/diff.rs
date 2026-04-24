use git2::DiffOptions;
use std::cell::RefCell;

use super::repo::open_repo;
use super::{DiffHunk, DiffLine, DiffResult, FileDiff};

pub(crate) fn git_diff_working_impl(
    repo_path: String,
    staged_only: bool,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let diff = if staged_only {
        repo.diff_tree_to_index(head_tree.as_ref(), None, None)
            .map_err(|e| e.message().to_string())?
    } else {
        let mut opts = DiffOptions::new();
        opts.include_untracked(true);
        repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    };

    collect_diff(diff)
}

pub(crate) fn collect_diff(diff: git2::Diff) -> Result<DiffResult, String> {
    let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

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
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Modified => "modified",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Copied => "copied",
                _ => "modified",
            };
            files.borrow_mut().push(FileDiff {
                old_path,
                new_path,
                status: status.to_string(),
                hunks: vec![],
                is_binary: delta.old_file().is_binary() || delta.new_file().is_binary(),
                additions: 0,
                deletions: 0,
            });
            true
        },
        Some(&mut |_delta, _progress| true),
        Some(&mut |_delta, hunk| {
            if let Some(file) = files.borrow_mut().last_mut() {
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
                match line.origin() {
                    '+' => file.additions += 1,
                    '-' => file.deletions += 1,
                    _ => {}
                }
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

    let files = files.into_inner();
    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(DiffResult {
        files,
        total_additions,
        total_deletions,
    })
}
