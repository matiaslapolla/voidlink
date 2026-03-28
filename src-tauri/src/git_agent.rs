use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::git::{
    git_commit_impl, git_create_worktree_impl, git_push_impl, git_stage_all_impl,
    CreateWorktreeInput,
};
use crate::migration::MigrationState;

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitAgentState {
    tasks: Arc<Mutex<HashMap<String, AgentTaskState>>>,
}

impl GitAgentState {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskInput {
    pub repo_path: String,
    pub objective: String,
    pub branch_name: Option<String>,
    pub base_ref: Option<String>,
    pub constraints: Vec<String>,
    pub auto_pr: bool,
    pub github_base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTaskState {
    pub task_id: String,
    pub status: String,
    pub branch_name: Option<String>,
    pub worktree_path: Option<String>,
    pub pr_url: Option<String>,
    pub steps_completed: Vec<String>,
    pub current_step: Option<String>,
    pub events: Vec<AgentEvent>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub id: String,
    pub level: String,
    pub message: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDescription {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub migration_notes: Option<String>,
    pub test_plan: Option<String>,
}

// ─── GitHub helpers ───────────────────────────────────────────────────────────

/// Parse "owner/repo" from a remote URL.
pub fn parse_github_owner_repo(remote_url: &str) -> Option<(String, String)> {
    // HTTPS: https://github.com/owner/repo.git
    // SSH:   git@github.com:owner/repo.git
    let stripped = remote_url
        .trim_end_matches(".git")
        .trim_end_matches('/');

    if let Some(after_github) = stripped.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = after_github.splitn(2, '/').collect();
        if parts.len() == 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    if let Some(after_colon) = stripped.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = after_colon.splitn(2, '/').collect();
        if parts.len() == 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    None
}

fn github_client() -> Option<(Client, String, String, String)> {
    let token = std::env::var("GITHUB_TOKEN").ok()?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .ok()?;
    Some((client, token, String::new(), String::new()))
}

pub fn create_github_pr(
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head_branch: &str,
    base_branch: &str,
    draft: bool,
) -> Result<String, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN environment variable not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.github.com/repos/{}/{}/pulls", owner, repo);
    let payload = json!({
        "title": title,
        "body": body,
        "head": head_branch,
        "base": base_branch,
        "draft": draft,
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API error {}: {}", status, body_text));
    }

    let parsed: Value =
        serde_json::from_str(&body_text).map_err(|e| e.to_string())?;
    parsed["html_url"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "PR created but no URL returned".to_string())
}

// ─── Internal agent pipeline ──────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn make_event(level: &str, message: &str) -> AgentEvent {
    AgentEvent {
        id: Uuid::new_v4().to_string(),
        level: level.to_string(),
        message: message.to_string(),
        created_at: now_ms(),
    }
}

fn update_task<F>(
    tasks: &Arc<Mutex<HashMap<String, AgentTaskState>>>,
    task_id: &str,
    f: F,
) where
    F: FnOnce(&mut AgentTaskState),
{
    if let Ok(mut guard) = tasks.lock() {
        if let Some(task) = guard.get_mut(task_id) {
            f(task);
        }
    }
}

fn run_agent_pipeline(
    task_id: String,
    input: AgentTaskInput,
    tasks: Arc<Mutex<HashMap<String, AgentTaskState>>>,
    migration_state: MigrationState,
    app_handle: tauri::AppHandle,
) {
    use tauri::Emitter;

    macro_rules! emit_event {
        ($level:expr, $msg:expr) => {{
            let ev = make_event($level, $msg);
            let _ = app_handle.emit(
                &format!("git-agent-event:{}", task_id),
                serde_json::to_value(&ev).unwrap_or_default(),
            );
            update_task(&tasks, &task_id, |t| {
                t.events.push(ev);
            });
        }};
    }

    macro_rules! set_step {
        ($step:expr) => {
            update_task(&tasks, &task_id, |t| {
                t.current_step = Some($step.to_string());
            });
            emit_event!("info", &format!("Step: {}", $step));
        };
    }

    macro_rules! fail {
        ($err:expr) => {{
            let msg = $err.to_string();
            emit_event!("error", &msg);
            update_task(&tasks, &task_id, |t| {
                t.status = "failed".to_string();
                t.error = Some(msg.clone());
                t.current_step = None;
            });
            return;
        }};
    }

    // ── Step 1: Generate/validate branch name ────────────────────────────────
    update_task(&tasks, &task_id, |t| {
        t.status = "branching".to_string();
    });
    set_step!("generating branch name");

    let branch_name = if let Some(ref b) = input.branch_name {
        b.clone()
    } else {
        let prompt = format!(
            "Generate a short git branch name (kebab-case, max 40 chars, no spaces) for this task: {}\nReturn ONLY the branch name, nothing else.",
            input.objective
        );
        let slug = migration_state
            .llm_chat(&prompt, false)
            .unwrap_or_else(|_| "ai-task".to_string())
            .trim()
            .to_lowercase()
            .replace(' ', "-")
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == '-')
            .take(36)
            .collect::<String>();
        let short_id = &Uuid::new_v4().to_string()[..8];
        format!("ai/{}-{}", slug.trim_matches('-'), short_id)
    };

    update_task(&tasks, &task_id, |t| {
        t.branch_name = Some(branch_name.clone());
    });
    emit_event!("info", &format!("Branch name: {}", branch_name));

    // ── Step 2: Create worktree ───────────────────────────────────────────────
    set_step!("creating worktree");
    let worktree_input = CreateWorktreeInput {
        repo_path: input.repo_path.clone(),
        branch_name: branch_name.clone(),
        base_ref: input.base_ref.clone(),
    };
    let worktree_info = match git_create_worktree_impl(worktree_input) {
        Ok(wt) => wt,
        Err(e) => fail!(format!("failed to create worktree: {}", e)),
    };

    let worktree_path = worktree_info.path.clone();
    update_task(&tasks, &task_id, |t| {
        t.worktree_path = Some(worktree_path.clone());
        t.steps_completed.push("worktree_created".to_string());
    });
    emit_event!("info", &format!("Worktree created at: {}", worktree_path));

    // ── Step 3: Generate and apply file changes ───────────────────────────────
    update_task(&tasks, &task_id, |t| {
        t.status = "implementing".to_string();
    });
    set_step!("generating implementation");

    let constraints_text = if input.constraints.is_empty() {
        String::new()
    } else {
        format!("\nConstraints:\n{}", input.constraints.join("\n"))
    };

    // Gather context files (top-level listing)
    let file_listing = list_files_brief(&worktree_path, 50);

    let implement_prompt = format!(
        r#"You are a software engineer implementing a task in a git worktree.
Repository files (partial):
{}

Objective: {}{}

Generate specific file changes to implement this objective.
Return ONLY a JSON array of objects, each with:
- "file_path": relative path from repo root (string)
- "content": complete new file content (string)
- "action": "create"|"modify"|"delete"

Focus on minimal, targeted changes. Return at most 5 files."#,
        file_listing, input.objective, constraints_text
    );

    let changes: Vec<Value> = match migration_state.llm_chat(&implement_prompt, true) {
        Ok(raw) => serde_json::from_str::<Vec<Value>>(&raw).unwrap_or_default(),
        Err(e) => {
            emit_event!("warn", &format!("LLM implementation failed: {}. No files will be modified.", e));
            vec![]
        }
    };

    let mut files_changed = 0;
    for change in &changes {
        let file_path = match change["file_path"].as_str() {
            Some(p) => p,
            None => continue,
        };
        let action = change["action"].as_str().unwrap_or("modify");
        let abs_path = std::path::Path::new(&worktree_path).join(file_path);

        match action {
            "delete" => {
                if abs_path.exists() {
                    if let Err(e) = std::fs::remove_file(&abs_path) {
                        emit_event!("warn", &format!("Failed to delete {}: {}", file_path, e));
                    } else {
                        files_changed += 1;
                        emit_event!("info", &format!("Deleted: {}", file_path));
                    }
                }
            }
            _ => {
                if let Some(content) = change["content"].as_str() {
                    if let Some(parent) = abs_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Err(e) = std::fs::write(&abs_path, content) {
                        emit_event!("warn", &format!("Failed to write {}: {}", file_path, e));
                    } else {
                        files_changed += 1;
                        emit_event!("info", &format!("{}: {}", action, file_path));
                    }
                }
            }
        }
    }

    emit_event!("info", &format!("Modified {} files", files_changed));

    update_task(&tasks, &task_id, |t| {
        t.steps_completed.push("implementation_applied".to_string());
    });

    // ── Step 4: Stage and commit ──────────────────────────────────────────────
    set_step!("committing changes");
    if files_changed == 0 {
        emit_event!("warn", "No files changed — creating empty commit marker");
    }

    let commit_msg_prompt = format!(
        "Write a concise git commit message (max 72 chars, imperative mood) for: {}\nReturn ONLY the message, no quotes.",
        input.objective
    );
    let commit_message = migration_state
        .llm_chat(&commit_msg_prompt, false)
        .unwrap_or_else(|_| format!("ai: {}", &input.objective[..input.objective.len().min(50)]))
        .trim()
        .to_string();

    if files_changed > 0 {
        if let Err(e) = git_stage_all_impl(worktree_path.clone()) {
            fail!(format!("failed to stage files: {}", e));
        }
        if let Err(e) = git_commit_impl(worktree_path.clone(), commit_message.clone()) {
            fail!(format!("failed to commit: {}", e));
        }
        emit_event!("info", &format!("Committed: {}", commit_message));
        update_task(&tasks, &task_id, |t| {
            t.steps_completed.push("committed".to_string());
        });
    }

    // ── Step 5: Push ──────────────────────────────────────────────────────────
    set_step!("pushing branch");
    match git_push_impl(worktree_path.clone(), None, Some(branch_name.clone())) {
        Ok(()) => {
            emit_event!("info", "Branch pushed to origin");
            update_task(&tasks, &task_id, |t| {
                t.steps_completed.push("pushed".to_string());
            });
        }
        Err(e) => {
            emit_event!("warn", &format!("Push failed (continuing without PR): {}", e));
            // Don't fail — user can push manually
        }
    }

    // ── Step 6: Create PR ─────────────────────────────────────────────────────
    if input.auto_pr {
        update_task(&tasks, &task_id, |t| {
            t.status = "pr_creating".to_string();
        });
        set_step!("creating pull request");

        // Get remote URL for owner/repo parsing
        if let Ok(repo_obj) = git2::Repository::discover(&input.repo_path) {
            if let Ok(remote) = repo_obj.find_remote("origin") {
                if let Some(url) = remote.url() {
                    if let Some((owner, repo_name)) = parse_github_owner_repo(url) {
                        // Generate PR description
                        let pr_prompt = format!(
                            r#"Write a GitHub pull request description for this change.
Objective: {}
Constraints: {}
Files changed: {}

Return a JSON object with:
- "title": PR title (max 72 chars)
- "body": PR body in markdown (include Summary, Changes Made, Test Plan sections)
- "labels": array of relevant labels (e.g. ["enhancement", "ai-generated"])
- "migration_notes": any migration/breaking change notes (or null)
- "test_plan": testing steps (or null)"#,
                            input.objective,
                            input.constraints.join(", "),
                            files_changed
                        );

                        let pr_desc = match migration_state.llm_chat(&pr_prompt, true) {
                            Ok(raw) => {
                                serde_json::from_str::<Value>(&raw).ok().and_then(|v| {
                                    Some(PrDescription {
                                        title: v["title"]
                                            .as_str()
                                            .unwrap_or("AI-generated change")
                                            .to_string(),
                                        body: v["body"]
                                            .as_str()
                                            .unwrap_or("")
                                            .to_string(),
                                        labels: v["labels"]
                                            .as_array()
                                            .map(|a| {
                                                a.iter()
                                                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                                    .collect()
                                            })
                                            .unwrap_or_else(|| vec!["ai-generated".to_string()]),
                                        migration_notes: v["migration_notes"]
                                            .as_str()
                                            .map(|s| s.to_string()),
                                        test_plan: v["test_plan"]
                                            .as_str()
                                            .map(|s| s.to_string()),
                                    })
                                })
                            }
                            Err(_) => None,
                        };

                        let pr_desc = pr_desc.unwrap_or(PrDescription {
                            title: format!(
                                "AI: {}",
                                &input.objective[..input.objective.len().min(60)]
                            ),
                            body: format!(
                                "## Summary\n\nAI-generated implementation of: {}\n\n## Changes\n\n{} files modified",
                                input.objective, files_changed
                            ),
                            labels: vec!["ai-generated".to_string()],
                            migration_notes: None,
                            test_plan: None,
                        });

                        let base_branch = input
                            .github_base_branch
                            .as_deref()
                            .unwrap_or("main");

                        match create_github_pr(
                            &owner,
                            &repo_name,
                            &pr_desc.title,
                            &pr_desc.body,
                            &branch_name,
                            base_branch,
                            true, // draft
                        ) {
                            Ok(pr_url) => {
                                emit_event!("info", &format!("Draft PR created: {}", pr_url));
                                update_task(&tasks, &task_id, |t| {
                                    t.pr_url = Some(pr_url.clone());
                                    t.steps_completed.push("pr_created".to_string());
                                });
                            }
                            Err(e) => {
                                emit_event!("warn", &format!("PR creation failed: {}", e));
                            }
                        }
                    } else {
                        emit_event!("warn", "Could not parse GitHub owner/repo from remote URL");
                    }
                }
            }
        }
    }

    // ── Done ─────────────────────────────────────────────────────────────────
    update_task(&tasks, &task_id, |t| {
        t.status = "success".to_string();
        t.current_step = None;
    });
    emit_event!("info", "Agent task completed successfully");
}

fn list_files_brief(path: &str, max: usize) -> String {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten().take(max * 2) {
            if let Ok(name) = entry.file_name().into_string() {
                if !name.starts_with('.') {
                    files.push(name);
                }
            }
        }
    }
    files.truncate(max);
    files.join(", ")
}

// ─── Tauri command wrappers ───────────────────────────────────────────────────

#[tauri::command]
pub fn git_agent_start(
    input: AgentTaskInput,
    state: tauri::State<GitAgentState>,
    migration_state: tauri::State<crate::migration::MigrationState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let task_id = Uuid::new_v4().to_string();
    let initial_state = AgentTaskState {
        task_id: task_id.clone(),
        status: "pending".to_string(),
        branch_name: input.branch_name.clone(),
        worktree_path: None,
        pr_url: None,
        steps_completed: vec![],
        current_step: None,
        events: vec![make_event("info", "Task queued")],
        error: None,
    };

    state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .insert(task_id.clone(), initial_state);

    let tasks_clone = Arc::clone(&state.tasks);
    let migration_clone = migration_state.inner().clone();
    let task_id_clone = task_id.clone();
    let input_clone = input;

    std::thread::spawn(move || {
        run_agent_pipeline(
            task_id_clone,
            input_clone,
            tasks_clone,
            migration_clone,
            app_handle,
        );
    });

    Ok(task_id)
}

#[tauri::command]
pub fn git_agent_status(
    task_id: String,
    state: tauri::State<GitAgentState>,
) -> Result<AgentTaskState, String> {
    state
        .tasks
        .lock()
        .map_err(|e| e.to_string())?
        .get(&task_id)
        .cloned()
        .ok_or_else(|| format!("task {} not found", task_id))
}

#[tauri::command]
pub fn git_agent_cancel(
    task_id: String,
    state: tauri::State<GitAgentState>,
) -> Result<(), String> {
    let mut guard = state.tasks.lock().map_err(|e| e.to_string())?;
    if let Some(task) = guard.get_mut(&task_id) {
        if task.status == "pending"
            || task.status == "branching"
            || task.status == "implementing"
        {
            task.status = "failed".to_string();
            task.error = Some("Cancelled by user".to_string());
            task.current_step = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn git_generate_pr_description(
    repo_path: String,
    base: String,
    head: String,
    _git_state: tauri::State<crate::git::GitState>,
    migration_state: tauri::State<crate::migration::MigrationState>,
) -> Result<PrDescription, String> {
    let diff = crate::git::git_diff_branches_impl(repo_path, base, head)?;

    let diff_summary: String = diff
        .files
        .iter()
        .map(|f| {
            format!(
                "- {} {} (+{} -{})",
                f.status,
                f.new_path.as_deref().or(f.old_path.as_deref()).unwrap_or("?"),
                f.additions,
                f.deletions,
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = format!(
        r#"Generate a GitHub pull request description for these changes.

Changed files:
{}

Return JSON with: title (string), body (markdown string with Summary/Changes/Test Plan sections), labels (string array), migration_notes (string or null), test_plan (string or null)"#,
        diff_summary
    );

    let raw = migration_state.llm_chat(&prompt, true)?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    Ok(PrDescription {
        title: v["title"]
            .as_str()
            .unwrap_or("Code changes")
            .to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        labels: v["labels"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        migration_notes: v["migration_notes"].as_str().map(|s| s.to_string()),
        test_plan: v["test_plan"].as_str().map(|s| s.to_string()),
    })
}

#[tauri::command]
pub fn git_create_pr(
    repo_path: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: Option<bool>,
) -> Result<String, String> {
    let repo = git2::Repository::discover(&repo_path)
        .map_err(|e| e.message().to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?;
    let url = remote
        .url()
        .ok_or_else(|| "remote origin has no URL".to_string())?;
    let (owner, repo_name) = parse_github_owner_repo(url)
        .ok_or_else(|| format!("could not parse GitHub owner/repo from: {}", url))?;

    create_github_pr(
        &owner,
        &repo_name,
        &title,
        &body,
        &head,
        &base,
        draft.unwrap_or(true),
    )
}
