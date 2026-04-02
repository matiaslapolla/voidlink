pub(crate) mod github;
pub(crate) mod pipeline;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use github::create_github_pr;
use pipeline::{make_event, run_agent_pipeline};

// Re-export for git_review
pub(crate) use github::parse_github_owner_repo;

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitAgentState {
    pub(crate) tasks: Arc<Mutex<HashMap<String, AgentTaskState>>>,
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
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    Ok(PrDescription {
        title: v["title"].as_str().unwrap_or("Code changes").to_string(),
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
