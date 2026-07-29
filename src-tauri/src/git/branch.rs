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

            let (upstream, ahead, behind, ahead_behind_unknown) = if !is_remote {
                if let Ok(up) = branch.upstream() {
                    let up_name = up.name().ok().flatten().map(|s| s.to_string());
                    let local_oid = branch.get().target();
                    let up_oid = up.get().target();
                    // See repo.rs: a walk that cannot complete (shallow clone,
                    // missing objects) must not be reported as 0/0 "in sync".
                    let (a, b, unknown) = match (local_oid, up_oid) {
                        (Some(l), Some(u)) => match repo.graph_ahead_behind(l, u) {
                            Ok((a, b)) => (a, b, false),
                            Err(e) => {
                                log::warn!("ahead/behind for {name} unavailable: {e}");
                                (0, 0, true)
                            }
                        },
                        _ => (0, 0, false),
                    };
                    (up_name, a as u32, b as u32, unknown)
                } else {
                    (None, 0, 0, false)
                }
            } else {
                (None, 0, 0, false)
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
                ahead_behind_unknown,
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
    super::opstate::ensure_no_operation(&repo, "create a branch")?;
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
        let tip = branch
            .get()
            .target()
            .ok_or_else(|| format!("branch '{name}' has no commit to check"))?;
        if !is_merged_anywhere(&repo, &name, tip) {
            // The marker is what the UI keys off to offer the force path. It is
            // a stable token rather than English prose, because matching on a
            // sentence breaks the moment libgit2 or a locale rewords it.
            return Err(format!(
                "[not-fully-merged] branch '{name}' is not merged into any other branch — force to delete anyway"
            ));
        }
    }

    branch.delete().map_err(|e| e.message().to_string())
}

/// Is this branch's tip already contained in some other branch?
///
/// The old test was "is HEAD a descendant of the tip", which answered a
/// different and much narrower question: a branch merged into a *different*
/// branch, or already pushed and merged upstream, reported as unmerged, and on a
/// detached or unborn HEAD *every* branch did. The force prompt therefore fired
/// constantly and taught users to click through it — which is how a real
/// unmerged branch eventually gets force-deleted.
///
/// So: merged means any other local or remote-tracking ref contains this tip.
fn is_merged_anywhere(repo: &git2::Repository, name: &str, tip: git2::Oid) -> bool {
    let Ok(refs) = repo.references() else {
        return false;
    };
    for reference in refs.flatten() {
        let Some(ref_name) = reference.name() else {
            continue;
        };
        let is_branchy = ref_name.starts_with("refs/heads/") || ref_name.starts_with("refs/remotes/");
        if !is_branchy {
            continue;
        }
        // Skip the branch itself (and its own remote-tracking counterpart, which
        // is just "this same branch, pushed" — not evidence of a merge).
        if ref_name == format!("refs/heads/{name}") || ref_name.ends_with(&format!("/{name}")) {
            continue;
        }
        let Some(other) = reference.target() else {
            continue;
        };
        if other == tip || repo.graph_descendant_of(other, tip).unwrap_or(false) {
            return true;
        }
    }
    false
}

pub(crate) fn git_rename_branch_impl(
    repo_path: String,
    old_name: String,
    new_name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    // Renaming the branch a rebase is running on rewrites the ref its state
    // files point at, and `--continue` / `--abort` can then never find it again.
    super::opstate::ensure_no_operation(&repo, "rename a branch")?;
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
    super::opstate::ensure_no_operation(&repo, "switch branches")?;

    if create {
        let head = repo
            .head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?;
        repo.branch(&branch, &head, false)
            .map_err(|e| e.message().to_string())?;
    }

    switch_to_branch(&repo, &repo_path, &branch)
}

/// Point HEAD at `branch` and bring the working tree with it, atomically enough
/// that a failure leaves the repository where it started.
///
/// `checkout_tree` then `set_head` was two independent mutations: if `set_head`
/// failed, the working tree already held the *target* branch's content while HEAD
/// still named the old branch — every file then reads as modified, and the user
/// has no idea which branch they are on. Ordering it the other way round gives us
/// something to undo: HEAD moves first, and a failed checkout puts it back.
pub(crate) fn switch_to_branch(
    repo: &git2::Repository,
    repo_path: &str,
    branch: &str,
) -> Result<(), String> {
    let target_ref = format!("refs/heads/{branch}");
    let treeish = repo
        .revparse_single(&target_ref)
        .map_err(|e| format!("branch '{branch}': {}", e.message()))?;

    // What to restore if the checkout fails.
    let previous: Option<String> = repo
        .head()
        .ok()
        .and_then(|h| h.name().map(|n| n.to_string()));
    let previous_detached_at = if repo.head_detached().unwrap_or(false) {
        repo.head().ok().and_then(|h| h.target())
    } else {
        None
    };

    repo.set_head(&target_ref)
        .map_err(|e| e.message().to_string())?;

    let checkout = super::locking::retry_on_lock(repo_path, || {
        let mut builder = git2::build::CheckoutBuilder::new();
        builder.safe();
        repo.checkout_tree(&treeish, Some(&mut builder))
            .map_err(|e| e.message().to_string())
    });

    if let Err(e) = checkout {
        let restored = match (previous_detached_at, previous.as_deref()) {
            (Some(oid), _) => repo.set_head_detached(oid).is_ok(),
            (None, Some(name)) => repo.set_head(name).is_ok(),
            _ => false,
        };
        return Err(if restored {
            format!("could not switch to {branch}: {e} (HEAD left where it was)")
        } else {
            format!("could not switch to {branch}: {e} — and HEAD could not be restored, run `git checkout` by hand")
        });
    }
    Ok(())
}
