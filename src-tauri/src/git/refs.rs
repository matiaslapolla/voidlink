use git2::{BranchType, Sort};

use super::repo::open_repo;
use super::{RecentCommit, RefList};

const RECENT_COMMITS_LIMIT: usize = 50;

/// Build the data feeding the ref-picker autocomplete: branches (local + remote),
/// tags, and the most recent commits across the whole repo.
///
/// The picker still accepts free text — this is just the suggestion list.
pub(crate) fn git_list_refs_impl(repo_path: String) -> Result<RefList, String> {
    let repo = open_repo(&repo_path)?;

    let mut branches = Vec::new();
    let iter = repo
        .branches(None)
        .map_err(|e| e.message().to_string())?;
    for item in iter {
        let (branch, btype) = item.map_err(|e| e.message().to_string())?;
        let raw = branch.name().map_err(|e| e.message().to_string())?;
        let Some(name) = raw else { continue };
        if name.is_empty() {
            continue;
        }
        // Remote refs come back as "origin/main" — that form is what
        // revparse_single accepts directly, so we keep the prefix.
        let entry = match btype {
            BranchType::Local => name.to_string(),
            BranchType::Remote => name.to_string(),
        };
        branches.push(entry);
    }
    branches.sort();
    branches.dedup();

    let mut tags = Vec::new();
    repo.tag_foreach(|_oid, name_bytes| {
        if let Ok(name) = std::str::from_utf8(name_bytes) {
            // Strip "refs/tags/" prefix to get the bare tag name.
            let bare = name.strip_prefix("refs/tags/").unwrap_or(name);
            tags.push(bare.to_string());
        }
        true
    })
    .map_err(|e| e.message().to_string())?;
    tags.sort();
    tags.dedup();

    let mut recent_commits = Vec::new();
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TIME).ok();
    // Walk all refs so commits unique to feature branches still show up.
    if walk.push_glob("refs/heads/*").is_ok() || walk.push_head().is_ok() {
        for oid in walk.take(RECENT_COMMITS_LIMIT).flatten() {
            let Ok(commit) = repo.find_commit(oid) else { continue };
            recent_commits.push(RecentCommit {
                oid: oid.to_string(),
                short_oid: oid.to_string().chars().take(7).collect(),
                summary: commit.summary().unwrap_or("").to_string(),
                time: commit.time().seconds(),
            });
        }
    }

    Ok(RefList {
        branches,
        tags,
        recent_commits,
    })
}
