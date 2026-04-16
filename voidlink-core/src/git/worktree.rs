use git2::{BranchType, WorktreeAddOptions};

use super::repo::open_repo;
use super::status::git_file_status_impl;
use super::{CreateWorktreeInput, GitFileStatus, WorktreeInfo};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn git_create_worktree_impl(
    input: CreateWorktreeInput,
) -> Result<WorktreeInfo, String> {
    let repo = open_repo(&input.repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();

    let base_commit = if let Some(ref base_ref) = input.base_ref {
        repo.revparse_single(base_ref)
            .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", base_ref)))
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?
    } else {
        repo.head()
            .map_err(|e| e.message().to_string())?
            .peel_to_commit()
            .map_err(|e| e.message().to_string())?
    };

    let _branch = repo
        .branch(&input.branch_name, &base_commit, false)
        .or_else(|_| repo.find_branch(&input.branch_name, BranchType::Local))
        .map_err(|e| e.message().to_string())?;

    let worktree_path = workdir.join(".worktrees").join(&input.branch_name);
    if !worktree_path.parent().map(|p| p.exists()).unwrap_or(false) {
        std::fs::create_dir_all(worktree_path.parent().unwrap())
            .map_err(|e| e.to_string())?;
    }

    let branch_ref = repo
        .find_reference(&format!("refs/heads/{}", input.branch_name))
        .map_err(|e| e.message().to_string())?;

    let mut wt_opts_binding = WorktreeAddOptions::new();
    let add_opts = wt_opts_binding.reference(Some(&branch_ref));

    repo.worktree(&input.branch_name, &worktree_path, Some(add_opts))
        .map_err(|e| e.message().to_string())?;

    Ok(WorktreeInfo {
        name: input.branch_name.clone(),
        path: worktree_path.to_string_lossy().into_owned(),
        branch: Some(input.branch_name),
        is_locked: false,
        created_at: Some(now_secs()),
    })
}

pub fn git_list_worktrees_impl(
    repo_path: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let names = repo
        .worktrees()
        .map_err(|e| e.message().to_string())?;

    let mut result = Vec::new();
    for name in names.iter() {
        let name = match name {
            Some(n) => n,
            None => continue,
        };
        if let Ok(wt) = repo.find_worktree(name) {
            let path = wt.path().to_string_lossy().into_owned();
            let is_locked =
                matches!(wt.is_locked(), Ok(git2::WorktreeLockStatus::Locked(_)));
            result.push(WorktreeInfo {
                name: name.to_string(),
                path,
                branch: Some(name.to_string()),
                is_locked,
                created_at: None,
            });
        }
    }

    Ok(result)
}

pub fn git_remove_worktree_impl(
    repo_path: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();
    let worktree_path = workdir.join(".worktrees").join(&name);

    if worktree_path.exists() {
        std::fs::remove_dir_all(&worktree_path)
            .map_err(|e| format!("failed to remove worktree directory: {}", e))?;
    }

    if let Ok(wt) = repo.find_worktree(&name) {
        let mut prune_opts = git2::WorktreePruneOptions::new();
        prune_opts.working_tree(false);
        if force {
            prune_opts.locked(true);
        }
        wt.prune(Some(&mut prune_opts))
            .map_err(|e| e.message().to_string())?;
    }

    if let Ok(mut branch) = repo.find_branch(&name, BranchType::Local) {
        if force {
            let _ = branch.delete();
        }
    }

    Ok(())
}

pub fn git_worktree_status_impl(
    repo_path: String,
    name: String,
) -> Result<Vec<GitFileStatus>, String> {
    let main_repo = open_repo(&repo_path)?;
    let main_workdir = main_repo
        .workdir()
        .ok_or_else(|| "bare repos not supported".to_string())?;
    let wt_path = main_workdir.join(".worktrees").join(&name);
    git_file_status_impl(wt_path.to_string_lossy().into_owned())
}
