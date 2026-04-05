use std::collections::{HashMap, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc, Mutex,
};

use portable_pty::{native_pty_system, PtySize};
use tauri::Emitter;
use uuid::Uuid;

use tauri::ipc::InvokeResponseBody;
use crate::git::{git_create_worktree_impl, CreateWorktreeInput};
use super::{AgentSessionInfo, AgentStatus, ScrollbackStore, StartSessionInput};

/// Cap per-session scrollback at 512 KB — enough for hundreds of screens.
const MAX_SCROLLBACK_BYTES: usize = 512 * 1024;

/// Seconds of PTY silence before emitting `agent:needs-attention`.
const IDLE_THRESHOLD_SECS: i64 = 30;

/// How often the watchdog thread polls for idleness.
const WATCHDOG_INTERVAL_SECS: u64 = 5;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(super) fn start_session(
    input: StartSessionInput,
    app_handle: tauri::AppHandle,
    sessions: Arc<Mutex<HashMap<String, AgentSessionInfo>>>,
    pty_store: Arc<Mutex<HashMap<String, crate::PtySession>>>,
    scrollback: ScrollbackStore,
    channels: crate::PtyChannels,
) -> Result<AgentSessionInfo, String> {
    let short_id = &Uuid::new_v4().to_string()[..8];
    let branch_name = input.branch_name.unwrap_or_else(|| {
        format!("agent-{}-{}", input.tool.bin_name(), short_id)
    });

    // Create an isolated git worktree for this session
    let worktree = git_create_worktree_impl(CreateWorktreeInput {
        repo_path: input.repo_path.clone(),
        branch_name: branch_name.clone(),
        base_ref: None,
    })?;

    // Open a PTY
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 220,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Spawn the user's interactive shell so that .bashrc/.zshrc is sourced.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let mut cmd = portable_pty::CommandBuilder::new(&shell);
    cmd.cwd(&worktree.path);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    let pty_id = Uuid::new_v4().to_string();
    let session_id = Uuid::new_v4().to_string();

    // Shared state between reader thread and idle watchdog
    let last_output_at = Arc::new(AtomicI64::new(now_secs()));
    let session_done = Arc::new(AtomicBool::new(false));

    // ── Reader thread ──────────────────────────────────────────────────────────
    let reader_pty_id = pty_id.clone();
    let reader_session_id = session_id.clone();
    let reader_app = app_handle.clone();
    let sessions_arc = sessions.clone();
    let scrollback_arc = scrollback.clone();
    let reader_channels = channels;
    let last_output_reader = last_output_at.clone();
    let session_done_reader = session_done.clone();
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => {
                    // Session exited — mark done and stop watchdog
                    session_done_reader.store(true, Ordering::Relaxed);
                    if let Ok(mut s) = sessions_arc.lock() {
                        if let Some(info) = s.get_mut(&reader_session_id) {
                            info.status = AgentStatus::Done;
                        }
                    }
                    let _ = reader_app.emit(&format!("pty-exit:{}", reader_pty_id), ());
                    let _ = reader_app.emit("agent:status-changed", &reader_session_id);
                    break;
                }
                Ok(n) => {
                    let chunk = buf[..n].to_vec();

                    // Update idle clock
                    last_output_reader.store(now_secs(), Ordering::Relaxed);

                    // Append to scrollback (VecDeque: efficient front eviction)
                    if let Ok(mut sb) = scrollback_arc.lock() {
                        let entry = sb.entry(reader_pty_id.clone()).or_insert_with(VecDeque::new);
                        entry.extend(chunk.iter().copied());
                        if entry.len() > MAX_SCROLLBACK_BYTES {
                            let excess = entry.len() - MAX_SCROLLBACK_BYTES;
                            drop(entry.drain(..excess));
                        }
                    }

                    // Send via channel (raw binary) if subscribed, fall back to event
                    if let Some(ch) = reader_channels.get(&reader_pty_id) {
                        let _ = ch.send(InvokeResponseBody::Raw(chunk));
                    } else {
                        let _ = reader_app.emit(&format!("pty-output:{}", reader_pty_id), chunk);
                    }
                }
            }
        }
    });

    // ── Idle watchdog thread ───────────────────────────────────────────────────
    let watchdog_last = last_output_at;
    let watchdog_done = session_done.clone();
    let watchdog_app = app_handle.clone();
    let watchdog_session_id = session_id.clone();

    std::thread::spawn(move || {
        let mut attention_emitted = false;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(WATCHDOG_INTERVAL_SECS));
            if watchdog_done.load(Ordering::Relaxed) {
                break;
            }
            let idle_secs = now_secs() - watchdog_last.load(Ordering::Relaxed);
            if idle_secs >= IDLE_THRESHOLD_SECS && !attention_emitted {
                attention_emitted = true;
                let _ = watchdog_app.emit("agent:needs-attention", &watchdog_session_id);
            } else if idle_secs < IDLE_THRESHOLD_SECS && attention_emitted {
                attention_emitted = false;
                let _ = watchdog_app.emit("agent:active", &watchdog_session_id);
            }
        }
    });

    // ── Finish PTY setup ───────────────────────────────────────────────────────
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Pre-fill the command name in the shell's input buffer (no newline).
    let prefix = format!("{} ", input.tool.bin_name());
    std::io::Write::write_all(&mut writer, prefix.as_bytes())
        .map_err(|e| e.to_string())?;

    pty_store
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            pty_id.clone(),
            crate::PtySession {
                master: pair.master,
                writer,
                child,
                shutdown: session_done.clone(),
            },
        );

    let info = AgentSessionInfo {
        session_id: session_id.clone(),
        tool: input.tool,
        repo_path: input.repo_path,
        worktree_path: worktree.path,
        worktree_name: branch_name,
        pty_id,
        status: AgentStatus::Running,
        created_at: now_secs(),
    };

    sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session_id, info.clone());

    Ok(info)
}

pub(super) fn kill_session(
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, AgentSessionInfo>>>,
    pty_store: Arc<Mutex<HashMap<String, crate::PtySession>>>,
) -> Result<(), String> {
    let pty_id = {
        let mut s = sessions.lock().map_err(|e| e.to_string())?;
        if let Some(info) = s.get_mut(&session_id) {
            let id = info.pty_id.clone();
            info.status = AgentStatus::Failed;
            Some(id)
        } else {
            None
        }
    };

    if let Some(id) = pty_id {
        let mut store = pty_store.lock().map_err(|e| e.to_string())?;
        if let Some(mut sess) = store.remove(&id) {
            let _ = sess.child.kill();
        }
    }

    Ok(())
}

/// Kills the PTY, removes the git worktree, and drops the session + scrollback
/// from memory. Intended as the explicit "clean up" action after a session ends.
pub(super) fn cleanup_session(
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, AgentSessionInfo>>>,
    pty_store: Arc<Mutex<HashMap<String, crate::PtySession>>>,
    scrollback: ScrollbackStore,
) -> Result<(), String> {
    // Pull session info and remove it from the map atomically
    let (pty_id, repo_path, worktree_name) = {
        let mut s = sessions.lock().map_err(|e| e.to_string())?;
        if let Some(info) = s.remove(&session_id) {
            (info.pty_id, info.repo_path, info.worktree_name)
        } else {
            return Err(format!("session {} not found", session_id));
        }
    };

    // Kill PTY if still alive
    {
        let mut store = pty_store.lock().map_err(|e| e.to_string())?;
        if let Some(mut sess) = store.remove(&pty_id) {
            let _ = sess.child.kill();
        }
    }

    // Drop scrollback
    scrollback
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&pty_id);

    // Remove the worktree (force=true since the agent may have left uncommitted files)
    crate::git::git_remove_worktree_impl(repo_path, worktree_name, true)
}
