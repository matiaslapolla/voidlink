pub mod detect;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AgentTool {
    ClaudeCode,
    Codex,
    OpenCode,
}

impl AgentTool {
    pub fn bin_name(&self) -> &str {
        match self {
            AgentTool::ClaudeCode => "claude",
            AgentTool::Codex => "codex",
            AgentTool::OpenCode => "opencode",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AgentStatus {
    Starting,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionInfo {
    pub session_id: String,
    pub tool: AgentTool,
    pub repo_path: String,
    pub worktree_path: String,
    pub worktree_name: String,
    pub pty_id: String,
    pub status: AgentStatus,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionInput {
    pub repo_path: String,
    pub tool: AgentTool,
    pub branch_name: Option<String>,
}

// ─── State ────────────────────────────────────────────────────────────────────

pub type ScrollbackStore = Arc<Mutex<HashMap<String, VecDeque<u8>>>>;

pub struct AgentRunnerState {
    pub sessions: Arc<Mutex<HashMap<String, AgentSessionInfo>>>,
    pub scrollback: ScrollbackStore,
}

impl AgentRunnerState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            scrollback: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
