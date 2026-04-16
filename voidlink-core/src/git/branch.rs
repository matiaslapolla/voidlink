use git2::BranchType;

use super::repo::open_repo;
use super::{GitBranchInfo};

pub fn git_list_branches_impl(
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

pub fn git_checkout_branch_impl(
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
