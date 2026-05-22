use git2::BranchType;

use super::repo::open_repo;
use super::{GitBranchInfo};

pub(crate) fn git_list_branches_impl(
    repo_path: String,
    include_remote: bool,
) -> Result<Vec<GitBranchInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let mut branches = Vec::new();

    let branch_types = if include_remote {
        vec![BranchType::Local, BranchType::Remote]
    } else {
        vec![BranchType::Local]
    };

    for btype in branch_types {
        let iter = repo
            .branches(Some(btype))
            .map_err(|e| e.message().to_string())?;
        for item in iter {
            let (branch, _) = item.map_err(|e| e.message().to_string())?;
            let name = branch
                .name()
                .map_err(|e| e.message().to_string())?
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let is_head = branch.is_head();
            let is_remote = btype == BranchType::Remote;

            let (upstream, ahead, behind) = if !is_remote {
                if let Ok(up) = branch.upstream() {
                    let up_name = up.name().ok().flatten().map(|s| s.to_string());
                    let local_oid = branch.get().target();
                    let up_oid = up.get().target();
                    let (a, b) = match (local_oid, up_oid) {
                        (Some(l), Some(u)) => repo.graph_ahead_behind(l, u).unwrap_or((0, 0)),
                        _ => (0, 0),
                    };
                    (up_name, a as u32, b as u32)
                } else {
                    (None, 0, 0)
                }
            } else {
                (None, 0, 0)
            };

            let (last_commit_summary, last_commit_time) =
                if let Some(oid) = branch.get().target() {
                    if let Ok(commit) = repo.find_commit(oid) {
                        (
                            commit.summary().map(|s| s.to_string()),
                            Some(commit.time().seconds()),
                        )
                    } else {
                        (None, None)
                    }
                } else {
                    (None, None)
                };

            branches.push(GitBranchInfo {
                name,
                is_head,
                is_remote,
                upstream,
                ahead,
                behind,
                last_commit_summary,
                last_commit_time,
            });
        }
    }

    branches.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(branches)
}

/// Create a branch at `start_point` (default HEAD) WITHOUT switching to it.
/// Distinct from checkout-with-create: this just adds the ref.
pub(crate) fn git_create_branch_impl(
    repo_path: String,
    name: String,
    start_point: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let start = start_point.as_deref().unwrap_or("HEAD");
    let target = repo
        .revparse_single(start)
        .map_err(|e| format!("could not resolve '{start}': {}", e.message()))?
        .peel_to_commit()
        .map_err(|e| e.message().to_string())?;
    repo.branch(&name, &target, false)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

/// Delete a local branch. Refuses the current HEAD. When the branch isn't fully
/// merged into its upstream/HEAD, returns a recognizable "not fully merged"
/// error unless `force` is set — the UI keys off that to offer a force path.
pub(crate) fn git_delete_branch_impl(
    repo_path: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut branch = repo
        .find_branch(&name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    if branch.is_head() {
        return Err("cannot delete the current branch".to_string());
    }

    if !force {
        // Consider a branch "merged" when HEAD is a descendant of its tip.
        let merged = match (branch.get().target(), repo.head().ok().and_then(|h| h.target())) {
            (Some(branch_oid), Some(head_oid)) => repo
                .graph_descendant_of(head_oid, branch_oid)
                .unwrap_or(false)
                || branch_oid == head_oid,
            _ => false,
        };
        if !merged {
            return Err(format!(
                "branch '{name}' is not fully merged — force to delete anyway"
            ));
        }
    }

    branch.delete().map_err(|e| e.message().to_string())
}

pub(crate) fn git_rename_branch_impl(
    repo_path: String,
    old_name: String,
    new_name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut branch = repo
        .find_branch(&old_name, BranchType::Local)
        .map_err(|e| e.message().to_string())?;
    branch
        .rename(&new_name, force)
        .map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_checkout_branch_impl(
    repo_path: String,
    branch: String,
    create: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;

    if create {
        let head = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        repo.branch(&branch, &head, false)
            .map_err(|e| e.message().to_string())?;
    }

    let treeish = repo
        .revparse_single(&format!("refs/heads/{}", branch))
        .map_err(|e| e.message().to_string())?;

    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder.safe();
    repo.checkout_tree(&treeish, Some(&mut checkout_builder))
        .map_err(|e| e.message().to_string())?;

    repo.set_head(&format!("refs/heads/{}", branch))
        .map_err(|e| e.message().to_string())?;

    Ok(())
}
