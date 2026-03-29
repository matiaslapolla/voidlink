use git2::{
    BranchType, Cred, CredentialType, DiffOptions, PushOptions, RemoteCallbacks,
    Repository, Sort, StatusOptions, WorktreeAddOptions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitState {
    /// Cache discovered repo root paths to speed up repeated calls.
    path_cache: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl GitState {
    pub fn new() -> Self {
        Self {
            path_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn resolve_repo_path(&self, repo_path: &str) -> Result<PathBuf, String> {
        {
            let cache = self.path_cache.lock().map_err(|e| e.to_string())?;
            if let Some(p) = cache.get(repo_path) {
                return Ok(p.clone());
            }
        }
        let repo = Repository::discover(repo_path).map_err(|e| e.message().to_string())?;
        let root = repo
            .workdir()
            .unwrap_or_else(|| repo.path())
            .to_path_buf();
        self.path_cache
            .lock()
            .map_err(|e| e.to_string())?
            .insert(repo_path.to_string(), root.clone());
        Ok(root)
    }
}

// ─── Phase 1 types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub repo_path: String,
    pub current_branch: Option<String>,
    pub head_oid: Option<String>,
    pub is_detached: bool,
    pub is_clean: bool,
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_summary: Option<String>,
    pub last_commit_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub oid: String,
    pub summary: String,
    pub body: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    pub parent_oids: Vec<String>,
}

// ─── Phase 2 types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub is_locked: bool,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorktreeInput {
    pub repo_path: String,
    pub branch_name: String,
    pub base_ref: Option<String>,
}

// ─── Phase 3 types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub origin: String,
    pub content: String,
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub status: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub files: Vec<FileDiff>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffExplanation {
    pub file_path: String,
    pub summary: String,
    pub risk_level: String,
    pub suggestions: Vec<String>,
}

// ─── Helper: open repo ───────────────────────────────────────────────────────

fn open_repo(path: &str) -> Result<Repository, String> {
    Repository::discover(path).map_err(|e| e.message().to_string())
}

// ─── Phase 1 commands ────────────────────────────────────────────────────────

pub fn git_repo_info_impl(repo_path: String) -> Result<GitRepoInfo, String> {
    let repo = open_repo(&repo_path)?;

    let head = repo.head().map_err(|e| e.message().to_string())?;
    let current_branch = if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    };
    let head_oid = head.target().map(|o| o.to_string());
    let is_detached = repo.head_detached().unwrap_or(false);

    let mut status_opts = StatusOptions::new();
    status_opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| e.message().to_string())?;
    let is_clean = statuses.is_empty();

    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|r| r.url().map(|u| u.to_string()));

    Ok(GitRepoInfo {
        repo_path,
        current_branch,
        head_oid,
        is_detached,
        is_clean,
        remote_url,
    })
}

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
                        (Some(l), Some(u)) => {
                            repo.graph_ahead_behind(l, u).unwrap_or((0, 0))
                        }
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

    // Sort: HEAD first, then alphabetical
    branches.sort_by(|a, b| {
        b.is_head
            .cmp(&a.is_head)
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(branches)
}

pub fn git_file_status_impl(repo_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&repo_path)?;

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| e.message().to_string())?;

    let mut result = Vec::new();
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let s = entry.status();

        let (status_str, staged) = if s.is_index_new() {
            ("added", true)
        } else if s.is_index_modified() {
            ("modified", true)
        } else if s.is_index_deleted() {
            ("deleted", true)
        } else if s.is_index_renamed() {
            ("renamed", true)
        } else if s.is_wt_new() {
            ("untracked", false)
        } else if s.is_wt_modified() {
            ("modified", false)
        } else if s.is_wt_deleted() {
            ("deleted", false)
        } else if s.is_wt_renamed() {
            ("renamed", false)
        } else if s.is_conflicted() {
            ("conflicted", false)
        } else {
            ("modified", false)
        };

        result.push(GitFileStatus {
            path,
            status: status_str.to_string(),
            staged,
        });
    }

    Ok(result)
}

pub fn git_log_impl(
    repo_path: String,
    branch: Option<String>,
    limit: u32,
) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&repo_path)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.message().to_string())?;

    if let Some(ref b) = branch {
        let oid = repo
            .revparse_single(b)
            .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", b)))
            .map_err(|e| e.message().to_string())?
            .id();
        revwalk.push(oid).map_err(|e| e.message().to_string())?;
    } else {
        revwalk.push_head().map_err(|e| e.message().to_string())?;
    }

    revwalk
        .set_sorting(Sort::TIME)
        .map_err(|e| e.message().to_string())?;

    let mut commits = Vec::new();
    for item in revwalk.take(limit as usize) {
        let oid = item.map_err(|e| e.message().to_string())?;
        let commit = repo
            .find_commit(oid)
            .map_err(|e| e.message().to_string())?;
        let author = commit.author();
        let parent_oids = commit
            .parent_ids()
            .map(|o| o.to_string())
            .collect();
        commits.push(GitCommitInfo {
            oid: oid.to_string(),
            summary: commit.summary().unwrap_or("").to_string(),
            body: commit
                .body()
                .filter(|b| !b.is_empty())
                .map(|b| b.to_string()),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            time: commit.time().seconds(),
            parent_oids,
        });
    }

    Ok(commits)
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

pub fn git_stage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
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

pub fn git_stage_all_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub fn git_commit_impl(repo_path: String, message: String) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index
        .write_tree()
        .map_err(|e| e.message().to_string())?;
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

pub fn git_push_impl(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin");

    let branch_name = match branch {
        Some(b) => b,
        None => {
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.shorthand()
                .ok_or_else(|| "HEAD is detached — specify a branch".to_string())?
                .to_string()
        }
    };

    let refspec = format!(
        "refs/heads/{}:refs/heads/{}",
        branch_name, branch_name
    );

    let mut remote_obj = repo
        .find_remote(remote_name)
        .map_err(|e| e.message().to_string())?;

    let mut tried_ssh = false;
    let mut tried_token = false;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username_from_url, allowed_types| {
        if allowed_types.contains(CredentialType::SSH_KEY) && !tried_ssh {
            tried_ssh = true;
            return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }
        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_token {
            tried_token = true;
            if let Ok(token) = std::env::var("GITHUB_TOKEN") {
                return Cred::userpass_plaintext("x-access-token", &token);
            }
        }
        Err(git2::Error::from_str(
            "push auth failed: set GITHUB_TOKEN or configure SSH agent",
        ))
    });

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    remote_obj
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| e.message().to_string())?;

    Ok(())
}

// ─── Phase 2 commands ────────────────────────────────────────────────────────

pub fn git_create_worktree_impl(input: CreateWorktreeInput) -> Result<WorktreeInfo, String> {
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

    // Create branch (may already exist)
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

    repo.worktree(
        &input.branch_name,
        &worktree_path,
        Some(add_opts),
    )
    .map_err(|e| e.message().to_string())?;

    Ok(WorktreeInfo {
        name: input.branch_name.clone(),
        path: worktree_path.to_string_lossy().into_owned(),
        branch: Some(input.branch_name),
        is_locked: false,
        created_at: Some(now_secs()),
    })
}

pub fn git_list_worktrees_impl(repo_path: String) -> Result<Vec<WorktreeInfo>, String> {
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
            let is_locked = matches!(wt.is_locked(), Ok(git2::WorktreeLockStatus::Locked(_)));
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

    // Remove the working directory if it exists
    if worktree_path.exists() {
        std::fs::remove_dir_all(&worktree_path)
            .map_err(|e| format!("failed to remove worktree directory: {}", e))?;
    }

    // Prune the worktree record
    if let Ok(wt) = repo.find_worktree(&name) {
        let mut prune_opts = git2::WorktreePruneOptions::new();
        prune_opts.working_tree(false);
        if force {
            prune_opts.locked(true);
        }
        wt.prune(Some(&mut prune_opts))
            .map_err(|e| e.message().to_string())?;
    }

    // Optionally delete the branch
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

// ─── Phase 3 commands ────────────────────────────────────────────────────────

pub fn git_diff_working_impl(
    repo_path: String,
    staged_only: bool,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let diff = if staged_only {
        repo.diff_tree_to_index(head_tree.as_ref(), None, None)
            .map_err(|e| e.message().to_string())?
    } else {
        let mut opts = DiffOptions::new();
        opts.include_untracked(true);
        repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            .map_err(|e| e.message().to_string())?
    };

    collect_diff(diff)
}

pub fn git_diff_branches_impl(
    repo_path: String,
    base: String,
    head: String,
) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;

    let base_tree = repo
        .revparse_single(&base)
        .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", base)))
        .map_err(|e| e.message().to_string())?
        .peel_to_tree()
        .map_err(|e| e.message().to_string())?;

    let head_tree = repo
        .revparse_single(&head)
        .or_else(|_| repo.revparse_single(&format!("refs/heads/{}", head)))
        .map_err(|e| e.message().to_string())?
        .peel_to_tree()
        .map_err(|e| e.message().to_string())?;

    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)
        .map_err(|e| e.message().to_string())?;

    collect_diff(diff)
}

pub fn git_diff_commit_impl(repo_path: String, oid: String) -> Result<DiffResult, String> {
    let repo = open_repo(&repo_path)?;
    let commit_oid = git2::Oid::from_str(&oid).map_err(|e| e.message().to_string())?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|e| e.message().to_string())?;
    let commit_tree = commit.tree().map_err(|e| e.message().to_string())?;

    let parent_tree = if commit.parent_count() > 0 {
        Some(
            commit
                .parent(0)
                .map_err(|e| e.message().to_string())?
                .tree()
                .map_err(|e| e.message().to_string())?,
        )
    } else {
        None
    };

    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)
        .map_err(|e| e.message().to_string())?;

    collect_diff(diff)
}

pub fn git_explain_diff_impl(
    repo_path: String,
    base: String,
    head: String,
    migration_state: &crate::migration::MigrationState,
) -> Result<Vec<DiffExplanation>, String> {
    let diff_result = git_diff_branches_impl(repo_path, base, head)?;

    if diff_result.files.is_empty() {
        return Ok(vec![]);
    }

    // Build per-file diff text for LLM
    let mut explanations = Vec::new();
    let batch_size = 5;

    for chunk in diff_result.files.chunks(batch_size) {
        let mut file_summaries = Vec::new();
        for file in chunk {
            let path = file
                .new_path
                .as_deref()
                .or(file.old_path.as_deref())
                .unwrap_or("unknown");
            let diff_text: String = file
                .hunks
                .iter()
                .flat_map(|h| {
                    h.lines.iter().map(|l| {
                        format!("{}{}", l.origin, l.content)
                    })
                })
                .collect();
            file_summaries.push(format!(
                "File: {}\nStatus: {}\n+{} -{}\n\n{}",
                path,
                file.status,
                file.additions,
                file.deletions,
                &diff_text[..diff_text.len().min(2000)]
            ));
        }

        let prompt = format!(
            r#"Analyze these code changes and return a JSON array with one object per file.
Each object must have: file_path (string), summary (1-2 sentence description), risk_level ("low"|"medium"|"high"), suggestions (array of strings, max 3).

Changes to analyze:
{}

Return ONLY a JSON array, no other text."#,
            file_summaries.join("\n---\n")
        );

        match migration_state.llm_chat(&prompt, true) {
            Ok(raw) => {
                if let Ok(parsed) = serde_json::from_str::<Vec<Value>>(&raw) {
                    for item in parsed {
                        let file_path = item["file_path"]
                            .as_str()
                            .unwrap_or("unknown")
                            .to_string();
                        let summary = item["summary"]
                            .as_str()
                            .unwrap_or("No summary available")
                            .to_string();
                        let risk_level = item["risk_level"]
                            .as_str()
                            .unwrap_or("low")
                            .to_string();
                        let suggestions = item["suggestions"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();
                        explanations.push(DiffExplanation {
                            file_path,
                            summary,
                            risk_level,
                            suggestions,
                        });
                    }
                } else {
                    // Fallback: add basic explanations
                    for file in chunk {
                        let file_path = file
                            .new_path
                            .as_deref()
                            .or(file.old_path.as_deref())
                            .unwrap_or("unknown")
                            .to_string();
                        explanations.push(DiffExplanation {
                            file_path,
                            summary: format!(
                                "{} (+{} -{})",
                                file.status, file.additions, file.deletions
                            ),
                            risk_level: "low".to_string(),
                            suggestions: vec![],
                        });
                    }
                }
            }
            Err(_) => {
                for file in chunk {
                    let file_path = file
                        .new_path
                        .as_deref()
                        .or(file.old_path.as_deref())
                        .unwrap_or("unknown")
                        .to_string();
                    explanations.push(DiffExplanation {
                        file_path,
                        summary: format!(
                            "{} (+{} -{})",
                            file.status, file.additions, file.deletions
                        ),
                        risk_level: "low".to_string(),
                        suggestions: vec![],
                    });
                }
            }
        }
    }

    Ok(explanations)
}

// ─── Internal diff helpers ───────────────────────────────────────────────────

fn collect_diff(diff: git2::Diff) -> Result<DiffResult, String> {
    // Use RefCell for interior mutability across multiple closures
    let files: RefCell<Vec<FileDiff>> = RefCell::new(Vec::new());

    diff.foreach(
        &mut |delta, _progress| {
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Modified => "modified",
                git2::Delta::Renamed => "renamed",
                git2::Delta::Copied => "copied",
                _ => "modified",
            };
            files.borrow_mut().push(FileDiff {
                old_path,
                new_path,
                status: status.to_string(),
                hunks: vec![],
                is_binary: delta.old_file().is_binary() || delta.new_file().is_binary(),
                additions: 0,
                deletions: 0,
            });
            true
        },
        Some(&mut |_delta, _progress| {
            // binary file callback — no-op, just continue
            true
        }),
        Some(&mut |_delta, hunk| {
            if let Some(file) = files.borrow_mut().last_mut() {
                let header = std::str::from_utf8(hunk.header())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                file.hunks.push(DiffHunk {
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_start: hunk.new_start(),
                    new_lines: hunk.new_lines(),
                    header,
                    lines: vec![],
                });
            }
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            if let Some(file) = files.borrow_mut().last_mut() {
                let origin = match line.origin() {
                    '+' => "+",
                    '-' => "-",
                    ' ' => " ",
                    _ => "~",
                };
                let content = std::str::from_utf8(line.content())
                    .unwrap_or("")
                    .trim_end_matches('\n')
                    .to_string();
                match line.origin() {
                    '+' => file.additions += 1,
                    '-' => file.deletions += 1,
                    _ => {}
                }
                if let Some(hunk) = file.hunks.last_mut() {
                    hunk.lines.push(DiffLine {
                        origin: origin.to_string(),
                        content,
                        old_lineno: line.old_lineno(),
                        new_lineno: line.new_lineno(),
                    });
                }
            }
            true
        }),
    )
    .map_err(|e| e.message().to_string())?;

    let files = files.into_inner();
    let total_additions: u32 = files.iter().map(|f| f.additions).sum();
    let total_deletions: u32 = files.iter().map(|f| f.deletions).sum();

    Ok(DiffResult {
        files,
        total_additions,
        total_deletions,
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ─── Tauri command wrappers ───────────────────────────────────────────────────

#[tauri::command]
pub fn git_repo_info(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<GitRepoInfo, String> {
    git_repo_info_impl(repo_path)
}

#[tauri::command]
pub fn git_list_branches(
    repo_path: String,
    include_remote: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitBranchInfo>, String> {
    git_list_branches_impl(repo_path, include_remote.unwrap_or(false))
}

#[tauri::command]
pub fn git_file_status(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitFileStatus>, String> {
    git_file_status_impl(repo_path)
}

#[tauri::command]
pub fn git_log(
    repo_path: String,
    branch: Option<String>,
    limit: Option<u32>,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitCommitInfo>, String> {
    git_log_impl(repo_path, branch, limit.unwrap_or(50))
}

#[tauri::command]
pub fn git_checkout_branch(
    repo_path: String,
    branch: String,
    create: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_checkout_branch_impl(repo_path, branch, create.unwrap_or(false))
}

#[tauri::command]
pub fn git_stage_files(
    repo_path: String,
    paths: Vec<String>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_stage_files_impl(repo_path, paths)
}

#[tauri::command]
pub fn git_stage_all(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_stage_all_impl(repo_path)
}

#[tauri::command]
pub fn git_commit(
    repo_path: String,
    message: String,
    _state: tauri::State<GitState>,
) -> Result<String, String> {
    git_commit_impl(repo_path, message)
}

#[tauri::command]
pub fn git_push(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_push_impl(repo_path, remote, branch)
}

#[tauri::command]
pub fn git_create_worktree(
    input: CreateWorktreeInput,
    _state: tauri::State<GitState>,
) -> Result<WorktreeInfo, String> {
    git_create_worktree_impl(input)
}

#[tauri::command]
pub fn git_list_worktrees(
    repo_path: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<WorktreeInfo>, String> {
    git_list_worktrees_impl(repo_path)
}

#[tauri::command]
pub fn git_remove_worktree(
    repo_path: String,
    name: String,
    force: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<(), String> {
    git_remove_worktree_impl(repo_path, name, force.unwrap_or(false))
}

#[tauri::command]
pub fn git_worktree_status(
    repo_path: String,
    name: String,
    _state: tauri::State<GitState>,
) -> Result<Vec<GitFileStatus>, String> {
    git_worktree_status_impl(repo_path, name)
}

#[tauri::command]
pub fn git_diff_working(
    repo_path: String,
    staged_only: Option<bool>,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_working_impl(repo_path, staged_only.unwrap_or(false))
}

#[tauri::command]
pub fn git_diff_branches(
    repo_path: String,
    base: String,
    head: String,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_branches_impl(repo_path, base, head)
}

#[tauri::command]
pub fn git_diff_commit(
    repo_path: String,
    oid: String,
    _state: tauri::State<GitState>,
) -> Result<DiffResult, String> {
    git_diff_commit_impl(repo_path, oid)
}

#[tauri::command]
pub fn git_explain_diff(
    repo_path: String,
    base: String,
    head: String,
    _git_state: tauri::State<GitState>,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<Vec<DiffExplanation>, String> {
    git_explain_diff_impl(repo_path, base, head, &migration_state)
}
