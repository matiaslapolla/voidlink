pub mod github;
pub mod pipeline;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use github::parse_github_owner_repo;

// ─── State ────────────────────────────────────────────────────────────────────

pub struct GitAgentState {
    pub tasks: Arc<Mutex<HashMap<String, AgentTaskState>>>,
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
