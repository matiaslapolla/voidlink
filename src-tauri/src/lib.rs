use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use dashmap::DashMap;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tauri::ipc::{Channel, InvokeResponseBody};

mod browser;
mod git;
mod fs;
mod brain;
mod menu;
mod secrets;
mod window;

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

/// The OS the app is running on: `"macos"`, `"windows"`, `"linux"`, …
///
/// The frontend needs this to decide between the native macOS window chrome
/// and the custom title bar we draw everywhere else. Resolved from the build
/// target rather than the user agent, so it can never be spoofed or drift.
#[tauri::command]
fn get_platform_os() -> &'static str {
    std::env::consts::OS
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
        let busy = shell_pid.map_or(false, |s| s != pid);
        return Ok(PtyProcessInfo {
            pid: Some(pid),
            name: proc_info::name(pid),
            cwd: proc_info::cwd(pid),
            busy,
        });
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

            // The git window is created on demand by `open_git_window`, not
            // here — opening it at startup would put a second window in front
            // of the workbench on every launch.

            Ok(())
        })
        .on_window_event(move |window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // Only the main window owns the terminals. Without this label
                // check, closing the git window would kill every PTY in the
                // workbench that is still open behind it.
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
            window::focus_main_window,
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
