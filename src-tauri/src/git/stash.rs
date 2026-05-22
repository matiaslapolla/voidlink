use git2::StashFlags;
use serde::{Deserialize, Serialize};

use super::compare::git_diff_refs_impl;
use super::repo::open_repo;
use super::DiffResult;

/// One entry from the stash stack. `index` is the position (0 = most recent,
/// the `stash@{0}` git addresses by). `message` is the auto- or user-supplied
/// description; `oid` is the stash commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    pub oid: String,
}

pub(crate) fn git_stash_list_impl(repo_path: String) -> Result<Vec<StashEntry>, String> {
    // stash_foreach needs &mut Repository even though it only reads.
    let mut repo = open_repo(&repo_path)?;
    let mut out = Vec::new();
    repo.stash_foreach(|index, message, oid| {
        out.push(StashEntry {
            index,
            message: message.to_string(),
            oid: oid.to_string(),
        });
        true
    })
    .map_err(|e| e.message().to_string())?;
    Ok(out)
}

/// Save the working tree (and optionally untracked files) to a new stash.
/// `keep_index` leaves staged changes in the index after stashing.
pub(crate) fn git_stash_save_impl(
    repo_path: String,
    message: Option<String>,
    keep_index: bool,
    include_untracked: bool,
) -> Result<String, String> {
    let mut repo = open_repo(&repo_path)?;
    let sig = repo.signature().map_err(|e| e.message().to_string())?;
    let mut flags = StashFlags::DEFAULT;
    if keep_index {
        flags |= StashFlags::KEEP_INDEX;
    }
    if include_untracked {
        flags |= StashFlags::INCLUDE_UNTRACKED;
    }
    let oid = repo
        .stash_save2(&sig, message.as_deref(), Some(flags))
        .map_err(|e| e.message().to_string())?;
    Ok(oid.to_string())
}

pub(crate) fn git_stash_apply_impl(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    repo.stash_apply(index, None)
        .map_err(|e| e.message().to_string())
}

pub(crate) fn git_stash_pop_impl(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    repo.stash_pop(index, None)
        .map_err(|e| e.message().to_string())
}

pub(crate) fn git_stash_drop_impl(repo_path: String, index: usize) -> Result<(), String> {
    let mut repo = open_repo(&repo_path)?;
    repo.stash_drop(index).map_err(|e| e.message().to_string())
}

/// Diff a stash against the commit it was created from — reuses the ref-diff
/// machinery via the `stash@{N}` revision syntax.
pub(crate) fn git_stash_show_impl(repo_path: String, index: usize) -> Result<DiffResult, String> {
    let head = format!("stash@{{{index}}}");
    let base = format!("stash@{{{index}}}^1");
    git_diff_refs_impl(repo_path, base, head, false)
}
