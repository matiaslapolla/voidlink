use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;
use tauri::Emitter;
use tauri::ipc::{Channel, InvokeResponseBody};

mod migration;
mod git;
mod git_agent;
mod git_review;
mod settings;
mod agent_runner;
mod shell_integration;
mod lsp;

// ─── PTY session store ────────────────────────────────────────────────────────

pub(crate) struct PtySession {
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub shutdown: Arc<AtomicBool>,
}

/// Lock-free concurrent map keyed by session ID. Each session's fields have
/// independent Mutex locks so write/resize/close never contend with each other.
pub(crate) type PtyStore = Arc<DashMap<String, PtySession>>;

/// Per-PTY output channels. The reader thread sends raw bytes through the
/// channel (bypassing JSON serialisation) for minimal-latency push to the frontend.
pub(crate) type PtyChannels = Arc<DashMap<String, Channel>>;

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden files/dirs
            if name.starts_with('.') {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();
    // Directories first, then alphabetical
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_path(src: String, dest: String) -> Result<(), String> {
    let src_path = std::path::Path::new(&src);
    if src_path.is_dir() {
        copy_dir_recursive(src_path, std::path::Path::new(&dest))
    } else {
        std::fs::copy(&src, &dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn duplicate_path(path: String) -> Result<String, String> {
    let src = std::path::Path::new(&path);
    let parent = src.parent().ok_or("No parent directory")?;
    let stem = src.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();

    let mut copy_name = format!("{} copy{}", stem, ext);
    let mut counter = 2u32;
    while parent.join(&copy_name).exists() {
        copy_name = format!("{} copy {}{}", stem, counter, ext);
        counter += 1;
    }

    let dest = parent.join(&copy_name);
    let dest_str = dest.to_string_lossy().to_string();

    if src.is_dir() {
        copy_dir_recursive(src, &dest)?;
    } else {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    }

    Ok(dest_str)
}

#[tauri::command]
fn empty_directory(path: String) -> Result<(), String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn create_pty(
    cwd: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, PtyStore>,
    channels: tauri::State<'_, PtyChannels>,
) -> Result<String, String> {
    let store = state.inner().clone();
    let chans = channels.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        use portable_pty::{native_pty_system, PtySize};

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.unwrap_or(24),
                cols: cols.unwrap_or(80),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

        let mut cmd = portable_pty::CommandBuilder::new(&shell);
        // Start as interactive login shell so .bashrc/.zshrc, starship, etc. are sourced.
        // Both bash and zsh accept -l (login) and -i (interactive).
        cmd.args(["-l", "-i"]);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let shutdown = Arc::new(AtomicBool::new(false));

        // Reader thread: pushes output via Channel (raw binary, no JSON)
        let reader_session_id = session_id.clone();
        let reader_app_handle = app_handle.clone();
        let reader_channels = chans.clone();
        let reader_shutdown = shutdown.clone();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                if reader_shutdown.load(Ordering::Relaxed) {
                    break;
                }
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = reader_app_handle
                            .emit(&format!("pty-exit:{}", reader_session_id), ());
                        break;
                    }
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        if let Some(ch) = reader_channels.get(&reader_session_id) {
                            if let Err(e) = ch.send(InvokeResponseBody::Raw(chunk)) {
                                log::warn!("PTY {}: channel send failed: {}", reader_session_id, e);
                            }
                        } else {
                            let event_name = format!("pty-output:{}", reader_session_id);
                            if let Err(e) = reader_app_handle.emit(&event_name, chunk) {
                                log::warn!("PTY {}: event emit failed: {}", reader_session_id, e);
                            }
                        }
                    }
                }
            }
            reader_channels.remove(&reader_session_id);
        });

        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let session = PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            shutdown,
        };

        store.insert(session_id.clone(), session);

        Ok(session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn write_pty(
    session_id: String,
    data: String,
    state: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    let session = state.get(&session_id).ok_or("PTY session not found")?;
    let mut writer = session.writer.lock().map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut *writer, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    use portable_pty::PtySize;
    let session = state.get(&session_id).ok_or("PTY session not found")?;
    let master = session.master.lock().map_err(|e| e.to_string())?;
    let result = master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string());
    drop(master);
    drop(session);
    result
}

#[tauri::command]
async fn pty_subscribe(
    session_id: String,
    on_output: Channel,
    state: tauri::State<'_, PtyChannels>,
) -> Result<(), String> {
    state.insert(session_id, on_output);
    Ok(())
}

#[tauri::command]
async fn close_pty(
    session_id: String,
    state: tauri::State<'_, PtyStore>,
    channels: tauri::State<'_, PtyChannels>,
) -> Result<(), String> {
    if let Some((_, session)) = state.remove(&session_id) {
        session.shutdown.store(true, Ordering::Relaxed);
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }
    channels.remove(&session_id);
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

#[tauri::command]
fn get_repo_graph(
    repo_path: String,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::graph::RepoGraph, String> {
    migration::get_repo_graph(state, repo_path)
}

#[tauri::command]
fn identify_entities(
    repo_path: String,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::EntityAnalysisResult, String> {
    migration::identify_entities(state, repo_path)
}

#[tauri::command]
fn analyze_data_flows(
    repo_path: String,
    state: tauri::State<migration::MigrationState>,
) -> Result<migration::dataflow::DataFlowAnalysisResult, String> {
    migration::analyze_data_flows(state, repo_path)
}

#[tauri::command]
fn reload_provider(state: tauri::State<migration::MigrationState>) -> Result<(), String> {
    migration::reload_provider(state)
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_store: PtyStore = Arc::new(DashMap::new());
    let pty_channels: PtyChannels = Arc::new(DashMap::new());
    let startup_repo = std::env::args().nth(1);
    let migration_state =
        migration::MigrationState::new(startup_repo).expect("failed to initialize migration state");
    let git_state = git::GitState::new();
    let git_agent_state = git_agent::GitAgentState::new();
    let agent_runner_state = agent_runner::AgentRunnerState::new();
    let lsp_state = lsp::LspState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(pty_store)
        .manage(pty_channels)
        .manage(migration_state)
        .manage(git_state)
        .manage(git_agent_state)
        .manage(agent_runner_state)
        .manage(lsp_state)
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_home_dir,
            list_directory,
            read_file_content,
            read_file_base64,
            write_file_content,
            rename_path,
            copy_path,
            delete_path,
            duplicate_path,
            empty_directory,
            // BYOK settings
            settings::save_api_key,
            settings::load_api_key,
            settings::save_provider_settings,
            settings::load_provider_settings,
            reload_provider,
            create_pty,
            write_pty,
            resize_pty,
            pty_subscribe,
            close_pty,
            scan_repository,
            get_scan_status,
            search_repository,
            generate_workflow,
            run_workflow,
            get_run_status,
            get_startup_repo_path,
            get_repo_graph,
            identify_entities,
            analyze_data_flows,
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
            git::git_blame_file,
            git::git_diff_file_lines,
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
            // CLI agent runner
            agent_runner::agent_detect_tools,
            agent_runner::agent_list_sessions,
            agent_runner::agent_start_session,
            agent_runner::agent_kill_session,
            agent_runner::agent_get_scrollback,
            agent_runner::agent_cleanup_session,
            // LSP support
            lsp::lsp_detect_servers,
            lsp::lsp_start_server,
            lsp::lsp_stop_server,
            lsp::lsp_hover,
            lsp::lsp_goto_definition,
            lsp::lsp_did_open,
            lsp::lsp_did_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_home_dir_returns_string() {
        let home = get_home_dir();
        assert!(!home.is_empty());
    }
}
