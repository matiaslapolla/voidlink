//! Session model + registry (polish plan §4.2).
//!
//! A `Session` is the smallest unit of agentic work — one worktree, one chat,
//! optionally one PR. Sessions live in a `SessionsRegistry` (HashMap keyed by
//! id) and are surfaced in the left rail as rows under their repository.
//!
//! In ED-E the session is runtime-persisted via serde alongside `AppState`.
//! ED-F will hydrate `pr` from a background poller over
//! `voidlink-core::git_review`; until then the field stays `None`.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ─── Enums ───────────────────────────────────────────────────────────────────

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Idle,
    Running,
    ReadyToMerge,
    MergeConflicts,
    Archived,
    Failed,
    DraftPr,
    PrOpen,
    PrClosed,
    PrMerged,
    ChecksFailing,
    ChecksRunning,
}

impl SessionStatus {
    pub fn label(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "Idle",
            SessionStatus::Running => "Running",
            SessionStatus::ReadyToMerge => "Ready to merge",
            SessionStatus::MergeConflicts => "Merge conflicts",
            SessionStatus::Archived => "Archived",
            SessionStatus::Failed => "Failed",
            SessionStatus::DraftPr => "Draft PR",
            SessionStatus::PrOpen => "PR open",
            SessionStatus::PrClosed => "PR closed",
            SessionStatus::PrMerged => "Merged",
            SessionStatus::ChecksFailing => "Checks failing",
            SessionStatus::ChecksRunning => "Checks running",
        }
    }
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mergeable {
    Clean,
    Conflicts,
    Unknown,
    Blocked,
}

#[derive(Debug, Copy, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckConclusion {
    Success,
    Failure,
    Neutral,
    Pending,
}

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Copy, Serialize, Deserialize)]
pub struct DeltaCount {
    pub add: u32,
    pub del: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub context_window: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckRun {
    pub id: String,
    pub name: String,
    pub conclusion: CheckConclusion,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChecksSummary {
    pub total: u32,
    pub passing: u32,
    pub failing: u32,
    pub pending: u32,
    #[serde(default)]
    pub runs: Vec<CheckRun>,
}

impl Default for ChecksSummary {
    fn default() -> Self {
        Self {
            total: 0,
            passing: 0,
            failing: 0,
            pending: 0,
            runs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequestInfo {
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: PrState,
    pub draft: bool,
    pub head: String,
    pub base: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub checks: ChecksSummary,
    pub mergeable: Mergeable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub branch: String,
    pub parent_branch: String,
    pub status: SessionStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,

    #[serde(default)]
    pub worktree_path: Option<PathBuf>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub pr: Option<PullRequestInfo>,

    #[serde(default)]
    pub last_delta: DeltaCount,
    #[serde(default)]
    pub runtime_ms: Option<u64>,
    #[serde(default)]
    pub tokens_used: Option<TokenUsage>,
    #[serde(default)]
    pub shortcut_index: Option<u8>,
}

impl PullRequestInfo {
    /// ED-F adapter: convert `voidlink_core::git_review::PullRequestInfo` into
    /// the richer session-side shape used by the PR widgets. The core struct
    /// carries a flat `mergeable: Option<bool>` + `ci_status: Option<String>`;
    /// we translate those into the `Mergeable` + `ChecksSummary` enums.
    pub fn from_core(core: &voidlink_core::git_review::PullRequestInfo) -> Self {
        let state = match core.state.as_str() {
            "closed" => PrState::Closed,
            "merged" => PrState::Merged,
            _ => PrState::Open,
        };

        let mergeable = match core.mergeable {
            Some(true) => Mergeable::Clean,
            Some(false) => Mergeable::Conflicts,
            None => Mergeable::Unknown,
        };

        let checks = match core.ci_status.as_deref() {
            Some("success") | Some("passing") => ChecksSummary {
                total: 1,
                passing: 1,
                failing: 0,
                pending: 0,
                runs: Vec::new(),
            },
            Some("failure") | Some("failing") => ChecksSummary {
                total: 1,
                passing: 0,
                failing: 1,
                pending: 0,
                runs: Vec::new(),
            },
            Some("pending") | Some("running") => ChecksSummary {
                total: 1,
                passing: 0,
                failing: 0,
                pending: 1,
                runs: Vec::new(),
            },
            _ => ChecksSummary::default(),
        };

        Self {
            number: core.number as u64,
            url: core.url.clone(),
            title: core.title.clone(),
            state,
            draft: core.draft,
            head: core.head_branch.clone(),
            base: core.base_branch.clone(),
            labels: Vec::new(),
            checks,
            mergeable,
        }
    }
}

impl Session {
    /// Derive a `SessionStatus` from the attached PR info. Prefers PR-state
    /// signals over the stored `status` field — call this when `pr` changes
    /// to keep the sidebar chip in sync.
    pub fn derive_status(&self) -> SessionStatus {
        let Some(pr) = self.pr.as_ref() else {
            return self.status;
        };
        match pr.state {
            PrState::Merged => SessionStatus::PrMerged,
            PrState::Closed => SessionStatus::PrClosed,
            PrState::Open => {
                if pr.draft {
                    SessionStatus::DraftPr
                } else if pr.checks.failing > 0 {
                    SessionStatus::ChecksFailing
                } else if pr.checks.pending > 0 {
                    SessionStatus::ChecksRunning
                } else if matches!(pr.mergeable, Mergeable::Conflicts) {
                    SessionStatus::MergeConflicts
                } else if matches!(pr.mergeable, Mergeable::Clean) {
                    SessionStatus::ReadyToMerge
                } else {
                    SessionStatus::PrOpen
                }
            }
        }
    }

    pub fn new(repository_id: &str, name: &str, branch: &str, parent_branch: &str) -> Self {
        let now = now_ms();
        Self {
            id: Uuid::new_v4().to_string(),
            repository_id: repository_id.to_string(),
            name: name.to_string(),
            branch: branch.to_string(),
            parent_branch: parent_branch.to_string(),
            status: SessionStatus::Idle,
            created_at_ms: now,
            updated_at_ms: now,
            worktree_path: None,
            chat_id: None,
            task_id: None,
            pr: None,
            last_delta: DeltaCount::default(),
            runtime_ms: None,
            tokens_used: None,
            shortcut_index: None,
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── Registry ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionsRegistry {
    pub sessions: HashMap<String, Session>,
}

impl SessionsRegistry {
    pub fn insert(&mut self, session: Session) -> String {
        let id = session.id.clone();
        self.sessions.insert(id.clone(), session);
        id
    }

    pub fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    pub fn get(&self, id: &str) -> Option<&Session> {
        self.sessions.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.get_mut(id)
    }

    pub fn sessions_for_repo(&self, repo_id: &str) -> Vec<&Session> {
        let mut list: Vec<&Session> = self
            .sessions
            .values()
            .filter(|s| s.repository_id == repo_id)
            .collect();
        list.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
        list
    }
}
