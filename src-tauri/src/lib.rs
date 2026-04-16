use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;
use tauri::Emitter;
use tauri::ipc::{Channel, InvokeResponseBody};

use voidlink_core::events::EventEmitter;

// Re-export core types for use in this crate
use voidlink_core::migration::MigrationState;
use voidlink_core::git::GitState;
use voidlink_core::buffer::BufferState;
use voidlink_core::prompt_studio::PromptStudioState;
use voidlink_core::agent_runner::AgentRunnerState;
use voidlink_core::lsp::LspState;
use voidlink_core::git_agent::GitAgentState;

// ─── EventEmitter impl for Tauri AppHandle ──────────────────────────────────

#[derive(Clone)]
struct TauriEmitter(tauri::AppHandle);

impl EventEmitter for TauriEmitter {
    fn emit(&self, event: &str, payload: serde_json::Value) -> Result<(), String> {
        self.0.emit(event, payload).map_err(|e| e.to_string())
    }

    fn emit_bytes(&self, event: &str, data: Vec<u8>) -> Result<(), String> {
        self.0.emit(event, data).map_err(|e| e.to_string())
    }
}

// ─── PTY session store (Tauri-specific, uses Channel) ─────────────────────

pub(crate) struct PtySession {
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub shutdown: Arc<AtomicBool>,
}

pub(crate) type PtyStore = Arc<DashMap<String, PtySession>>;
pub(crate) type PtyChannels = Arc<DashMap<String, Channel>>;

// ─── Tauri command wrappers: filesystem ──────────────────────────────────────

#[tauri::command]
fn get_home_dir() -> String {
    voidlink_core::fs::get_home_dir()
}

#[tauri::command]
fn list_directory(path: String) -> Result<Vec<voidlink_core::fs::DirEntry>, String> {
    voidlink_core::fs::list_directory(&path)
}

#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    voidlink_core::fs::read_file_content(&path)
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    voidlink_core::fs::read_file_base64(&path)
}

#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    voidlink_core::fs::write_file_content(&path, &content)
}

#[tauri::command]
fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    voidlink_core::fs::rename_path(&old_path, &new_path)
}

#[tauri::command]
fn copy_path(src: String, dest: String) -> Result<(), String> {
    voidlink_core::fs::copy_path(&src, &dest)
}

#[tauri::command]
fn delete_path(path: String) -> Result<(), String> {
    voidlink_core::fs::delete_path(&path)
}

#[tauri::command]
fn duplicate_path(path: String) -> Result<String, String> {
    voidlink_core::fs::duplicate_path(&path)
}

#[tauri::command]
fn empty_directory(path: String) -> Result<(), String> {
    voidlink_core::fs::empty_directory(&path)
}

// ─── Tauri command wrappers: settings ────────────────────────────────────────

#[tauri::command]
fn save_api_key(provider: String, key: String) -> Result<(), String> {
    voidlink_core::settings::save_api_key(&provider, &key)
}

#[tauri::command]
fn load_api_key(provider: String) -> Result<Option<String>, String> {
    voidlink_core::settings::load_api_key(&provider)
}

#[tauri::command]
fn save_provider_settings(settings: voidlink_core::settings::ProviderSettings) -> Result<(), String> {
    voidlink_core::settings::save_provider_settings(&settings)
}

#[tauri::command]
fn load_provider_settings() -> Result<voidlink_core::settings::ProviderSettings, String> {
    voidlink_core::settings::load_provider_settings()
}

#[tauri::command]
fn reload_provider(state: tauri::State<MigrationState>) -> Result<(), String> {
    voidlink_core::migration::reload_provider(state.inner())
}

// ─── Tauri command wrappers: PTY (Tauri-specific, stays here) ───────────────

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

// ─── Tauri command wrappers: migration ───────────────────────────────────────

#[tauri::command]
fn scan_repository(
    repo_path: String,
    options: Option<voidlink_core::migration::ScanOptions>,
    state: tauri::State<MigrationState>,
) -> Result<String, String> {
    voidlink_core::migration::scan_repository(state.inner(), repo_path, options)
}

#[tauri::command]
fn get_scan_status(
    scan_job_id: String,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::ScanProgress, String> {
    voidlink_core::migration::get_scan_status(state.inner(), &scan_job_id)
}

#[tauri::command]
fn search_repository(
    query: voidlink_core::migration::SearchQuery,
    options: Option<voidlink_core::migration::SearchOptions>,
    state: tauri::State<MigrationState>,
) -> Result<Vec<voidlink_core::migration::SearchResult>, String> {
    voidlink_core::migration::search_repository(state.inner(), &query, options.as_ref())
}

#[tauri::command]
fn generate_workflow(
    input: voidlink_core::migration::GenerateWorkflowInput,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::WorkflowDsl, String> {
    voidlink_core::migration::generate_workflow(state.inner(), &input)
}

#[tauri::command]
fn run_workflow(
    input: voidlink_core::migration::RunWorkflowInput,
    state: tauri::State<MigrationState>,
) -> Result<String, String> {
    voidlink_core::migration::run_workflow(state.inner(), input)
}

#[tauri::command]
fn get_run_status(
    run_id: String,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::RunState, String> {
    voidlink_core::migration::get_run_status(state.inner(), &run_id)
}

#[tauri::command]
fn get_startup_repo_path(
    state: tauri::State<MigrationState>,
) -> Option<String> {
    voidlink_core::migration::get_startup_repo_path(state.inner())
}

#[tauri::command]
fn get_repo_graph(
    repo_path: String,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::graph::RepoGraph, String> {
    voidlink_core::migration::get_repo_graph(state.inner(), &repo_path)
}

#[tauri::command]
fn identify_entities(
    repo_path: String,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::EntityAnalysisResult, String> {
    voidlink_core::migration::identify_entities(state.inner(), &repo_path)
}

#[tauri::command]
fn analyze_data_flows(
    repo_path: String,
    state: tauri::State<MigrationState>,
) -> Result<voidlink_core::migration::dataflow::DataFlowAnalysisResult, String> {
    voidlink_core::migration::analyze_data_flows(state.inner(), &repo_path)
}

// ─── Tauri command wrappers: git ─────────────────────────────────────────────

macro_rules! blocking_git {
    ($body:expr) => {
        tauri::async_runtime::spawn_blocking(move || $body)
            .await
            .map_err(|e| e.to_string())?
    };
}

#[tauri::command]
async fn git_repo_info(repo_path: String, _state: tauri::State<'_, GitState>) -> Result<voidlink_core::git::GitRepoInfo, String> {
    blocking_git!(voidlink_core::git::git_repo_info_impl(repo_path))
}

#[tauri::command]
async fn git_list_branches(repo_path: String, include_remote: Option<bool>, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::GitBranchInfo>, String> {
    let include = include_remote.unwrap_or(false);
    blocking_git!(voidlink_core::git::git_list_branches_impl(repo_path, include))
}

#[tauri::command]
async fn git_file_status(repo_path: String, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::GitFileStatus>, String> {
    blocking_git!(voidlink_core::git::git_file_status_impl(repo_path))
}

#[tauri::command]
async fn git_log(repo_path: String, branch: Option<String>, limit: Option<u32>, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::GitCommitInfo>, String> {
    let lim = limit.unwrap_or(50);
    blocking_git!(voidlink_core::git::git_log_impl(repo_path, branch, lim))
}

#[tauri::command]
async fn git_checkout_branch(repo_path: String, branch: String, create: Option<bool>, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    let c = create.unwrap_or(false);
    blocking_git!(voidlink_core::git::git_checkout_branch_impl(repo_path, branch, c))
}

#[tauri::command]
async fn git_stage_files(repo_path: String, paths: Vec<String>, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    blocking_git!(voidlink_core::git::git_stage_files_impl(repo_path, paths))
}

#[tauri::command]
async fn git_unstage_files(repo_path: String, paths: Vec<String>, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    blocking_git!(voidlink_core::git::git_unstage_files_impl(repo_path, paths))
}

#[tauri::command]
async fn git_stage_all(repo_path: String, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    blocking_git!(voidlink_core::git::git_stage_all_impl(repo_path))
}

#[tauri::command]
async fn git_commit(repo_path: String, message: String, _state: tauri::State<'_, GitState>) -> Result<String, String> {
    blocking_git!(voidlink_core::git::git_commit_impl(repo_path, message))
}

#[tauri::command]
async fn git_push(repo_path: String, remote: Option<String>, branch: Option<String>, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    blocking_git!(voidlink_core::git::git_push_impl(repo_path, remote, branch))
}

#[tauri::command]
async fn git_create_worktree(input: voidlink_core::git::CreateWorktreeInput, _state: tauri::State<'_, GitState>) -> Result<voidlink_core::git::WorktreeInfo, String> {
    blocking_git!(voidlink_core::git::git_create_worktree_impl(input))
}

#[tauri::command]
async fn git_list_worktrees(repo_path: String, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::WorktreeInfo>, String> {
    blocking_git!(voidlink_core::git::git_list_worktrees_impl(repo_path))
}

#[tauri::command]
async fn git_remove_worktree(repo_path: String, name: String, force: Option<bool>, _state: tauri::State<'_, GitState>) -> Result<(), String> {
    let f = force.unwrap_or(false);
    blocking_git!(voidlink_core::git::git_remove_worktree_impl(repo_path, name, f))
}

#[tauri::command]
async fn git_worktree_status(repo_path: String, name: String, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::GitFileStatus>, String> {
    blocking_git!(voidlink_core::git::git_worktree_status_impl(repo_path, name))
}

#[tauri::command]
async fn git_diff_working(repo_path: String, staged_only: Option<bool>, _state: tauri::State<'_, GitState>) -> Result<voidlink_core::git::DiffResult, String> {
    let staged = staged_only.unwrap_or(false);
    blocking_git!(voidlink_core::git::git_diff_working_impl(repo_path, staged))
}

#[tauri::command]
async fn git_diff_branches(repo_path: String, base: String, head: String, _state: tauri::State<'_, GitState>) -> Result<voidlink_core::git::DiffResult, String> {
    blocking_git!(voidlink_core::git::git_diff_branches_impl(repo_path, base, head))
}

#[tauri::command]
async fn git_diff_commit(repo_path: String, oid: String, _state: tauri::State<'_, GitState>) -> Result<voidlink_core::git::DiffResult, String> {
    blocking_git!(voidlink_core::git::git_diff_commit_impl(repo_path, oid))
}

#[tauri::command]
async fn git_explain_diff(repo_path: String, base: String, head: String, _git_state: tauri::State<'_, GitState>, migration_state: tauri::State<'_, MigrationState>) -> Result<Vec<voidlink_core::git::DiffExplanation>, String> {
    let ms = migration_state.inner().clone();
    blocking_git!(voidlink_core::git::git_explain_diff_impl(repo_path, base, head, &ms))
}

#[tauri::command]
async fn git_blame_file(repo_path: String, file_path: String, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::blame::BlameLineInfo>, String> {
    blocking_git!(voidlink_core::git::git_blame_file_impl(&repo_path, &file_path))
}

#[tauri::command]
async fn git_diff_file_lines(repo_path: String, file_path: String, _state: tauri::State<'_, GitState>) -> Result<Vec<voidlink_core::git::blame::LineChange>, String> {
    blocking_git!(voidlink_core::git::git_diff_file_lines_impl(&repo_path, &file_path))
}

// ─── Tauri command wrappers: git_agent ───────────────────────────────────────

#[tauri::command]
fn git_agent_start(
    input: voidlink_core::git_agent::AgentTaskInput,
    state: tauri::State<GitAgentState>,
    migration_state: tauri::State<MigrationState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use voidlink_core::git_agent::pipeline::{make_event, run_agent_pipeline};

    let task_id = uuid::Uuid::new_v4().to_string();
    let initial_state = voidlink_core::git_agent::AgentTaskState {
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
    let emitter: Arc<dyn EventEmitter> = Arc::new(TauriEmitter(app_handle));

    std::thread::spawn(move || {
        run_agent_pipeline(task_id_clone, input, tasks_clone, migration_clone, emitter);
    });

    Ok(task_id)
}

#[tauri::command]
fn git_agent_status(
    task_id: String,
    state: tauri::State<GitAgentState>,
) -> Result<voidlink_core::git_agent::AgentTaskState, String> {
    state.tasks
        .lock()
        .map_err(|e| e.to_string())?
        .get(&task_id)
        .cloned()
        .ok_or_else(|| format!("task {} not found", task_id))
}

#[tauri::command]
fn git_agent_cancel(
    task_id: String,
    state: tauri::State<GitAgentState>,
) -> Result<(), String> {
    let mut guard = state.tasks.lock().map_err(|e| e.to_string())?;
    if let Some(task) = guard.get_mut(&task_id) {
        if task.status == "pending" || task.status == "branching" || task.status == "implementing" {
            task.status = "failed".to_string();
            task.error = Some("Cancelled by user".to_string());
            task.current_step = None;
        }
    }
    Ok(())
}

#[tauri::command]
fn git_generate_pr_description(
    repo_path: String,
    base: String,
    head: String,
    _git_state: tauri::State<GitState>,
    migration_state: tauri::State<MigrationState>,
) -> Result<voidlink_core::git_agent::PrDescription, String> {
    let diff = voidlink_core::git::git_diff_branches_impl(repo_path, base, head)?;

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

    Ok(voidlink_core::git_agent::PrDescription {
        title: v["title"].as_str().unwrap_or("Code changes").to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        labels: v["labels"]
            .as_array()
            .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        migration_notes: v["migration_notes"].as_str().map(|s| s.to_string()),
        test_plan: v["test_plan"].as_str().map(|s| s.to_string()),
    })
}

#[tauri::command]
fn git_create_pr(
    repo_path: String,
    title: String,
    body: String,
    base: String,
    head: String,
    draft: Option<bool>,
) -> Result<String, String> {
    let repo = git2::Repository::discover(&repo_path).map_err(|e| e.message().to_string())?;
    let remote = repo.find_remote("origin").map_err(|e| e.message().to_string())?;
    let url = remote.url().ok_or_else(|| "remote origin has no URL".to_string())?;
    let (owner, repo_name) = voidlink_core::git_agent::parse_github_owner_repo(url)
        .ok_or_else(|| format!("could not parse GitHub owner/repo from: {}", url))?;

    voidlink_core::git_agent::github::create_github_pr(
        &owner, &repo_name, &title, &body, &head, &base, draft.unwrap_or(true),
    )
}

// ─── Tauri command wrappers: git_review ──────────────────────────────────────

#[tauri::command]
fn git_list_prs(repo_path: String, state_filter: Option<String>) -> Result<Vec<voidlink_core::git_review::PullRequestInfo>, String> {
    voidlink_core::git_review::list_prs_impl(repo_path, state_filter)
}

#[tauri::command]
fn git_get_pr(repo_path: String, pr_number: u32) -> Result<voidlink_core::git_review::PullRequestInfo, String> {
    voidlink_core::git_review::get_pr_impl(repo_path, pr_number)
}

#[tauri::command]
fn git_generate_review_checklist(repo_path: String, pr_number: u32, migration_state: tauri::State<MigrationState>) -> Result<voidlink_core::git_review::ReviewChecklist, String> {
    voidlink_core::git_review::generate_review_checklist_impl(repo_path, pr_number, migration_state.inner())
}

#[tauri::command]
fn git_update_checklist_item(repo_path: String, pr_number: u32, item_id: String, status: String, migration_state: tauri::State<MigrationState>) -> Result<(), String> {
    voidlink_core::git_review::update_checklist_item_impl(repo_path, pr_number, item_id, status, migration_state.inner())
}

#[tauri::command]
fn git_merge_pr(input: voidlink_core::git_review::MergeInput, migration_state: tauri::State<MigrationState>) -> Result<(), String> {
    voidlink_core::git_review::merge_pr_impl(input, migration_state.inner())
}

#[tauri::command]
fn git_get_audit_log(repo_path: String, pr_number: Option<u32>, migration_state: tauri::State<MigrationState>) -> Result<Vec<voidlink_core::git_review::AuditEntry>, String> {
    voidlink_core::git_review::get_audit_log_impl(repo_path, pr_number, migration_state.inner())
}

// ─── Tauri command wrappers: agent_runner ────────────────────────────────────

#[tauri::command]
fn agent_detect_tools() -> Vec<String> {
    voidlink_core::agent_runner::detect::detect_tools()
}

#[tauri::command]
fn agent_list_sessions(state: tauri::State<'_, AgentRunnerState>) -> Vec<voidlink_core::agent_runner::AgentSessionInfo> {
    state.sessions
        .lock()
        .map(|s| s.values().cloned().collect())
        .unwrap_or_default()
}

#[tauri::command]
fn agent_start_session(
    input: voidlink_core::agent_runner::StartSessionInput,
    app_handle: tauri::AppHandle,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, PtyStore>,
    channels: tauri::State<'_, PtyChannels>,
) -> Result<voidlink_core::agent_runner::AgentSessionInfo, String> {
    // agent_runner session creation stays in Tauri land for now because it
    // deeply uses PtyStore/PtyChannels/AppHandle. We inline the session::start_session
    // logic here. This will be refactored in a future phase.
    agent_session::start_session(
        input,
        app_handle,
        runner_state.sessions.clone(),
        (*pty_store).clone(),
        runner_state.scrollback.clone(),
        (*channels).clone(),
    )
}

#[tauri::command]
fn agent_kill_session(
    session_id: String,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    agent_session::kill_session(session_id, runner_state.sessions.clone(), (*pty_store).clone())
}

#[tauri::command]
fn agent_get_scrollback(pty_id: String, state: tauri::State<'_, AgentRunnerState>) -> Vec<u8> {
    state.scrollback
        .lock()
        .map(|mut sb| {
            sb.get_mut(&pty_id)
                .map(|deque| {
                    let slices = deque.make_contiguous();
                    slices.to_vec()
                })
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn agent_cleanup_session(
    session_id: String,
    runner_state: tauri::State<'_, AgentRunnerState>,
    pty_store: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    agent_session::cleanup_session(
        session_id,
        runner_state.sessions.clone(),
        (*pty_store).clone(),
        runner_state.scrollback.clone(),
    )
}

// ─── Tauri command wrappers: LSP ─────────────────────────────────────────────

#[tauri::command]
fn lsp_detect_servers() -> Vec<voidlink_core::lsp::LspServerInfo> {
    voidlink_core::lsp::lsp_detect_servers_impl()
}

#[tauri::command]
fn lsp_start_server(
    language: String,
    root_path: String,
    app_handle: tauri::AppHandle,
    state: tauri::State<LspState>,
) -> Result<String, String> {
    let servers = voidlink_core::lsp::lsp_detect_servers_impl();
    let info = servers
        .into_iter()
        .find(|s| s.language == language && s.installed)
        .ok_or_else(|| format!("No installed LSP server found for language '{}'", language))?;

    let server_id = uuid::Uuid::new_v4().to_string();
    let emitter: Arc<dyn EventEmitter> = Arc::new(TauriEmitter(app_handle));

    let server = voidlink_core::lsp::LspServer::start(
        &info.command, &info.args, &root_path, &server_id, emitter,
    )?;

    state.servers.insert(server_id.clone(), server);
    Ok(server_id)
}

#[tauri::command]
fn lsp_stop_server(server_id: String, state: tauri::State<LspState>) -> Result<(), String> {
    let (_, server) = state.servers
        .remove(&server_id)
        .ok_or_else(|| format!("LSP server '{}' not found", server_id))?;
    server.shutdown();
    Ok(())
}

#[tauri::command]
fn lsp_hover(server_id: String, file_path: String, line: u32, character: u32, state: tauri::State<LspState>) -> Result<serde_json::Value, String> {
    let server = state.servers.get(&server_id).ok_or_else(|| format!("LSP server '{}' not found", server_id))?;
    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
    });
    let response = server.send_request("textDocument/hover", params)?;
    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn lsp_goto_definition(server_id: String, file_path: String, line: u32, character: u32, state: tauri::State<LspState>) -> Result<serde_json::Value, String> {
    let server = state.servers.get(&server_id).ok_or_else(|| format!("LSP server '{}' not found", server_id))?;
    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
    });
    let response = server.send_request("textDocument/definition", params)?;
    Ok(response.get("result").cloned().unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
fn lsp_did_open(server_id: String, file_path: String, content: String, language_id: String, state: tauri::State<LspState>) -> Result<(), String> {
    let server = state.servers.get(&server_id).ok_or_else(|| format!("LSP server '{}' not found", server_id))?;
    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({
        "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": content },
    });
    server.send_notification("textDocument/didOpen", params)
}

#[tauri::command]
fn lsp_did_close(server_id: String, file_path: String, state: tauri::State<LspState>) -> Result<(), String> {
    let server = state.servers.get(&server_id).ok_or_else(|| format!("LSP server '{}' not found", server_id))?;
    let uri = format!("file://{}", file_path);
    let params = serde_json::json!({ "textDocument": { "uri": uri } });
    server.send_notification("textDocument/didClose", params)
}

// ─── Tauri command wrappers: buffer ──────────────────────────────────────────

#[tauri::command]
fn buffer_open(path: String, state: tauri::State<BufferState>) -> Result<voidlink_core::buffer::BufferOpenResult, String> {
    voidlink_core::buffer::buffer_open(state.inner(), &path)
}

#[tauri::command]
fn buffer_highlight(path: String, content: String, start_line: usize, end_line: usize, theme_mode: String, state: tauri::State<BufferState>) -> Result<voidlink_core::buffer::BufferHighlightResult, String> {
    voidlink_core::buffer::buffer_highlight(state.inner(), &path, &content, start_line, end_line, &theme_mode)
}

#[tauri::command]
fn buffer_get_tokens(path: String, start_line: usize, end_line: usize, theme_mode: String, state: tauri::State<BufferState>) -> Result<voidlink_core::buffer::BufferHighlightResult, String> {
    voidlink_core::buffer::buffer_get_tokens(state.inner(), &path, start_line, end_line, &theme_mode)
}

#[tauri::command]
fn buffer_save(path: String, content: Option<String>, state: tauri::State<BufferState>) -> Result<(), String> {
    voidlink_core::buffer::buffer_save(state.inner(), &path, content.as_deref())
}

#[tauri::command]
fn buffer_close(path: String, state: tauri::State<BufferState>) -> Result<(), String> {
    voidlink_core::buffer::buffer_close(state.inner(), &path)
}

// ─── Tauri command wrappers: prompt_studio ───────────────────────────────────

#[tauri::command]
fn prompt_list(state: tauri::State<'_, PromptStudioState>) -> Result<Vec<voidlink_core::prompt_studio::PromptSummary>, String> {
    voidlink_core::prompt_studio::prompt_list(state.inner())
}

#[tauri::command]
fn prompt_get(id: String, state: tauri::State<'_, PromptStudioState>) -> Result<voidlink_core::prompt_studio::PromptFull, String> {
    voidlink_core::prompt_studio::prompt_get(state.inner(), &id)
}

#[tauri::command]
fn prompt_save(input: voidlink_core::prompt_studio::SavePromptInput, state: tauri::State<'_, PromptStudioState>) -> Result<voidlink_core::prompt_studio::PromptFull, String> {
    voidlink_core::prompt_studio::prompt_save(state.inner(), &input)
}

#[tauri::command]
fn prompt_delete(id: String, state: tauri::State<'_, PromptStudioState>) -> Result<(), String> {
    voidlink_core::prompt_studio::prompt_delete(state.inner(), &id)
}

#[tauri::command]
fn prompt_toggle_favorite(id: String, state: tauri::State<'_, PromptStudioState>) -> Result<bool, String> {
    voidlink_core::prompt_studio::prompt_toggle_favorite(state.inner(), &id)
}

#[tauri::command]
fn prompt_list_tags(state: tauri::State<'_, PromptStudioState>) -> Result<Vec<voidlink_core::prompt_studio::PromptTag>, String> {
    voidlink_core::prompt_studio::prompt_list_tags(state.inner())
}

#[tauri::command]
fn prompt_get_versions(prompt_id: String, state: tauri::State<'_, PromptStudioState>) -> Result<Vec<voidlink_core::prompt_studio::PromptVersion>, String> {
    voidlink_core::prompt_studio::prompt_get_versions(state.inner(), &prompt_id)
}

#[tauri::command]
fn prompt_get_executions(prompt_id: String, limit: Option<usize>, state: tauri::State<'_, PromptStudioState>) -> Result<Vec<voidlink_core::prompt_studio::PromptExecution>, String> {
    voidlink_core::prompt_studio::prompt_get_executions(state.inner(), &prompt_id, limit)
}

#[tauri::command]
fn prompt_rate_execution(execution_id: String, rating: i32, state: tauri::State<'_, PromptStudioState>) -> Result<(), String> {
    voidlink_core::prompt_studio::prompt_rate_execution(state.inner(), &execution_id, rating)
}

#[tauri::command]
fn prompt_execute(input: voidlink_core::prompt_studio::ExecutePromptInput, state: tauri::State<'_, PromptStudioState>, migration_state: tauri::State<'_, MigrationState>) -> Result<voidlink_core::prompt_studio::PromptExecution, String> {
    voidlink_core::prompt_studio::prompt_execute(state.inner(), migration_state.inner(), &input)
}

#[tauri::command]
fn prompt_analyze(content: String, system_prompt: Option<String>, migration_state: tauri::State<'_, MigrationState>) -> Result<voidlink_core::prompt_studio::PromptAnalysis, String> {
    voidlink_core::prompt_studio::prompt_analyze(migration_state.inner(), &content, system_prompt.as_deref())
}

#[tauri::command]
fn prompt_optimize(content: String, system_prompt: Option<String>, migration_state: tauri::State<'_, MigrationState>) -> Result<voidlink_core::prompt_studio::OptimizeResult, String> {
    voidlink_core::prompt_studio::prompt_optimize(migration_state.inner(), &content, system_prompt.as_deref())
}

// ─── Agent session (Tauri-specific, kept here for PTY coupling) ──────────────

mod agent_session;

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_store: PtyStore = Arc::new(DashMap::new());
    let pty_channels: PtyChannels = Arc::new(DashMap::new());
    let startup_repo = std::env::args().nth(1);
    let migration_state =
        MigrationState::new(startup_repo).expect("failed to initialize migration state");
    let git_state = GitState::new();
    let git_agent_state = GitAgentState::new();
    let agent_runner_state = AgentRunnerState::new();
    let lsp_state = LspState::new();
    let buffer_state = BufferState::new();
    let prompt_studio_state =
        PromptStudioState::new().expect("failed to initialize prompt studio state");

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
        .manage(buffer_state)
        .manage(prompt_studio_state)
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
            save_api_key,
            load_api_key,
            save_provider_settings,
            load_provider_settings,
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
            git_repo_info,
            git_list_branches,
            git_file_status,
            git_log,
            git_checkout_branch,
            git_stage_files,
            git_unstage_files,
            git_stage_all,
            git_commit,
            git_push,
            git_create_worktree,
            git_list_worktrees,
            git_remove_worktree,
            git_worktree_status,
            git_diff_working,
            git_diff_branches,
            git_diff_commit,
            git_explain_diff,
            git_blame_file,
            git_diff_file_lines,
            git_agent_start,
            git_agent_status,
            git_agent_cancel,
            git_generate_pr_description,
            git_create_pr,
            git_list_prs,
            git_get_pr,
            git_generate_review_checklist,
            git_update_checklist_item,
            git_merge_pr,
            git_get_audit_log,
            agent_detect_tools,
            agent_list_sessions,
            agent_start_session,
            agent_kill_session,
            agent_get_scrollback,
            agent_cleanup_session,
            lsp_detect_servers,
            lsp_start_server,
            lsp_stop_server,
            lsp_hover,
            lsp_goto_definition,
            lsp_did_open,
            lsp_did_close,
            buffer_open,
            buffer_highlight,
            buffer_get_tokens,
            buffer_save,
            buffer_close,
            prompt_list,
            prompt_get,
            prompt_save,
            prompt_delete,
            prompt_toggle_favorite,
            prompt_list_tags,
            prompt_get_versions,
            prompt_get_executions,
            prompt_rate_execution,
            prompt_execute,
            prompt_analyze,
            prompt_optimize,
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
