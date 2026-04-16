use git2::DiffOptions;
use std::path::Path;

use super::repo::open_repo;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BlameLineInfo {
    pub start_line: u32,
    pub num_lines: u32,
    pub author: String,
    pub commit_sha: String,
    pub timestamp: i64,
    pub summary: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LineChange {
    pub line: u32,
    pub change_type: String,
}

pub fn git_blame_file_impl(
    repo_path: &str,
    file_path: &str,
) -> Result<Vec<BlameLineInfo>, String> {
    let repo = open_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Repository has no working directory".to_string())?;

    let abs_file = Path::new(file_path);
    let relative_path = abs_file
        .strip_prefix(workdir)
        .map_err(|_| format!("File {} is not inside repository workdir {}", file_path, workdir.display()))?;

    let blame = repo
        .blame_file(relative_path, None)
        .map_err(|e| e.message().to_string())?;

    let mut results = Vec::new();
    let mut commit_cache = std::collections::HashMap::new();
    for i in 0..blame.len() {
        let hunk = blame.get_index(i).ok_or("Failed to get blame hunk")?;
        let sig = hunk.final_signature();
        let author = sig
            .name()
            .unwrap_or("Unknown")
            .to_string();
        let commit_oid = hunk.final_commit_id();
        let oid_str = commit_oid.to_string();
        let commit_sha = oid_str[..8.min(oid_str.len())].to_string();
        let timestamp = sig.when().seconds();

        let summary = commit_cache
            .entry(commit_oid)
            .or_insert_with(|| {
                repo.find_commit(commit_oid)
                    .ok()
                    .and_then(|c| c.summary().map(|s| s.to_string()))
                    .unwrap_or_default()
            })
            .clone();

        results.push(BlameLineInfo {
            start_line: hunk.final_start_line() as u32,
            num_lines: hunk.lines_in_hunk() as u32,
            author,
            commit_sha,
            timestamp,
            summary,
        });
    }

    Ok(results)
}

pub fn git_diff_file_lines_impl(
    repo_path: &str,
    file_path: &str,
) -> Result<Vec<LineChange>, String> {
    let repo = open_repo(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "Repository has no working directory".to_string())?;

    let abs_file = Path::new(file_path);
    let relative_path = abs_file
        .strip_prefix(workdir)
        .map_err(|_| format!("File {} is not inside repository workdir {}", file_path, workdir.display()))?;
    let relative_str = relative_path.to_string_lossy();

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut opts = DiffOptions::new();
    opts.pathspec(&*relative_str);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut changes: Vec<LineChange> = Vec::new();

    diff.foreach(
        &mut |_delta, _progress| true,
        None,
        None,
        Some(&mut |_delta, _hunk, line| {
            match line.origin() {
                '+' => {
                    if let Some(new_lineno) = line.new_lineno() {
                        changes.push(LineChange {
                            line: new_lineno,
                            change_type: "added".to_string(),
                        });
                    }
                }
                '-' => {
                    if let Some(old_lineno) = line.old_lineno() {
                        changes.push(LineChange {
                            line: old_lineno,
                            change_type: "deleted".to_string(),
                        });
                    }
                }
                _ => {}
            }
            true
        }),
    )
    .map_err(|e| e.message().to_string())?;

    Ok(changes)
}
