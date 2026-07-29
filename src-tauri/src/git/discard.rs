use std::path::PathBuf;

use git2::{build::CheckoutBuilder, Status, StatusOptions};

use super::repo::open_repo;

/// Resolve a possibly-absolute path the frontend passed to a repo-relative
/// path. The changes list hands us repo-relative paths, but other call sites
/// use absolute ones — accept both.
/// Resolve a possibly-absolute path the frontend passed to a repo-relative one.
///
/// The old fallback returned the *absolute* path when `strip_prefix` failed,
/// which libgit2 then treated as a pathspec matching nothing: on a symlinked or
/// otherwise uncanonicalized workdir (`/tmp` → `/private/tmp` on macOS) the
/// discard silently did nothing after the user had confirmed losing their work.
/// Now a path we cannot place inside the repo is an error, not a no-op.
fn relativize(workdir: &std::path::Path, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Ok(p);
    }
    if let Ok(rel) = p.strip_prefix(workdir) {
        return Ok(rel.to_path_buf());
    }
    // Second try with both sides canonicalized, which is what catches the
    // symlinked-workdir case.
    let canon_workdir = std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf());
    let canon_path = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
    canon_path
        .strip_prefix(&canon_workdir)
        .map(|rel| rel.to_path_buf())
        .map_err(|_| format!("'{path}' is not inside this repository — nothing was discarded"))
}

/// Discard all changes to a single file: tracked files are reset to HEAD
/// (dropping both staged and unstaged edits for that path); a purely-untracked
/// file is deleted from disk. Irreversible — the UI must confirm first.
pub(crate) fn git_discard_file_impl(repo_path: String, path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repo has no working tree".to_string())?;
    let rel = relativize(workdir, &path)?;

    let status = repo
        .status_file(&rel)
        .map_err(|e| e.message().to_string())?;
    // Purely untracked (in the working tree, never staged) → just remove it.
    if status.contains(Status::WT_NEW) && !status.contains(Status::INDEX_NEW) {
        return remove_untracked(&workdir.join(&rel));
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

    // Remove untracked files first — checkout_head won't touch them. Failures
    // used to be swallowed by `let _ =`, so a permissions error or a directory
    // entry left the file on disk while the UI reported a clean discard.
    if include_untracked {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false);
        let statuses = repo
            .statuses(Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
        let mut failures: Vec<String> = Vec::new();
        for entry in statuses.iter() {
            if entry.status().contains(Status::WT_NEW) {
                if let Some(p) = entry.path() {
                    if let Err(e) = remove_untracked(&workdir.join(p)) {
                        failures.push(e);
                    }
                }
            }
        }
        if !failures.is_empty() {
            return Err(format!(
                "could not delete {} untracked path(s): {}",
                failures.len(),
                failures.join("; ")
            ));
        }
    }

    super::locking::retry_on_lock(&repo_path, || {
        let mut co = CheckoutBuilder::new();
        co.force();
        repo.checkout_head(Some(&mut co))
            .map_err(|e| e.message().to_string())
    })?;
    Ok(())
}

/// Delete one untracked path, reporting *why* it failed.
///
/// Handles the three cases the old one-liner did not: a directory (an untracked
/// directory reported as a single entry), a file that vanished between the
/// status scan and here (which is the outcome we wanted, not a failure), and a
/// now-empty parent directory left behind after the file went.
fn remove_untracked(abs: &std::path::Path) -> Result<(), String> {
    let meta = match std::fs::symlink_metadata(abs) {
        Ok(m) => m,
        // Already gone: someone else did the work.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("{}: {e}", abs.display())),
    };

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(abs)
    } else {
        std::fs::remove_file(abs)
    };
    match result {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", abs.display())),
    }

    // Tidy the directory the file lived in when nothing else is left in it, so
    // discarding `a/b/new.txt` doesn't leave an empty `a/b` behind. Best-effort
    // and deliberately not recursive.
    if let Some(parent) = abs.parent() {
        if let Ok(mut entries) = std::fs::read_dir(parent) {
            if entries.next().is_none() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    Ok(())
}
