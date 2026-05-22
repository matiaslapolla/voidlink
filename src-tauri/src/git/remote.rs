use serde::{Deserialize, Serialize};

use super::repo::open_repo;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

pub(crate) fn git_list_remotes_impl(repo_path: String) -> Result<Vec<RemoteInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let names = repo.remotes().map_err(|e| e.message().to_string())?;
    let mut out = Vec::new();
    for name in names.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            out.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().map(|s| s.to_string()),
                push_url: remote.pushurl().map(|s| s.to_string()),
            });
        }
    }
    Ok(out)
}

pub(crate) fn git_add_remote_impl(
    repo_path: String,
    name: String,
    url: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    repo.remote(&name, &url)
        .map(|_| ())
        .map_err(|e| e.message().to_string())
}

pub(crate) fn git_remove_remote_impl(repo_path: String, name: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    repo.remote_delete(&name)
        .map_err(|e| e.message().to_string())
}

pub(crate) fn git_rename_remote_impl(
    repo_path: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    // remote_rename returns the list of non-default refspecs it couldn't
    // update; we surface success regardless since the rename itself succeeded.
    repo.remote_rename(&old_name, &new_name)
        .map(|_| ())
        .map_err(|e| e.message().to_string())
}

pub(crate) fn git_set_remote_url_impl(
    repo_path: String,
    name: String,
    url: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    repo.remote_set_url(&name, &url)
        .map_err(|e| e.message().to_string())
}
