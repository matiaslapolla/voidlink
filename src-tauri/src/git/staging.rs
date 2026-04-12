use std::path::Path;

use super::repo::open_repo;

pub(crate) fn git_stage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();
    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    for path_str in &paths {
        let rel = Path::new(path_str);
        let abs = workdir.join(rel);
        if abs.exists() {
            index
                .add_path(rel)
                .map_err(|e| e.message().to_string())?;
        } else {
            index
                .remove_path(rel)
                .map_err(|e| e.message().to_string())?;
        }
    }

    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_stage_all_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_unstage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    for path_str in &paths {
        let rel = Path::new(path_str);
        match &head_tree {
            Some(tree) => {
                // Reset to HEAD version
                if let Some(entry) = tree.get_path(rel).ok() {
                    index
                        .add(&git2::IndexEntry {
                            ctime: git2::IndexTime::new(0, 0),
                            mtime: git2::IndexTime::new(0, 0),
                            dev: 0,
                            ino: 0,
                            mode: entry.filemode() as u32,
                            uid: 0,
                            gid: 0,
                            file_size: 0,
                            id: entry.id(),
                            flags: 0,
                            flags_extended: 0,
                            path: rel.to_string_lossy().as_bytes().to_vec(),
                        })
                        .map_err(|e| e.message().to_string())?;
                } else {
                    // File didn't exist in HEAD — remove from index
                    index.remove_path(rel).map_err(|e| e.message().to_string())?;
                }
            }
            None => {
                // No commits yet — remove from index
                index.remove_path(rel).map_err(|e| e.message().to_string())?;
            }
        }
    }

    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_commit_impl(repo_path: String, message: String) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| e.message().to_string())?;
    let sig = repo
        .signature()
        .map_err(|e| e.message().to_string())?;

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.message().to_string())?;

    Ok(oid.to_string())
}
