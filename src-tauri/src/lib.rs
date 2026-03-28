use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

#[cfg(target_os = "macos")]
use tauri::Manager;

mod migration;
mod git;
mod git_agent;
mod git_review;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

// ─── PTY session store ────────────────────────────────────────────────────────

struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn std::io::Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

type PtyStore = Arc<Mutex<HashMap<String, PtySession>>>;

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! Welcome to VoidLink.", name)
}

#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

#[tauri::command]
fn create_pty(
    cwd: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<PtyStore>,
) -> Result<String, String> {
    use portable_pty::{native_pty_system, PtySize};

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();

    // Reader thread: emit output events
    let reader_session_id = session_id.clone();
    let reader_app_handle = app_handle.clone();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => {
                    let _ = reader_app_handle
                        .emit(&format!("pty-exit:{}", reader_session_id), ());
                    break;
                }
                Ok(n) => {
                    let chunk = buf[..n].to_vec();
                    let event_name = format!("pty-output:{}", reader_session_id);
                    let _ = reader_app_handle.emit(&event_name, chunk);
                }
            }
        }
    });

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let session = PtySession {
        master: pair.master,
        writer,
        child,
    };

    state
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
fn write_pty(
    session_id: String,
    data: String,
    state: tauri::State<PtyStore>,
) -> Result<(), String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let session = store
        .get_mut(&session_id)
        .ok_or("PTY session not found")?;
    std::io::Write::write_all(&mut *session.writer, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<PtyStore>,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let store = state.lock().map_err(|e| e.to_string())?;
    let session = store.get(&session_id).ok_or("PTY session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn close_pty(
    session_id: String,
    state: tauri::State<PtyStore>,
) -> Result<(), String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = store.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}

#[tauri::command]
fn scan_repository(
    repo_path: String,
    options: Option<migration::ScanOptions>,
    state: tauri::State<migration::MigrationState>,
) -> Result<String, String> {
    migration::scan_repository(state, repo_path, options)
}

#[tauri::command]
fn get_scan_status(
    scan_job_id: String,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::ScanProgress, String> {
    migration::get_scan_status(state, scan_job_id)
}

#[tauri::command]
fn search_repository(
    query: migration::SearchQuery,
    options: Option<migration::SearchOptions>,
    state: tauri::State<migration::MigrationState>,
) -> Result<Vec<migration::SearchResult>, String> {
    migration::search_repository(state, query, options)
}

#[tauri::command]
fn generate_workflow(
    input: migration::GenerateWorkflowInput,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::WorkflowDsl, String> {
    migration::generate_workflow(state, input)
}

#[tauri::command]
fn run_workflow(
    input: migration::RunWorkflowInput,
    state: tauri::State<migration::MigrationState>,
) -> Result<String, String> {
    migration::run_workflow(state, input)
}

#[tauri::command]
fn get_run_status(
    run_id: String,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::RunState, String> {
    migration::get_run_status(state, run_id)
}

#[tauri::command]
fn get_startup_repo_path(
    state: tauri::State<migration::MigrationState>,
) -> Option<String> {
    migration::get_startup_repo_path(state)
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_store: PtyStore = Arc::new(Mutex::new(HashMap::new()));
    let startup_repo = std::env::args().nth(1);
    let migration_state =
        migration::MigrationState::new(startup_repo).expect("failed to initialize migration state");
    let git_state = git::GitState::new();
    let git_agent_state = git_agent::GitAgentState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(pty_store)
        .manage(migration_state)
        .manage(git_state)
        .manage(git_agent_state)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    None,
                )
                .expect("apply_vibrancy failed");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_home_dir,
            create_pty,
            write_pty,
            resize_pty,
            close_pty,
            scan_repository,
            get_scan_status,
            search_repository,
            generate_workflow,
            run_workflow,
            get_run_status,
            get_startup_repo_path,
            // Phase 1: Git foundation
            git::git_repo_info,
            git::git_list_branches,
            git::git_file_status,
            git::git_log,
            git::git_checkout_branch,
            git::git_stage_files,
            git::git_stage_all,
            git::git_commit,
            git::git_push,
            // Phase 2: Worktrees
            git::git_create_worktree,
            git::git_list_worktrees,
            git::git_remove_worktree,
            git::git_worktree_status,
            // Phase 3: Diffs
            git::git_diff_working,
            git::git_diff_branches,
            git::git_diff_commit,
            git::git_explain_diff,
            // Phase 4: AI agent
            git_agent::git_agent_start,
            git_agent::git_agent_status,
            git_agent::git_agent_cancel,
            git_agent::git_generate_pr_description,
            git_agent::git_create_pr,
            // Phase 5: PR review
            git_review::git_list_prs,
            git_review::git_get_pr,
            git_review::git_generate_review_checklist,
            git_review::git_update_checklist_item,
            git_review::git_merge_pr,
            git_review::git_get_audit_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greet_returns_message() {
        assert_eq!(greet("World"), "Hello, World! Welcome to VoidLink.");
    }

    #[test]
    fn greet_empty_name() {
        assert_eq!(greet(""), "Hello, ! Welcome to VoidLink.");
    }

    #[test]
    fn get_home_dir_returns_string() {
        let home = get_home_dir();
        assert!(!home.is_empty());
    }
}
