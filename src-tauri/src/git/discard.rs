use std::path::PathBuf;

use git2::{build::CheckoutBuilder, Status, StatusOptions};

use super::repo::open_repo;

/// Resolve a possibly-absolute path the frontend passed to a repo-relative
/// path. The changes list hands us repo-relative paths, but other call sites
/// use absolute ones — accept both.
fn relativize(workdir: &std::path::Path, path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p.strip_prefix(workdir).map(|r| r.to_path_buf()).unwrap_or(p)
    } else {
        p
    }
}

/// Discard all changes to a single file: tracked files are reset to HEAD
/// (dropping both staged and unstaged edits for that path); a purely-untracked
/// file is deleted from disk. Irreversible — the UI must confirm first.
pub(crate) fn git_discard_file_impl(repo_path: String, path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repo has no working tree".to_string())?;
    let rel = relativize(workdir, &path);

    let status = repo
        .status_file(&rel)
        .map_err(|e| e.message().to_string())?;
    // Purely untracked (in the working tree, never staged) → just remove it.
    if status.contains(Status::WT_NEW) && !status.contains(Status::INDEX_NEW) {
        std::fs::remove_file(workdir.join(&rel)).map_err(|e| format!("remove: {e}"))?;
        return Ok(());
    }

    let mut co = CheckoutBuilder::new();
    co.force().remove_untracked(true).path(&rel);
    repo.checkout_head(Some(&mut co))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Discard every change in the working tree (reset tracked files to HEAD).
/// When `include_untracked`, also delete untracked files. Strongly
/// destructive — gated behind confirmation in the UI.
pub(crate) fn git_discard_all_impl(repo_path: String, include_untracked: bool) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repo has no working tree".to_string())?
        .to_path_buf();

    // Remove untracked files first — checkout_head won't touch them.
    if include_untracked {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false);
        let statuses = repo
            .statuses(Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
        for entry in statuses.iter() {
            if entry.status().contains(Status::WT_NEW) {
                if let Some(p) = entry.path() {
                    let _ = std::fs::remove_file(workdir.join(p));
                }
            }
        }
    }

    let mut co = CheckoutBuilder::new();
    co.force();
    repo.checkout_head(Some(&mut co))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}
