//! Repository model (polish plan §4.1).
//!
//! A `Workspace` (see `state/mod.rs`) no longer points at a single `repo_root`
//! — it instead references `Vec<Repository>` via `Repository.id`. Each
//! repository carries its own display name, default branch, and optional
//! GitHub coordinates.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Remote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repository {
    pub id: String,
    pub workspace_id: String,
    pub path: PathBuf,
    pub display_name: String,
    pub default_branch: String,
    #[serde(default)]
    pub remotes: Vec<Remote>,
    #[serde(default)]
    pub github_owner: Option<String>,
    #[serde(default)]
    pub github_repo: Option<String>,
}

impl Repository {
    /// Build a fresh `Repository` from a filesystem path. The display name
    /// defaults to the last path component; the default branch defaults to
    /// `"main"` until populated by a real `git` lookup (ED-F adds the poller).
    pub fn from_path(workspace_id: &str, path: PathBuf) -> Self {
        let display_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string());
        Self {
            id: Uuid::new_v4().to_string(),
            workspace_id: workspace_id.to_string(),
            path,
            display_name,
            default_branch: String::from("main"),
            remotes: Vec::new(),
            github_owner: None,
            github_repo: None,
        }
    }
}
