//! Language-server supervision.
//!
//! This module owns exactly three things: finding a server binary, running it
//! as a child process, and moving framed JSON-RPC between that process's stdio
//! and the frontend. It does **not** speak LSP. It never parses a message body,
//! never tracks a request id, and has no opinion about capabilities — those
//! live in `frontend/src/components/editor/lspClient.ts`, because that is the
//! side that has to turn them into Monaco providers and the side that knows
//! which documents are open.
//!
//! Splitting it there rather than in Rust is what keeps `<constraints>`' rule
//! honest ("process spawning and LSP framing stay in Rust; the frontend LSP
//! client is a transport + provider layer with no process knowledge") without
//! also duplicating the whole protocol type set in two languages.
//!
//! **Threads, not the async runtime.** Every blocking edge gets its own OS
//! thread: one reading stdout, one draining stderr, one writing stdin from a
//! channel. Nothing here blocks a Tokio worker — `lsp_send` is a channel push
//! and returns immediately even when the server has stopped reading its pipe,
//! which is precisely the case where an inline `write_all` would wedge the UI.
//!
//! **A dead server is not an error.** No binary on `PATH` means `lsp_locate`
//! returns `None` and the frontend never starts a session; a server that exits
//! emits `lsp-exit` and the editor carries on without it. Nothing in this file
//! can fail in a way that takes the editor with it.

pub mod framing;

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use framing::{encode, FrameDecoder};

/// One framed message from a server, verbatim. The payload stays a `String`
/// rather than a parsed value: re-serialising it here would cost a full
/// round trip through `serde_json` per message for no benefit, since the
/// frontend parses it anyway.
const MESSAGE_EVENT: &str = "lsp-message";
/// A line the server wrote to stderr. This is the "show output log" content.
const LOG_EVENT: &str = "lsp-log";
/// The server process ended, expectedly or otherwise.
const EXIT_EVENT: &str = "lsp-exit";

/// Stderr lines longer than this are truncated. rust-analyzer can emit very
/// long backtraces and the log surface is a scrolling list, not a file viewer.
const MAX_LOG_LINE: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessageEvent {
    session_id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    session_id: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    session_id: String,
    /// Process exit status, when there was one. `None` means killed by a signal
    /// or unavailable.
    code: Option<i32>,
    /// `true` when `lsp_stop` asked for this. The frontend uses it to tell a
    /// restart from a crash — only the latter touches the crash counter, so a
    /// user toggling the setting off never sees a "stopped unexpectedly" chip.
    requested: bool,
    /// One line of context for the log surface, e.g. a framing failure.
    reason: String,
}

enum Outgoing {
    Message(String),
    /// Close the server's stdin. That is the LSP-blessed way to make a server
    /// that ignored `shutdown` give up.
    Close,
}

struct Session {
    tx: Sender<Outgoing>,
    child: Arc<Mutex<Child>>,
    requested_stop: Arc<AtomicBool>,
}

/// Live sessions, keyed by the frontend-minted session id.
///
/// A module-level `OnceLock` rather than Tauri managed state, matching
/// `fs/search.rs`: it keeps the diff against `lib.rs` down to the appended
/// command lines, where the registration order is shared with other branches.
fn sessions() -> &'static DashMap<String, Session> {
    static SESSIONS: OnceLock<DashMap<String, Session>> = OnceLock::new();
    SESSIONS.get_or_init(DashMap::new)
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/// Directories to look in, beyond `PATH`.
///
/// A macOS app launched from Finder inherits a `PATH` of roughly
/// `/usr/bin:/bin:/usr/sbin:/sbin` — not the one the user's shell builds. Every
/// realistic install location for these two servers (`cargo install`, Homebrew,
/// npm, a version manager) is therefore invisible unless we look explicitly.
/// The alternative, spawning a login shell to ask it for `PATH`, costs a shell
/// startup per lookup and inherits whatever that shell's rc file decides to do.
fn extra_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs
}

/// Every directory a server binary might live in, `PATH` first so a user's own
/// ordering still wins.
fn search_dirs() -> Vec<PathBuf> {
    let from_path: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    // Deduplicated, including within `PATH` itself: a shell profile sourced
    // twice leaves repeats there, and this list is also what gets handed to the
    // child as its own `PATH`.
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in from_path.into_iter().chain(extra_search_dirs()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Candidate file names for `command` on this platform. On Windows a server
/// installed by npm is a `.cmd` shim, which `Command` will not find by bare
/// name.
fn candidates(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            command.to_string(),
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
        ]
    } else {
        vec![command.to_string()]
    }
}

/// Absolute path of `command`, or `None` when it is not installed.
///
/// An input that already looks like a path is checked directly rather than
/// searched — that is the Settings override, and a user who typed a path meant
/// that exact file.
pub fn locate(command: &str) -> Option<PathBuf> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    if command.contains('/') || command.contains('\\') {
        let path = PathBuf::from(command);
        return is_executable(&path).then_some(path);
    }
    for dir in search_dirs() {
        for name in candidates(command) {
            let candidate = dir.join(&name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

/// Emit `lsp-exit` exactly once per session and forget it.
///
/// Called from the reader thread when the pipe closes. Removing the entry here
/// rather than in `lsp_stop` means a crashed session cannot leave a handle
/// behind that a later `lsp_send` writes into a dead pipe.
fn finish(app: &AppHandle, session_id: &str, reason: String) {
    let Some((_, session)) = sessions().remove(session_id) else {
        return;
    };
    let requested = session.requested_stop.load(Ordering::Relaxed);
    let _ = session.tx.send(Outgoing::Close);

    let code = session
        .child
        .lock()
        .ok()
        .and_then(|mut c| c.wait().ok())
        .and_then(|status| status.code());

    let _ = app.emit(
        EXIT_EVENT,
        ExitEvent {
            session_id: session_id.to_string(),
            code,
            requested,
            reason,
        },
    );
}

/// Spawn `command` and wire its three pipes up to threads.
///
/// Returns the resolved binary path, which the frontend shows in the log header
/// so "which rust-analyzer is this" is answerable without a terminal.
fn spawn_session(
    app: AppHandle,
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let binary = locate(&command).ok_or_else(|| format!("{command} is not installed"))?;

    let mut cmd = Command::new(&binary);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.as_deref().filter(|d| Path::new(d).is_dir()) {
        cmd.current_dir(dir);
    }
    // Hand the augmented search path down: `typescript-language-server` shells
    // out to `tsserver`, and rust-analyzer to `rustup`/`cargo`, both of which
    // would be missing from a Finder-launched app's inherited PATH.
    let joined = std::env::join_paths(search_dirs()).map_err(|e| e.to_string())?;
    cmd.env("PATH", joined);
    #[cfg(windows)]
    {
        // No console window for a background server.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", binary.display()))?;

    let stdin = child.stdin.take().ok_or("no stdin on language server")?;
    let stdout = child.stdout.take().ok_or("no stdout on language server")?;
    let stderr = child.stderr.take().ok_or("no stderr on language server")?;

    let (tx, rx) = channel::<Outgoing>();
    let child = Arc::new(Mutex::new(child));
    let requested_stop = Arc::new(AtomicBool::new(false));

    sessions().insert(
        session_id.clone(),
        Session {
            tx: tx.clone(),
            child,
            requested_stop,
        },
    );

    // ── Writer. Owns stdin; dropping it is what closes the pipe. ────────────
    std::thread::Builder::new()
        .name(format!("lsp-write-{session_id}"))
        .spawn(move || {
            let mut stdin = stdin;
            while let Ok(msg) = rx.recv() {
                match msg {
                    Outgoing::Message(text) => {
                        if stdin.write_all(&encode(&text)).is_err() || stdin.flush().is_err() {
                            break;
                        }
                    }
                    Outgoing::Close => break,
                }
            }
            // Explicit, so the intent is not mistaken for a stray binding.
            drop(stdin);
        })
        .map_err(|e| e.to_string())?;

    // ── stderr. Line-oriented; this is the output log. ──────────────────────
    {
        let app = app.clone();
        let id = session_id.clone();
        std::thread::Builder::new()
            .name(format!("lsp-err-{id}"))
            .spawn(move || {
                use std::io::BufRead;
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(mut line) = line else { break };
                    if line.len() > MAX_LOG_LINE {
                        line.truncate(MAX_LOG_LINE);
                        line.push('…');
                    }
                    let _ = app.emit(
                        LOG_EVENT,
                        LogEvent {
                            session_id: id.clone(),
                            line,
                        },
                    );
                }
            })
            .map_err(|e| e.to_string())?;
    }

    // ── stdout. Framed messages in, Tauri events out. ───────────────────────
    {
        let app = app.clone();
        let id = session_id.clone();
        std::thread::Builder::new()
            .name(format!("lsp-read-{id}"))
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                let mut decoder = FrameDecoder::new();
                let mut chunk = [0u8; 16 * 1024];
                let reason = loop {
                    let read = match reader.read(&mut chunk) {
                        Ok(0) => {
                            // A non-empty buffer at EOF means the server died
                            // partway through writing a message — worth saying,
                            // because it reads very differently in the log from
                            // a clean shutdown.
                            let held = decoder.pending();
                            break if held > 0 {
                                format!("server closed its output stream mid-message ({held} bytes held)")
                            } else {
                                "server closed its output stream".to_string()
                            };
                        }
                        Ok(n) => n,
                        Err(e) => break format!("read failed: {e}"),
                    };
                    decoder.push(&chunk[..read]);
                    let mut fatal = None;
                    loop {
                        match decoder.next_message() {
                            Ok(Some(message)) => {
                                let _ = app.emit(
                                    MESSAGE_EVENT,
                                    MessageEvent {
                                        session_id: id.clone(),
                                        message,
                                    },
                                );
                            }
                            Ok(None) => break,
                            // Unrecoverable by construction: the byte offsets
                            // are no longer trustworthy, so the session ends
                            // rather than delivering garbage the client would
                            // interpret as responses to the wrong requests.
                            Err(e) => {
                                fatal = Some(format!("protocol error: {e}"));
                                break;
                            }
                        }
                    }
                    if let Some(reason) = fatal {
                        break reason;
                    }
                };
                finish(&app, &id, reason);
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(binary.to_string_lossy().to_string())
}

// ─── Tauri command surface ───────────────────────────────────────────────────

/// Where `command` resolves to, or `None` when it is not installed.
///
/// The frontend calls this *before* starting anything, and an answer of `None`
/// is the whole "absent binary" path: no session, no status segment, today's
/// editor. It is deliberately not an `Err` — not having a language server
/// installed is not an error condition.
#[tauri::command]
pub async fn lsp_locate(command: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        locate(&command).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Start a language server. Resolves with the absolute path it started.
///
/// `session_id` is minted by the caller and is the handle for everything else.
/// Starting a session id that is already running is an error rather than a
/// silent replace — two servers on one id would interleave their responses.
#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    session_id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    if sessions().contains_key(&session_id) {
        return Err(format!("language server session {session_id} is already running"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        spawn_session(app, session_id, command, args, cwd)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Queue one JSON-RPC message for a running server.
///
/// Returns immediately: the write happens on the session's writer thread, so a
/// server that has stopped draining its stdin cannot block the caller. An
/// unknown id is an `Err` and not a panic — the session may have crashed
/// between the frontend's decision to send and this call.
#[tauri::command]
pub fn lsp_send(session_id: String, message: String) -> Result<(), String> {
    let session = sessions()
        .get(&session_id)
        .ok_or_else(|| format!("no language server session {session_id}"))?;
    session
        .tx
        .send(Outgoing::Message(message))
        .map_err(|_| format!("language server session {session_id} is not accepting input"))
}

/// Stop a server.
///
/// Closes stdin first — the polite exit a server that honoured `shutdown` is
/// already waiting for — then kills, because a server that ignores both would
/// otherwise outlive the app. The `lsp-exit` this produces is marked
/// `requested`, so the frontend does not count it as a crash.
#[tauri::command]
pub fn lsp_stop(session_id: String) {
    // The `DashMap` reference is dropped at the end of this block, before the
    // kill: holding it across the `wait` the reader thread's `finish` is about
    // to do would deadlock the map.
    let child = {
        let Some(session) = sessions().get(&session_id) else {
            return;
        };
        session.requested_stop.store(true, Ordering::Relaxed);
        let _ = session.tx.send(Outgoing::Close);
        session.child.clone()
    };
    let guard = child.lock();
    if let Ok(mut child) = guard {
        let _ = child.kill();
    }
    // The entry itself is removed by the reader thread's `finish`, which is
    // also what emits the exit event — one owner for that transition.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_rejects_a_command_that_does_not_exist() {
        assert!(locate("voidlink-definitely-not-a-real-binary").is_none());
    }

    #[test]
    fn locate_rejects_an_empty_command() {
        assert!(locate("").is_none());
        assert!(locate("   ").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn locate_finds_a_binary_on_path() {
        // `sh` is on PATH on every unix this app runs on.
        let found = locate("sh").expect("sh must be locatable");
        assert!(found.is_absolute());
        assert!(is_executable(&found));
    }

    #[cfg(unix)]
    #[test]
    fn locate_accepts_an_absolute_path_verbatim() {
        let sh = locate("sh").unwrap();
        assert_eq!(locate(&sh.to_string_lossy()), Some(sh));
    }

    #[cfg(unix)]
    #[test]
    fn locate_rejects_a_path_that_is_not_executable() {
        let dir = std::env::temp_dir().join("voidlink-lsp-locate");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-server");
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();
        assert!(locate(&file.to_string_lossy()).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_dirs_include_the_usual_install_locations() {
        let dirs = search_dirs();
        assert!(dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn search_dirs_have_no_duplicates() {
        let dirs = search_dirs();
        let mut unique = dirs.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(dirs.len(), unique.len());
    }
}
