pub(crate) mod detect;
mod session;

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

/// Keyed by pty_id. Stores the most recent MAX_SCROLLBACK_BYTES of output per session.
/// Uses VecDeque for O(1) eviction of oldest bytes when the cap is exceeded.
pub(crate) type ScrollbackStore = Arc<Mutex<HashMap<String, VecDeque<u8>>>>;

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

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn agent_detect_tools() -> Vec<String> {
    detect::detect_tools()
}

#[tauri::command]
pub fn agent_list_sessions(
    state: tauri::State<'_, AgentRunnerState>,
) -> Vec<AgentSessionInfo> {
    state
        .sessions
        .lock()
        .map(|s| s.values().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn agent_start_session(
    input: StartSessionInput,
    app_handle: tauri::AppHandle,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, crate::PtyStore>,
    channels: tauri::State<'_, crate::PtyChannels>,
) -> Result<AgentSessionInfo, String> {
    session::start_session(
        input,
        app_handle,
        runner_state.sessions.clone(),
        (*pty_store).clone(),
        runner_state.scrollback.clone(),
        (*channels).clone(),
    )
}

#[tauri::command]
pub fn agent_kill_session(
    session_id: String,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, crate::PtyStore>,
) -> Result<(), String> {
    session::kill_session(
        session_id,
        runner_state.sessions.clone(),
        (*pty_store).clone(),
    )
}

/// Returns the scrollback buffer for a PTY session so the terminal can replay
/// output after navigating away and back. Returns empty if not found.
#[tauri::command]
pub fn agent_get_scrollback(
    pty_id: String,
    state: tauri::State<'_, AgentRunnerState>,
) -> Vec<u8> {
    state
        .scrollback
        .lock()
        .map(|sb| {
            sb.get(&pty_id)
                .map(|deque| deque.iter().copied().collect())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

/// Kills the PTY (if still running), removes the git worktree, and drops the
/// session + scrollback from memory. Called when the user explicitly cleans up.
#[tauri::command]
pub fn agent_cleanup_session(
    session_id: String,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, crate::PtyStore>,
) -> Result<(), String> {
    session::cleanup_session(
        session_id,
        runner_state.sessions.clone(),
        (*pty_store).clone(),
        runner_state.scrollback.clone(),
    )
}
