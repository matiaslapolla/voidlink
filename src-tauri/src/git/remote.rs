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
        match repo.find_remote(name) {
            Ok(remote) => out.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().map(|s| s.to_string()),
                push_url: remote.pushurl().map(|s| s.to_string()),
            }),
            // A remote listed in config that libgit2 cannot load (a malformed URL,
            // say) used to vanish from the list entirely, so the UI showed a
            // remote-less repo and the user had no way to fix the broken entry.
            // It is listed with no URL instead.
            Err(e) => {
                log::warn!("remote '{name}' could not be loaded: {e}");
                out.push(RemoteInfo {
                    name: name.to_string(),
                    url: None,
                    push_url: None,
                });
            }
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

/// Rename a remote, returning the refspecs libgit2 could **not** rewrite.
///
/// libgit2 updates the default `+refs/heads/*:refs/remotes/<name>/*` shape and
/// hands back anything non-default it left alone. Those still name the old
/// remote — a fetch that quietly goes nowhere — and the old code discarded the
/// list while its own comment admitted what it was throwing away.
pub(crate) fn git_rename_remote_impl(
    repo_path: String,
    old_name: String,
    new_name: String,
) -> Result<Vec<String>, String> {
    let repo = open_repo(&repo_path)?;
    let stranded = repo
        .remote_rename(&old_name, &new_name)
        .map_err(|e| e.message().to_string())?;
    Ok(stranded.iter().flatten().map(|s| s.to_string()).collect())
}

/// Point a remote at a new URL — including its push URL.
///
/// `remote_set_url` writes `remote.<name>.url` only. When a separate
/// `remote.<name>.pushurl` is configured it *wins* for pushes, so changing the
/// fetch URL alone left pushes going to the old host with nothing said about it.
pub(crate) fn git_set_remote_url_impl(
    repo_path: String,
    name: String,
    url: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let has_push_url = repo
        .find_remote(&name)
        .ok()
        .and_then(|r| r.pushurl().map(|u| u.to_string()))
        .is_some();

    repo.remote_set_url(&name, &url)
        .map_err(|e| e.message().to_string())?;
    if has_push_url {
        repo.remote_set_pushurl(&name, Some(&url))
            .map_err(|e| format!("fetch URL updated, but the push URL failed: {}", e.message()))?;
    }
    Ok(())
}
