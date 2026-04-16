use std::path::PathBuf;

use super::AppState;

const STATE_FILE: &str = "state.v1.json";

fn state_dir() -> PathBuf {
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            PathBuf::from(home).join(".local/share")
        });
    base.join("voidlink")
}

pub fn load() -> AppState {
    let path = state_dir().join(STATE_FILE);
    let mut state: AppState = match std::fs::read_to_string(&path) {
        Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
        Err(_) => AppState::default(),
    };
    // ED-E: run the v1→v2 workspace shape migration every load. The call is
    // idempotent — it only acts on workspaces that still carry a legacy
    // `repo_root` without any `repository_ids`.
    state.migrate_workspace_shape();
    state
}

pub fn save(state: &AppState) {
    let dir = state_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Failed to create state dir: {}", e);
        return;
    }
    let path = dir.join(STATE_FILE);
    match serde_json::to_string_pretty(state) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::warn!("Failed to write state: {}", e);
            }
        }
        Err(e) => log::warn!("Failed to serialize state: {}", e),
    }
}
