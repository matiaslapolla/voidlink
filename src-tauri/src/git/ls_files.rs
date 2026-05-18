use super::repo::open_repo;

/// Return all paths tracked in the git index, sorted. Used to feed the Cmd+P
/// fuzzy file picker. Untracked files are intentionally excluded — they're
/// visible in the file tree but rarely targets of "open file by name."
pub(crate) fn git_ls_files_impl(repo_path: String) -> Result<Vec<String>, String> {
    let repo = open_repo(&repo_path)?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    let mut paths: Vec<String> = index
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path).ok())
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}
