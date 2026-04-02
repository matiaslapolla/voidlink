use git2::DiffOptions;
use serde_json::Value;
use std::cell::RefCell;

use super::repo::open_repo;
use super::{DiffExplanation, DiffHunk, DiffLine, DiffResult, FileDiff};

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

pub(crate) fn git_diff_branches_impl(
    repo_path: String,
    base: String,
    head: String,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;

    let base_tree = repo
        .revparse_single(&base)
        .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", base)))
        .map_err(|e| e.message().to_string())?
        .peel_to_tree()
        .map_err(|e| e.message().to_string())?;

    let head_tree = repo
        .revparse_single(&head)
        .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", head)))
        .map_err(|e| e.message().to_string())?
        .peel_to_tree()
        .map_err(|e| e.message().to_string())?;

    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)
        .map_err(|e| e.message().to_string())?;

    collect_diff(diff)
}

pub(crate) fn git_diff_commit_impl(
    repo_path: String,
    oid: String,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;
    let commit_oid = git2::Oid::from_str(&oid).map_err(|e| e.message().to_string())?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|e| e.message().to_string())?;
    let commit_tree = commit.tree().map_err(|e| e.message().to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.message().to_string())?
                .tree()
                .map_err(|e| e.message().to_string())?,
        )
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|e| e.message().to_string())?;

    collect_diff(diff)
}

pub(crate) fn git_explain_diff_impl(
    repo_path: String,
    base: String,
    head: String,
    migration_state: &crate::migration::MigrationState,
) -> Result<Vec<DiffExplanation>, String> {
    let diff_result = git_diff_branches_impl(repo_path, base, head)?;

    if diff_result.files.is_empty() {
        return Ok(vec![]);
    }

    let mut explanations = Vec::new();
    let batch_size = 5;

    for chunk in diff_result.files.chunks(batch_size) {
        let mut file_summaries = Vec::new();
        for file in chunk {
            let path = file
                .new_path
                .as_deref()
                .or(file.old_path.as_deref())
                .unwrap_or("unknown");
            let diff_text: String = file
                .hunks
                .iter()
                .flat_map(|h| {
                    h.lines
                        .iter()
                        .map(|l| format!("{}{}", l.origin, l.content))
                })
                .collect();
            file_summaries.push(format!(
                "File: {}\nStatus: {}\n+{} -{}\n\n{}",
                path,
                file.status,
                file.additions,
                file.deletions,
                &diff_text[..diff_text.len().min(2000)]
            ));
        }

        let prompt = format!(
            r#"Analyze these code changes and return a JSON array with one object per file.
Each object must have: file_path (string), summary (1-2 sentence description), risk_level ("low"|"medium"|"high"), suggestions (array of strings, max 3).

Changes to analyze:
{}

Return ONLY a JSON array, no other text."#,
            file_summaries.join("\n---\n")
        );

        match migration_state.llm_chat(&prompt, true) {
            Ok(raw) => {
                if let Ok(parsed) = serde_json::from_str::<Vec<Value>>(&raw) {
                    for item in parsed {
                        let file_path = item["file_path"]
                            .as_str()
                            .unwrap_or("unknown")
                            .to_string();
                        let summary = item["summary"]
                            .as_str()
                            .unwrap_or("No summary available")
                            .to_string();
                        let risk_level =
                            item["risk_level"].as_str().unwrap_or("low").to_string();
                        let suggestions = item["suggestions"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        explanations.push(DiffExplanation {
                            file_path,
                            summary,
                            risk_level,
                            suggestions,
                        });
                    }
                } else {
                    for file in chunk {
                        let file_path = file
                            .new_path
                            .as_deref()
                            .or(file.old_path.as_deref())
                            .unwrap_or("unknown")
                            .to_string();
                        explanations.push(DiffExplanation {
                            file_path,
                            summary: format!(
                                "{} (+{} -{})",
                                file.status, file.additions, file.deletions
                            ),
                            risk_level: "low".to_string(),
                            suggestions: vec![],
                        });
                    }
                }
            }
            Err(_) => {
                for file in chunk {
                    let file_path = file
                        .new_path
                        .as_deref()
                        .or(file.old_path.as_deref())
                        .unwrap_or("unknown")
                        .to_string();
                    explanations.push(DiffExplanation {
                        file_path,
                        summary: format!(
                            "{} (+{} -{})",
                            file.status, file.additions, file.deletions
                        ),
                        risk_level: "low".to_string(),
                        suggestions: vec![],
                    });
                }
            }
        }
    }

    Ok(explanations)
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
