use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri::ipc::{Channel, InvokeResponseBody};

mod git;
mod fs;

// ─── PTY session store ────────────────────────────────────────────────────────

pub(crate) struct PtySession {
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub shutdown: Arc<AtomicBool>,
    #[cfg(unix)]
    pub master_fd: std::os::unix::io::RawFd,
    pub child_pid: Option<u32>,
}

pub(crate) type PtyStore = Arc<DashMap<String, PtySession>>;
pub(crate) type PtyChannels = Arc<DashMap<String, Channel>>;

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
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
        cmd.args(["-l", "-i"]);
        cmd.cwd(&cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        let child_pid = child.process_id();

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

        #[cfg(unix)]
        let master_fd = pair.master.as_raw_fd().unwrap_or(-1);

        let session = PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            shutdown,
            #[cfg(unix)]
            master_fd,
            child_pid,
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

#[derive(serde::Serialize)]
pub struct PtyProcessInfo {
    pub pid: Option<u32>,
    pub name: Option<String>,
    pub cwd: Option<String>,
    /// true when a foreground command is running (foreground pg != shell pid).
    pub busy: bool,
}

#[tauri::command]
async fn pty_process_info(
    session_id: String,
    state: tauri::State<'_, PtyStore>,
) -> Result<PtyProcessInfo, String> {
    let session = state.get(&session_id).ok_or("PTY session not found")?;
    let shell_pid = session.child_pid;
    #[cfg(unix)]
    let fd = session.master_fd;
    drop(session);

    #[cfg(unix)]
    {
        let fg_pgid = unsafe { libc::tcgetpgrp(fd) };
        if fg_pgid <= 0 {
            return Ok(PtyProcessInfo { pid: shell_pid, name: None, cwd: None, busy: false });
        }
        let pid = fg_pgid as u32;
        let name = std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .ok()
            .map(|s| s.trim().to_string());
        let cwd = std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string());
        let busy = shell_pid.map_or(false, |s| s != pid);
        return Ok(PtyProcessInfo { pid: Some(pid), name, cwd, busy });
    }
    #[cfg(not(unix))]
    {
        let _ = shell_pid;
        Ok(PtyProcessInfo { pid: shell_pid, name: None, cwd: None, busy: false })
    }
}

fn kill_all_ptys(store: &PtyStore) {
    for entry in store.iter() {
        entry.value().shutdown.store(true, Ordering::Relaxed);
        if let Ok(mut child) = entry.value().child.lock() {
            let _ = child.kill();
        }
    }
    store.clear();
}

// ─── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_store: PtyStore = Arc::new(DashMap::new());
    let pty_channels: PtyChannels = Arc::new(DashMap::new());
    let git_state = git::GitState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(pty_store.clone())
        .manage(pty_channels)
        .manage(git_state)
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
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let store = window.state::<PtyStore>().inner().clone();
                kill_all_ptys(&store);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_home_dir,
            create_pty,
            write_pty,
            resize_pty,
            pty_subscribe,
            close_pty,
            pty_process_info,
            git::git_repo_info,
            git::git_list_branches,
            git::git_file_status,
            git::git_log,
            git::git_checkout_branch,
            git::git_stage_files,
            git::git_unstage_files,
            git::git_stage_all,
            git::git_commit,
            git::git_push,
            git::git_diff_working,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_rename,
            fs::fs_delete,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let store = app.state::<PtyStore>().inner().clone();
                kill_all_ptys(&store);
            }
        });
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
