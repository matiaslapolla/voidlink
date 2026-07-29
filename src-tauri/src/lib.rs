use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;
use serde::Serialize;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri::ipc::{Channel, InvokeResponseBody};

mod browser;
mod git;
mod fs;
mod lsp;
mod brain;
mod menu;
mod secrets;
mod window;

// ─── PTY session store ────────────────────────────────────────────────────────

pub(crate) struct PtySession {
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    /// Keystrokes queued for the session's writer thread.
    ///
    /// Writes are handed off rather than performed in the command so that the
    /// order bytes reach the shell is fixed at enqueue time, on the IPC thread,
    /// in the order the frontend sent them. Writing under a mutex from an async
    /// command instead lets two in-flight `write_pty` calls race for the lock,
    /// which reorders a fast paste or a bracketed-paste wrapper around its own
    /// payload.
    pub input: Mutex<std::sync::mpsc::Sender<Vec<u8>>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    pub shutdown: Arc<AtomicBool>,
    #[cfg(unix)]
    pub master_fd: std::os::unix::io::RawFd,
    pub child_pid: Option<u32>,
}

pub(crate) type PtyStore = Arc<DashMap<String, PtySession>>;

/// Raw PTY bytes retained per session so a re-subscribing frontend can rebuild
/// its screen. Sized to cover a screenful of a busy TUI several times over
/// while staying bounded per session.
const SCROLLBACK_CAP_BYTES: usize = 512 * 1024;

/// Where a session's output goes, plus what it has already produced.
///
/// The frontend does not keep one terminal pane alive per PTY: switching
/// worktrees swaps the whole pane list, so the xterm instance is disposed and a
/// fresh, empty one is constructed when the user comes back. With output going
/// only to a live channel that meant two bugs at once — the returning pane
/// painted an empty (black) grid, and everything the shell wrote while it was
/// unmounted was dropped on the floor. Retaining a bounded window of raw bytes
/// and replaying it on subscribe fixes both, and keeps the channel and the
/// backlog under one lock so the reader thread can never interleave a live
/// chunk into the middle of a replay.
pub(crate) struct PtySink {
    /// `None` while no pane is attached — output is buffered only.
    channel: Option<Channel>,
    /// Retained chunks, oldest first, at the read() boundaries the terminal
    /// originally saw. Whole chunks are evicted, so the retained stream is a
    /// mid-stream cut — see `attach` for how the replay is made safe.
    scrollback: std::collections::VecDeque<Vec<u8>>,
    bytes: usize,
    /// Set once anything has been evicted. From then on the retained bytes are
    /// no longer a session from the beginning, so a replay cannot be trusted to
    /// establish the emulator's mode state on its own.
    truncated: bool,
    /// Incremented on every `attach`. Handed to the subscriber so it can
    /// detach without being able to detach a *later* pane's channel — during a
    /// remount the new pane can subscribe before the old one's cleanup runs.
    attach_seq: u64,
}

/// Put the emulator into a known state before replaying a mid-stream cut.
///
/// DECSTR (soft reset) is the blunt instrument that matters: it restores
/// autowrap, origin mode, the scroll region and the character sets. The single
/// mode worth naming explicitly afterwards is DECAWM — if a full-screen program
/// disabled autowrap with `ESC[?7l` and the chunk carrying the matching
/// `ESC[?7h` was evicted, every line typed after the replay overwrites the last
/// column in place instead of wrapping, which looks like the input folding back
/// on itself. SGR reset stops a half-replayed colour run from tinting the rest.
const REPLAY_PROLOGUE: &[u8] = b"\x1b[!p\x1b[?7h\x1b[m";

/// The tail of `head` starting after its first newline, which is the earliest
/// byte we can be sure is not inside an escape sequence (no control or escape
/// sequence xterm parses contains a raw `\n`). Without this the first bytes of
/// a truncated replay are read as the parameters of a sequence whose introducer
/// was evicted, and the visible characters that follow are swallowed.
///
/// A chunk with no newline at all is kept whole: at 64 KiB that is a full-screen
/// repaint, and dropping it loses far more than a single mangled sequence costs.
fn resync(head: &[u8]) -> &[u8] {
    match head.iter().position(|&b| b == b'\n') {
        Some(i) => &head[i + 1..],
        None => head,
    }
}

impl PtySink {
    fn new() -> Self {
        Self {
            channel: None,
            scrollback: std::collections::VecDeque::new(),
            bytes: 0,
            truncated: false,
            attach_seq: 0,
        }
    }

    /// Record a chunk and forward it to the attached pane, if any. A send
    /// failure means the pane went away without unsubscribing, so we drop the
    /// channel and keep buffering rather than logging once per read.
    fn push(&mut self, chunk: Vec<u8>) {
        if let Some(ch) = &self.channel {
            if ch.send(InvokeResponseBody::Raw(chunk.clone())).is_err() {
                self.channel = None;
            }
        }
        self.bytes += chunk.len();
        self.scrollback.push_back(chunk);
        while self.bytes > SCROLLBACK_CAP_BYTES {
            match self.scrollback.pop_front() {
                Some(old) => {
                    self.bytes -= old.len();
                    self.truncated = true;
                }
                None => break,
            }
        }
    }

    /// Attach a pane and hand it everything the session has produced so far.
    /// Returns the token the subscriber must present to detach.
    /// Returns the attachment token and the exact byte length of the replay
    /// that was just pushed down `channel`, which is always a single send.
    ///
    /// The length is not bookkeeping — the subscriber needs it to know where
    /// the replay ends. Replayed bytes are indistinguishable from live output
    /// once they are in the channel, and a replay re-feeds every *query* the
    /// session ever emitted (`ESC[6n`, `ESC[c`, `OSC 11 ?`, DECRQM …) back
    /// through the emulator, which dutifully answers each one down its input
    /// path. Those answers reach the shell as if they had been typed, which is
    /// the stray `[57;1R` / `[?62;c` litter that appears on every re-attach.
    /// The subscriber suppresses its input path for exactly this many bytes.
    fn attach(&mut self, channel: Channel) -> (u64, usize) {
        self.attach_seq += 1;
        let mut replayed = 0usize;
        if self.bytes > 0 {
            let replay = self.build_replay();
            replayed = replay.len();
            if channel.send(InvokeResponseBody::Raw(replay)).is_err() {
                return (self.attach_seq, 0);
            }
        }
        self.channel = Some(channel);
        (self.attach_seq, replayed)
    }

    /// The bytes a fresh subscriber is sent to reconstruct the session, as one
    /// contiguous buffer. Split out from `attach` so the replay — and above all
    /// its length, which the subscriber gates its input path on — is testable
    /// without a `Channel`.
    fn build_replay(&self) -> Vec<u8> {
        let mut replay = Vec::with_capacity(self.bytes + REPLAY_PROLOGUE.len());
        let mut chunks = self.scrollback.iter();
        if self.truncated {
            replay.extend_from_slice(REPLAY_PROLOGUE);
            if let Some(head) = chunks.next() {
                replay.extend_from_slice(resync(head));
            }
        }
        for chunk in chunks {
            replay.extend_from_slice(chunk);
        }
        replay
    }

    /// Drop the attached channel, keeping the session buffering. Ignored when
    /// `token` is not the current attachment, so a pane tearing down after its
    /// replacement has already subscribed cannot mute the live pane.
    fn detach(&mut self, token: u64) {
        if token == self.attach_seq {
            self.channel = None;
        }
    }
}

pub(crate) type PtyChannels = Arc<DashMap<String, Mutex<PtySink>>>;

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

/// The OS the app is running on: `"macos"`, `"windows"`, `"linux"`, …
///
/// The frontend needs this to decide between the native macOS window chrome
/// and the custom title bar we draw everywhere else. Resolved from the build
/// target rather than the user agent, so it can never be spoofed or drift.
#[tauri::command]
fn get_platform_os() -> &'static str {
    std::env::consts::OS
}

/// Payload of `pty-exit:<sessionId>`.
///
/// This used to be `()`, which meant the frontend could see *that* a shell died
/// but never *how* — so `store/activity.ts`'s `failed` mark was unreachable, and
/// both it and `store/terminalWatch.ts` carried a comment saying so. Carrying the
/// status is what closes that.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExitPayload {
    /// The shell's exit status, or `None` when we could not obtain one — a
    /// session already reaped by `close_pty`, or a `wait` that failed.
    exit_code: Option<u32>,
}

/// Reap the child and read its status.
///
/// Called from the reader thread on EOF, which is *after* the shell has closed
/// its end of the PTY, so the child has either exited or is about to and `wait`
/// returns promptly rather than blocking the thread. The `DashMap` shard lock is
/// held for that window; nothing else in the store does anything slow under the
/// child mutex (`kill` and `try_wait` are both non-blocking), so there is no
/// cycle to deadlock on.
fn reap_exit_code(store: &PtyStore, session_id: &str) -> Option<u32> {
    let session = store.get(session_id)?;
    let mut child = session.child.lock().ok()?;
    child.wait().ok().map(|status| status.exit_code())
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

        // ── Environment wiring ────────────────────────────────────────────
        // When Tauri is launched from Finder / Dock / a non-shell launcher,
        // it inherits a minimal env (PATH=/usr/bin:/bin:/usr/sbin:/sbin and
        // missing version-manager / homebrew bits). If we then inherit that
        // env into the PTY, the shell's login startup scripts (zprofile,
        // bash_profile) see a pre-populated PATH and only *append* to it —
        // so user tools like `claude`, `node`, `mise`-installed binaries
        // resolve to stale system copies or aren't found at all.
        //
        // Fix: clear env and re-export only variables that aren't path-like
        // or app-launcher-specific. PATH and friends are intentionally
        // dropped so the login shell + /etc/zprofile's path_helper rebuild
        // them from scratch, identical to how Terminal.app spawns a shell.
        cmd.env_clear();
        const PASSTHROUGH: &[&str] = &[
            "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
            "LC_MESSAGES", "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY",
            "TZ", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
            "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "SSH_AUTH_SOCK",
        ];
        for key in PASSTHROUGH {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| e.to_string())?;
        let child_pid = child.process_id();

        let session_id = uuid::Uuid::new_v4().to_string();
        let shutdown = Arc::new(AtomicBool::new(false));

        // Register the sink before the reader starts so the shell's login
        // banner and first prompt are retained even though the frontend has
        // not had a chance to subscribe yet.
        chans.insert(session_id.clone(), Mutex::new(PtySink::new()));

        let reader_session_id = session_id.clone();
        let reader_app_handle = app_handle.clone();
        let reader_channels = chans.clone();
        let reader_shutdown = shutdown.clone();
        let reader_store = store.clone();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

        std::thread::spawn(move || {
            let mut buf = [0u8; 65536];
            loop {
                if reader_shutdown.load(Ordering::Relaxed) {
                    break;
                }
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = reader_app_handle.emit(
                            &format!("pty-exit:{}", reader_session_id),
                            PtyExitPayload {
                                exit_code: reap_exit_code(&reader_store, &reader_session_id),
                            },
                        );
                        break;
                    }
                    Ok(n) => {
                        // The sink is created with the session, so this only
                        // misses if the session was closed mid-read — in which
                        // case the shutdown flag ends the loop imminently.
                        if let Some(sink) = reader_channels.get(&reader_session_id) {
                            if let Ok(mut sink) = sink.lock() {
                                sink.push(buf[..n].to_vec());
                            }
                        }
                    }
                }
            }
            reader_channels.remove(&reader_session_id);
        });

        // One writer thread per session, fed by an ordered queue. The blocking
        // write happens here rather than in the command so a shell that stops
        // draining its input (a full pipe) can never stall the IPC thread.
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let (input, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            while let Ok(chunk) = rx.recv() {
                if std::io::Write::write_all(&mut writer, &chunk).is_err() {
                    break;
                }
                let _ = std::io::Write::flush(&mut writer);
            }
        });

        #[cfg(unix)]
        let master_fd = pair.master.as_raw_fd().unwrap_or(-1);

        let session = PtySession {
            master: Mutex::new(pair.master),
            input: Mutex::new(input),
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

/// Deliberately **not** an async command. A sync handler runs inline as the IPC
/// message is processed, so calls are enqueued in the order the frontend made
/// them; async handlers are spawned onto the runtime and are free to interleave,
/// which is how a fast paste arrives at the shell permuted. All this does is
/// hand the bytes to the session's writer thread, so running inline costs the
/// IPC thread nothing.
#[tauri::command]
fn write_pty(
    session_id: String,
    data: String,
    state: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    let session = state.get(&session_id).ok_or("PTY session not found")?;
    let input = session.input.lock().map_err(|e| e.to_string())?;
    input
        .send(data.into_bytes())
        .map_err(|_| "PTY writer has exited".to_string())
}

#[tauri::command]
async fn resize_pty(
    session_id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyStore>,
) -> Result<(), String> {
    use portable_pty::PtySize;
    // `resize` is a blocking ioctl on the master fd, so it belongs on the
    // blocking pool for the same reason `create_pty` does — an async command
    // body runs on a runtime worker that must not block.
    let store = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = store.get(&session_id).ok_or("PTY session not found")?;
        let master = session.master.lock().map_err(|e| e.to_string())?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// What a subscriber gets back: the token it detaches with, and how many bytes
/// of the stream it is about to receive are replay rather than live output.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyAttachment {
    token: u64,
    replay_bytes: usize,
}

#[tauri::command]
async fn pty_subscribe(
    session_id: String,
    on_output: Channel,
    state: tauri::State<'_, PtyChannels>,
) -> Result<PtyAttachment, String> {
    // Replaying happens under the sink's lock, so live output produced during
    // the replay queues behind it instead of arriving out of order.
    let sink = state
        .entry(session_id)
        .or_insert_with(|| Mutex::new(PtySink::new()));
    let (token, replay_bytes) = sink
        .lock()
        .map_err(|_| "pty sink poisoned".to_string())?
        .attach(on_output);
    Ok(PtyAttachment { token, replay_bytes })
}

/// Detach the pane that holds `token`, leaving the session running and its
/// output buffered for whoever subscribes next.
///
/// Without this a disposed pane's channel is held until the *next* write to it
/// happens to fail, so every unmounted pane keeps its webview-side receiver
/// reachable and every byte the shell produces is still serialised and posted
/// across the IPC boundary to nobody.
#[tauri::command]
async fn pty_unsubscribe(
    session_id: String,
    token: u64,
    state: tauri::State<'_, PtyChannels>,
) -> Result<(), String> {
    if let Some(sink) = state.get(&session_id) {
        if let Ok(mut sink) = sink.lock() {
            sink.detach(token);
        }
    }
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

/// Foreground-process introspection for terminal tab titles.
///
/// The old implementation only read `/proc`, so on macOS every tab reported a
/// `null` name and never showed what was running. Each platform gets its own
/// primitives here; the naming heuristics on top of them are shared.
#[cfg(unix)]
pub(crate) mod proc_info {
    /// Display name for `pid`: the executable's basename, refined through
    /// argv when that executable is a language runtime. `node` alone tells the
    /// user nothing — `claude-code` or `vite` is the thing they launched.
    pub fn name(pid: u32) -> Option<String> {
        let exe = exe_name(pid)?;
        if !is_runtime(&exe) {
            return Some(exe);
        }
        Some(argv(pid).and_then(|a| script_name(&a)).unwrap_or(exe))
    }

    /// Interpreters that are never the interesting name — the script they were
    /// handed is. `env` and the shells appear as the exec'd binary when a
    /// shebang script is launched.
    fn is_runtime(name: &str) -> bool {
        matches!(
            name,
            "node" | "node.exe" | "deno" | "bun" | "npx" | "pnpm" | "yarn" | "uv" | "uvx"
                | "python" | "python2" | "python3" | "pythonw" | "ruby" | "perl" | "php"
                | "env" | "sh" | "bash" | "zsh" | "fish" | "dash"
        )
    }

    /// Basenames that name a role rather than a program. When argv points at
    /// one we climb to the nearest meaningful ancestor directory instead —
    /// `.../@anthropic-ai/claude-code/cli.js` reads better as `claude-code`.
    fn is_generic(stem: &str) -> bool {
        matches!(
            stem,
            "cli" | "index" | "main" | "__main__" | "run" | "start" | "server" | "app" | "bin"
        )
    }

    fn is_script_ext(ext: &str) -> bool {
        matches!(
            ext,
            "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "py" | "rb" | "pl" | "php" | "sh"
        )
    }

    /// Path segments that only describe layout, never the package.
    fn is_layout_dir(seg: &str) -> bool {
        matches!(
            seg,
            "bin" | ".bin" | "lib" | "libexec" | "src" | "dist" | "build" | "out" | "js"
                | "esm" | "cjs" | "node_modules" | "site-packages" | "scripts"
        )
    }

    /// First non-flag argument after argv[0], reduced to a friendly name.
    /// Flags are skipped, which incidentally makes `python -m pkg` resolve to
    /// `pkg` — the module name is the first bare word.
    fn script_name(argv: &[String]) -> Option<String> {
        let arg = argv
            .iter()
            .skip(1)
            .find(|a| !a.starts_with('-') && !a.is_empty())?;
        let segments: Vec<&str> = arg.split('/').filter(|s| !s.is_empty()).collect();
        let last = *segments.last()?;
        // Only script extensions are stripped — a bare `rsplit_once('.')`
        // would turn a module path like `http.server` into `http`.
        let stem = match last.rsplit_once('.') {
            Some((s, ext)) if is_script_ext(ext) && !s.is_empty() => s,
            _ => last,
        };
        if !is_generic(stem) {
            return Some(stem.to_string());
        }
        segments
            .iter()
            .rev()
            .skip(1)
            .find(|s| !is_layout_dir(s) && !s.starts_with('@'))
            .map(|s| s.to_string())
            .or_else(|| Some(stem.to_string()))
    }

    fn basename(path: &str) -> Option<String> {
        let base = path.rsplit('/').next()?.trim();
        if base.is_empty() {
            None
        } else {
            Some(base.to_string())
        }
    }

    #[cfg(target_os = "macos")]
    fn exe_name(pid: u32) -> Option<String> {
        let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let n = unsafe {
            libc::proc_pidpath(
                pid as libc::c_int,
                buf.as_mut_ptr() as *mut libc::c_void,
                buf.len() as u32,
            )
        };
        if n <= 0 {
            return None;
        }
        buf.truncate(n as usize);
        basename(&String::from_utf8_lossy(&buf))
    }

    #[cfg(target_os = "macos")]
    pub fn cwd(pid: u32) -> Option<String> {
        let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
        let n = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDVNODEPATHINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            )
        };
        if n < size {
            return None;
        }
        let path = unsafe {
            std::ffi::CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr() as *const libc::c_char)
        }
        .to_string_lossy()
        .to_string();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }

    /// macOS has no `/proc/<pid>/cmdline`; argv comes from
    /// `sysctl kern.procargs2`, whose payload is
    /// `[argc: i32][exec path]\0…\0[argv[0]]\0[argv[1]]\0…[env]`.
    #[cfg(target_os = "macos")]
    fn argv(pid: u32) -> Option<Vec<String>> {
        let mut argmax: libc::c_int = 0;
        let mut len = std::mem::size_of::<libc::c_int>();
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let ok = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                &mut argmax as *mut _ as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 || argmax <= 0 {
            return None;
        }

        let mut buf = vec![0u8; argmax as usize];
        let mut len = buf.len();
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
        let ok = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                buf.as_mut_ptr() as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if ok != 0 {
            return None;
        }
        buf.truncate(len);
        parse_procargs2(&buf)
    }

    #[cfg(target_os = "macos")]
    fn parse_procargs2(buf: &[u8]) -> Option<Vec<String>> {
        if buf.len() < 4 {
            return None;
        }
        let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
        if argc <= 0 {
            return None;
        }
        let rest = &buf[4..];
        // Skip the exec path, then the NUL padding that aligns argv[0].
        let mut i = rest.iter().position(|&b| b == 0)?;
        while i < rest.len() && rest[i] == 0 {
            i += 1;
        }
        let mut args = Vec::with_capacity(argc as usize);
        for chunk in rest[i..].split(|&b| b == 0) {
            if args.len() == argc as usize {
                break;
            }
            args.push(String::from_utf8_lossy(chunk).to_string());
        }
        if args.is_empty() {
            None
        } else {
            Some(args)
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn exe_name(pid: u32) -> Option<String> {
        if let Ok(path) = std::fs::read_link(format!("/proc/{}/exe", pid)) {
            if let Some(name) = basename(&path.to_string_lossy()) {
                return Some(name);
            }
        }
        std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .ok()
            .and_then(|s| basename(s.trim()))
    }

    #[cfg(not(target_os = "macos"))]
    pub fn cwd(pid: u32) -> Option<String> {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    }

    #[cfg(not(target_os = "macos"))]
    fn argv(pid: u32) -> Option<Vec<String>> {
        let raw = std::fs::read(format!("/proc/{}/cmdline", pid)).ok()?;
        let args: Vec<String> = raw
            .split(|&b| b == 0)
            .filter(|c| !c.is_empty())
            .map(|c| String::from_utf8_lossy(c).to_string())
            .collect();
        if args.is_empty() {
            None
        } else {
            Some(args)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn plain_binary_keeps_its_name() {
            assert!(!is_runtime("claude"));
            assert!(!is_runtime("lazygit"));
        }

        #[test]
        fn runtime_resolves_to_the_script() {
            let argv = vec!["node".into(), "/usr/local/bin/vite".into(), "--host".into()];
            assert_eq!(script_name(&argv).as_deref(), Some("vite"));
        }

        #[test]
        fn generic_script_climbs_to_the_package_dir() {
            let argv = vec![
                "node".into(),
                "/x/node_modules/@anthropic-ai/claude-code/cli.js".into(),
            ];
            assert_eq!(script_name(&argv).as_deref(), Some("claude-code"));
        }

        #[test]
        fn flags_are_skipped() {
            let argv = vec!["python3".into(), "-m".into(), "http.server".into()];
            assert_eq!(script_name(&argv).as_deref(), Some("http.server"));
        }

        /// Exercises the real platform primitives against our own process —
        /// the part that silently returned `None` on macOS before.
        #[test]
        fn reads_this_process() {
            let pid = std::process::id();
            assert!(name(pid).is_some());
            assert!(cwd(pid).is_some());
        }

        #[test]
        fn runtime_with_no_script_has_no_name() {
            let argv = vec!["node".into()];
            assert_eq!(script_name(&argv), None);
        }
    }
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
        // `busy` is only "something other than the shell is in the foreground".
        // It is true for the entire life of any TUI, which is why the frontend
        // pairs it with an output-rate window before calling anything "working"
        // — see `store/terminalWatch.ts`.
        let busy = shell_pid.is_some_and(|s| s != pid);
        Ok(PtyProcessInfo {
            pid: Some(pid),
            name: proc_info::name(pid),
            cwd: proc_info::cwd(pid),
            busy,
        })
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
        // Replaces Tauri's default menu, whose Close Window item owned Cmd+W
        // natively and closed the window before the webview saw the key.
        .menu(menu::build)
        .on_menu_event(menu::handle_event)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(pty_store.clone())
        .manage(pty_channels)
        .manage(git_state)
        .manage(browser::new_store())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // tauri.conf.json is static, so the platform split for window chrome
            // lives here. macOS keeps the native decorations configured there —
            // they are what give us rounded corners, the drop shadow and the
            // traffic lights. Windows and Linux drop them again and keep the
            // custom chrome (TitleBar buttons + WindowFrame resize strips).
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                window.set_decorations(false)?;
            }

            // Mark a `cargo tauri dev` run everywhere the OS shows this app,
            // not just inside our own chrome: window list, Cmd-Tab, Mission
            // Control. The satellites get the same treatment when they are
            // built (see `window::dev_title`), and the frontend tints its title
            // bars to match. The dock icon comes from `bundle.icon`, which
            // `tauri.dev.conf.json` repoints at `icons/dev/`.
            if tauri::is_dev() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title(&window::dev_title("Voidlink"));
                    // No-op on macOS, where the dock owns the app icon; this is
                    // what actually recolours the window icon on Windows and
                    // Linux, since those draw it in the taskbar per window.
                    if let Some(icon) = app.default_window_icon().cloned() {
                        let _ = window.set_icon(icon);
                    }
                }
            }

            // The git and editor windows are created on demand by
            // `open_git_window` / `open_editor_window`, not here — opening
            // either at startup would put a second window in front of the
            // workbench on every launch.

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Only the main window owns the terminals. Without this label
                // check, closing a satellite window (git, editor) would kill
                // every PTY in the workbench that is still open behind it.
                if window.label() == "main" {
                    let store = window.state::<PtyStore>().inner().clone();
                    kill_all_ptys(&store);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_home_dir,
            get_platform_os,
            window::open_git_window,
            window::close_git_window,
            window::is_git_window_open,
            window::open_editor_window,
            window::close_editor_window,
            window::is_editor_window_open,
            window::focus_editor_window,
            window::focus_main_window,
            create_pty,
            write_pty,
            resize_pty,
            pty_subscribe,
            pty_unsubscribe,
            close_pty,
            pty_process_info,
            git::git_repo_info,
            git::git_list_branches,
            git::git_file_status,
            git::git_log,
            git::git_commit_graph,
            git::git_checkout_branch,
            git::git_stage_files,
            git::git_unstage_files,
            git::git_stage_all,
            git::git_commit,
            git::git_config_identity,
            git::git_push,
            git::git_diff_working,
            git::git_diff_refs,
            git::git_list_refs,
            git::git_ls_files,
            git::git_safe_checkout,
            git::git_apply_hunk,
            git::git_ai_generate_commit,
            git::git_blame_file,
            git::git_list_conflicts,
            git::git_conflict_versions,
            git::git_resolve_conflict,
            git::git_agent_query,
            git::git_list_worktrees,
            git::git_add_worktree,
            git::git_remove_worktree,
            git::worktree_setup_plan,
            git::worktree_apply_setup,
            git::worktree_save_defaults,
            git::git_fetch,
            git::git_pull,
            git::git_discard_file,
            git::git_discard_all,
            git::git_discard_hunk,
            git::git_create_branch,
            git::git_delete_branch,
            git::git_rename_branch,
            git::git_create_tag,
            git::git_delete_tag,
            git::git_push_tag,
            git::git_stash_list,
            git::git_stash_save,
            git::git_stash_apply,
            git::git_stash_pop,
            git::git_stash_drop,
            git::git_stash_show,
            git::git_list_remotes,
            git::git_add_remote,
            git::git_remove_remote,
            git::git_rename_remote,
            git::git_set_remote_url,
            git::git_merge,
            git::git_merge_abort,
            git::git_rebase,
            git::git_rebase_continue,
            git::git_rebase_abort,
            git::git_cherry_pick,
            git::git_cherry_pick_continue,
            git::git_cherry_pick_abort,
            git::git_revert,
            git::git_revert_continue,
            git::git_revert_abort,
            git::git_amend,
            git::git_undo_last_commit,
            git::git_reset,
            git::stack::git_stack_current,
            git::stack::git_stack_list,
            git::stack::git_stack_create_branch,
            git::stack::git_stack_set_parent,
            git::stack::git_stack_untrack,
            git::stack::git_stack_restack,
            git::stack::git_stack_restack_all,
            git::stack::git_stack_submit,
            git::stack::git_stack_get_trunks,
            git::stack::git_stack_set_trunks,
            fs::fs_list_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_rename,
            fs::fs_delete,
            fs::fs_find_repo_root,
            brain::brain_list_entries,
            brain::brain_read_entry,
            brain::brain_save_entry,
            secrets::secret_set,
            secrets::secret_delete,
            secrets::secret_status,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_set_rect,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_open_devtools,
            browser::browser_close_orphans,
            git::git_config_list,
            git::git_config_get,
            git::git_config_set,
            git::git_config_unset,
            fs::search::fs_search_files,
            fs::search::fs_search_cancel,
            fs::fs_stat_files,
            lsp::lsp_locate,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
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

    /// A sink holding `chunks`, marked truncated or not.
    fn sink_with(chunks: &[&[u8]], truncated: bool) -> PtySink {
        let mut sink = PtySink::new();
        for chunk in chunks {
            sink.scrollback.push_back(chunk.to_vec());
            sink.bytes += chunk.len();
        }
        sink.truncated = truncated;
        sink
    }

    #[test]
    fn untruncated_replay_is_the_chunks_verbatim() {
        let sink = sink_with(&[b"hello ", b"world"], false);
        assert_eq!(sink.build_replay(), b"hello world");
    }

    #[test]
    fn truncated_replay_carries_the_prologue_and_resyncs_the_head() {
        let sink = sink_with(&[b"\x1b[3junk\nkept", b" tail"], true);
        let replay = sink.build_replay();
        // Prologue first, then the head *after* its first newline, then the rest.
        let mut want = REPLAY_PROLOGUE.to_vec();
        want.extend_from_slice(b"kept tail");
        assert_eq!(replay, want);
    }

    #[test]
    fn empty_sink_replays_nothing() {
        assert!(PtySink::new().build_replay().is_empty());
    }

    /// The length a subscriber gates its input path on has to be the length of
    /// the buffer that is actually sent — including the prologue, and after the
    /// head has been resynced. Deriving it from `bytes` instead would be short
    /// by the prologue and long by the discarded head, and the input path would
    /// un-gate mid-replay.
    #[test]
    fn replay_length_accounts_for_prologue_and_resync() {
        let sink = sink_with(&[b"\x1b[3junk\nkept", b" tail"], true);
        let replay = sink.build_replay();
        assert_eq!(replay.len(), REPLAY_PROLOGUE.len() + b"kept tail".len());
        assert_ne!(replay.len(), sink.bytes, "must not be the raw retained count");
    }
}
