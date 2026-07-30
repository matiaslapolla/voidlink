//! Streaming, cancellable BYO-CLI agent turns.
//!
//! **Why this is not in `git/`.** The one-shot agent query lives in
//! `git/agent.rs` and is registered through `blocking_git!`, which serialises
//! it against every other operation on the same repository. That is right for
//! anything touching the object store and badly wrong for an agent turn: a
//! model that thinks for forty seconds would hold the per-repo lock for forty
//! seconds, freezing the status poll, the diff viewer, and every stage click in
//! that worktree. A turn only ever *reads* a prompt the frontend already
//! assembled and pipes it to a user-owned process — it needs no git lock at
//! all. Putting it in a top-level module keeps it out of the `blocking_git!`
//! neighbourhood, where the next person adding a command would reasonably
//! assume the macro is mandatory and reintroduce the stall.
//!
//! **Trust model is unchanged.** No embedded model, no telemetry: the same
//! BYO-CLI contract as AI commit drafting, spawned by the same
//! [`crate::git::cli::build_cli_command`] so the login-shell PATH fix and the
//! keychain injection rules have exactly one implementation.
//!
//! **Threads, not the async runtime.** Three pipes, three threads, matching
//! `lsp`: one writing the prompt to stdin, one draining stdout, one draining
//! stderr. Writing the prompt inline would deadlock the moment a prompt
//! exceeds the pipe buffer (~64 KiB, and a workspace-grounded prompt clears
//! that easily) because nobody would be reading stdout yet.

use std::io::{Read, Write};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use dashmap::mapref::entry::Entry;
use dashmap::DashMap;
use tauri::ipc::Channel;

use crate::git::cli::{build_cli_command, spawn_error, BuiltCli};
use crate::secrets::SecretBinding;

/// Read size for the child's pipes. Large enough that a chatty CLI does not
/// cost one IPC message per token, small enough that the first words of an
/// answer reach the UI as soon as the CLI flushes them.
const READ_CHUNK: usize = 8 * 1024;

/// How much stderr is retained for the failure message. A CLI that dies on
/// startup says why in its first lines; one that logs progress to stderr can
/// produce megabytes, and none of it belongs in an error string. The retained
/// window is the *tail*, because the fatal line is the last one.
const STDERR_KEEP_BYTES: usize = 8 * 1024;

/// Grace period between the polite group `SIGTERM` and the unconditional
/// group `SIGKILL`. Long enough for a CLI to flush and exit on its own, short
/// enough that a user who clicked Stop does not sit watching a spinner.
#[cfg(unix)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// One event in a turn's output stream.
///
/// stdout and stderr are separate variants rather than one interleaved text
/// stream because several popular CLIs narrate progress on stderr; folding
/// that into the answer body would corrupt the very thing the user is reading.
/// The frontend renders the answer from `chunk` and keeps `stderr` for the
/// details disclosure.
#[derive(Clone, serde::Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event",
    content = "data"
)]
pub enum AgentStreamEvent {
    /// A chunk of the CLI's stdout, in arrival order.
    Chunk { text: String },
    /// A chunk of the CLI's stderr. Surfaced separately so a CLI that logs
    /// progress to stderr doesn't corrupt the answer body.
    Stderr { text: String },
}

/// How a turn ended.
///
/// Note there is no error variant: a turn that failed resolves the command's
/// `Result` as `Err`, and a turn the user stopped is a *success* with
/// `cancelled: true`. Cancellation is a normal outcome — the partial answer
/// already streamed is worth keeping, and the non-zero exit status the kill
/// produced is an artefact of the kill, not a fault to report.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnResult {
    /// True when the turn was killed by `agent_cancel_turn`.
    pub cancelled: bool,
    pub exit_code: Option<i32>,
}

/// A turn in flight.
///
/// Everything is behind an `Arc` so the registry, the running command, and the
/// cancel command all look at the same state. `Clone` is what lets
/// `agent_cancel_turn` take a snapshot and drop its `DashMap` reference before
/// signalling — holding a map reference across a kill is how the `lsp` module
/// once deadlocked itself.
#[derive(Clone, Default)]
struct Turn {
    /// Set by `agent_cancel_turn` *before* the kill, so the waiting thread can
    /// tell "the user stopped this" from "the CLI crashed" no matter which
    /// order the two observations land in.
    cancelled: Arc<AtomicBool>,
    /// Process-group id of the child, or 0 before it is spawned. On unix
    /// `process_group(0)` makes the child a group leader, so this is also its
    /// pid. Kept out of the child mutex so a cancel never has to contend with
    /// the thread that is about to `wait()`.
    #[cfg(unix)]
    pgid: Arc<std::sync::atomic::AtomicI32>,
    /// The child handle, `None` until spawn. Owned by the registry entry so
    /// the non-unix kill path and the reaping `wait()` share one handle
    /// instead of racing two.
    child: Arc<Mutex<Option<Child>>>,
}

/// Turns in flight, keyed by the frontend-minted turn id.
///
/// A module-level `OnceLock` rather than Tauri managed state, matching `lsp`
/// and `fs::search`: it keeps the `lib.rs` diff to the two appended command
/// lines, where every branch is already fighting over registration order.
fn turns() -> &'static DashMap<String, Turn> {
    static TURNS: OnceLock<DashMap<String, Turn>> = OnceLock::new();
    TURNS.get_or_init(DashMap::new)
}

/// Removes a turn's registry entry when the turn ends, whichever way it ends.
///
/// A `Drop` guard rather than removals at each `return`, because "success,
/// spawn failure, non-zero exit, cancel, or a panic in between" is five exits
/// and the one that gets forgotten is the one that leaves `agent_cancel_turn`
/// able to signal a pid that the OS has since handed to somebody else.
struct TurnGuard(String);

impl Drop for TurnGuard {
    fn drop(&mut self) {
        turns().remove(&self.0);
    }
}

/// Pull every complete UTF-8 character out of `pending`, leaving a partial
/// trailing sequence behind for the next read.
///
/// `String::from_utf8_lossy` per chunk is wrong here: pipe reads split
/// wherever the kernel felt like it, so a 3-byte `…` or a 4-byte emoji
/// routinely straddles two chunks, and lossy decoding would replace both
/// halves with `�` — visible corruption in the middle of an answer.
/// Genuinely invalid bytes (not merely incomplete) still collapse to one `�`
/// and decoding continues, matching what lossy would have done.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                return out;
            }
            Err(e) => {
                let good = e.valid_up_to();
                // The prefix was just validated, so this cannot fail.
                out.push_str(std::str::from_utf8(&pending[..good]).unwrap_or_default());
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..good + bad);
                    }
                    // Incomplete tail: hold it, the rest is on the way.
                    None => {
                        pending.drain(..good);
                        return out;
                    }
                }
            }
        }
    }
}

/// Drain `pipe` to end-of-file, handing each decoded chunk to `emit`.
///
/// Reads are forwarded the moment they arrive — no accumulate-then-send —
/// because incremental delivery is the entire reason this command exists.
fn pump<R: Read>(pipe: R, mut emit: impl FnMut(String)) {
    let mut pipe = pipe;
    let mut buf = [0u8; READ_CHUNK];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        let read = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&buf[..read]);
        let text = take_utf8(&mut pending);
        if !text.is_empty() {
            emit(text);
        }
    }
    // Bytes still held at EOF are a truncated character — the CLI died
    // mid-sequence. Emit the replacement rather than swallowing them, so the
    // answer's length still reflects what was received.
    if !pending.is_empty() {
        emit('\u{FFFD}'.to_string());
    }
}

/// Signal the whole process group, escalating to `SIGKILL` if the group is
/// still registered after [`KILL_GRACE`].
///
/// **Why the group and not the child.** On unix the spawned child is
/// `$SHELL -lc '<argv>'` (the login-shell PATH fix in
/// [`crate::git::cli::build_cli_command`]), so the CLI the user cares about is
/// a *grandchild*. Killing the shell alone leaves that CLI running, reparented
/// to init, still holding its API connection — an orphan that outlives the app
/// and keeps billing. `process_group(0)` at spawn makes the shell a group
/// leader whose pgid equals its pid, so a single `kill(-pgid)` reaches the
/// shell and everything it started. `libc` is already a unix dependency of
/// this crate, so this costs nothing; the `Child::kill` fallback below exists
/// only for the window before the pid is known and for non-unix.
#[cfg(unix)]
fn kill_turn(turn_id: &str, turn: &Turn) {
    let pgid = turn.pgid.load(Ordering::SeqCst);
    if pgid <= 0 {
        // Not spawned yet. The `cancelled` flag is already set, and the
        // spawning thread re-checks it immediately after spawn, so the kill is
        // not lost — it just happens there instead.
        return;
    }
    // SAFETY: `kill` is async-signal-safe and cannot violate memory safety.
    // A negative pid targets the process group; failure (ESRCH — everything
    // already exited) is the outcome we wanted anyway.
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }

    let turn_id = turn_id.to_string();
    let turn = turn.clone();
    let _ = std::thread::Builder::new()
        .name(format!("agent-kill-{turn_id}"))
        .spawn(move || {
            std::thread::sleep(KILL_GRACE);
            // Only escalate while *this* turn is still the registered one.
            // Comparing the `Arc` identity, not just the id, means a turn that
            // finished and had its id reused cannot be shot by a stale timer.
            let still_live = turns()
                .get(&turn_id)
                .is_some_and(|entry| Arc::ptr_eq(&entry.cancelled, &turn.cancelled));
            if !still_live {
                return;
            }
            let pgid = turn.pgid.load(Ordering::SeqCst);
            if pgid > 0 {
                // SAFETY: as above.
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            }
        });
}

/// Kill the child directly. Windows has no process groups in the POSIX sense
/// and no login-shell wrapper either, so the child *is* the CLI.
#[cfg(not(unix))]
fn kill_turn(_turn_id: &str, turn: &Turn) {
    let mut slot = turn
        .child
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if let Some(child) = slot.as_mut() {
        let _ = child.kill();
    }
}

/// Spawn the CLI, stream it, and reap it. Runs on a blocking thread.
fn run_turn(
    repo_path: &str,
    command_template: &str,
    prompt: &str,
    secret_bindings: &[SecretBinding],
    turn_id: &str,
    turn: &Turn,
    on_event: &Channel<AgentStreamEvent>,
) -> Result<AgentTurnResult, String> {
    let BuiltCli { mut cmd, argv } =
        build_cli_command(repo_path, command_template, secret_bindings)?;

    #[cfg(unix)]
    {
        // Its own group, so cancel can reach the CLI behind the login shell.
        // See `kill_turn`. Stable since 1.64 and needs no new dependency.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| spawn_error(&argv[0], e))?;

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    #[cfg(unix)]
    // Group leader, so pgid == pid. Published before the handle is stored so a
    // cancel racing the spawn has something to signal.
    turn.pgid
        .store(child.id() as i32, Ordering::SeqCst);

    *turn.child.lock().unwrap_or_else(PoisonError::into_inner) = Some(child);

    // A cancel that arrived between reserving the id and here saw pgid 0 and
    // deliberately did nothing. Honour it now.
    if turn.cancelled.load(Ordering::SeqCst) {
        kill_turn(turn_id, turn);
    }

    // ── Prompt writer. Detached, never joined. ──────────────────────────────
    // A CLI that exits without reading its stdin leaves this thread blocked in
    // `write_all` until the pipe breaks; joining it would make such a CLI hang
    // the turn. Dropping the handle sends EOF, which is what tells the CLI the
    // prompt is complete.
    if let Some(mut stdin) = stdin {
        let prompt = prompt.to_string();
        let _ = std::thread::Builder::new()
            .name(format!("agent-in-{turn_id}"))
            .spawn(move || {
                let _ = stdin.write_all(prompt.as_bytes());
                let _ = stdin.flush();
                drop(stdin);
            });
    }

    // ── stderr. Streamed *and* retained for the failure message. ────────────
    let kept_stderr = Arc::new(Mutex::new(String::new()));
    let stderr_thread = stderr.map(|pipe| {
        let channel = on_event.clone();
        let kept = kept_stderr.clone();
        std::thread::Builder::new()
            .name(format!("agent-err-{turn_id}"))
            .spawn(move || {
                pump(pipe, |text| {
                    if let Ok(mut kept) = kept.lock() {
                        kept.push_str(&text);
                        if kept.len() > STDERR_KEEP_BYTES {
                            // Keep the tail: the fatal line is the last one.
                            // Cut on a character boundary, not a byte one.
                            let cut = kept.len() - STDERR_KEEP_BYTES;
                            let cut = (cut..kept.len())
                                .find(|i| kept.is_char_boundary(*i))
                                .unwrap_or(kept.len());
                            *kept = kept[cut..].to_string();
                        }
                    }
                    // A send failure means the webview is gone; the pump keeps
                    // draining so the child still reaches EOF and can exit.
                    let _ = channel.send(AgentStreamEvent::Stderr { text });
                });
            })
    });

    // ── stdout. The answer. ─────────────────────────────────────────────────
    if let Some(pipe) = stdout {
        let channel = on_event.clone();
        pump(pipe, |text| {
            let _ = channel.send(AgentStreamEvent::Chunk { text });
        });
    }

    // stdout is at EOF; stderr may still have a line or two to flush, and the
    // failure message below needs all of it.
    if let Some(Ok(handle)) = stderr_thread {
        let _ = handle.join();
    }

    let status = {
        let mut slot = turn.child.lock().unwrap_or_else(PoisonError::into_inner);
        match slot.as_mut() {
            Some(child) => child.wait().map_err(|e| format!("AI command failed: {e}"))?,
            None => return Err("AI command failed: the child handle was lost.".to_string()),
        }
    };
    let exit_code = status.code();

    // Checked after the wait, so a cancel that landed while the child was
    // shutting down still reads as a cancel.
    if turn.cancelled.load(Ordering::SeqCst) {
        return Ok(AgentTurnResult {
            cancelled: true,
            exit_code,
        });
    }

    if !status.success() {
        let stderr = kept_stderr.lock().unwrap_or_else(PoisonError::into_inner);
        return Err(format!(
            "AI command exited with {}: {}",
            status,
            stderr.trim()
        ));
    }

    Ok(AgentTurnResult {
        cancelled: false,
        exit_code,
    })
}

/// Run one agent turn, streaming its output to `on_event` as it arrives.
///
/// Deliberately takes no `GitState` and therefore no per-repo git lock: a turn
/// can run for a minute and the rest of the repository stays fully usable
/// while it does. `repo_path` is only the child's working directory.
///
/// `turn_id` is minted by the caller and is the handle `agent_cancel_turn`
/// needs. Reusing an id that is already running is an error rather than a
/// silent replace — two children on one id would interleave their answers into
/// the same bubble and only one of them could be cancelled.
///
/// Empty output is *not* an error here, unlike the one-shot path: a turn the
/// user stopped after zero tokens is a legitimate empty result, and the
/// frontend already has the stream to judge by.
#[tauri::command]
pub async fn agent_stream_query(
    repo_path: String,
    command_template: String,
    prompt: String,
    secret_bindings: Vec<SecretBinding>,
    turn_id: String,
    on_event: Channel<AgentStreamEvent>,
) -> Result<AgentTurnResult, String> {
    if prompt.trim().is_empty() {
        return Err("Empty prompt.".to_string());
    }

    // Reserve the id before any blocking work, atomically against a second
    // call for the same id: a `contains_key` check followed by an insert would
    // let two turns through when the frontend double-fires a send.
    let turn = Turn::default();
    match turns().entry(turn_id.clone()) {
        Entry::Occupied(_) => return Err("A turn with this id is already running.".to_string()),
        Entry::Vacant(slot) => {
            slot.insert(turn.clone());
        }
    }
    let guard = TurnGuard(turn_id.clone());

    tauri::async_runtime::spawn_blocking(move || {
        // Moved in so the entry is released when the turn ends by *any* path,
        // including a panic inside the body.
        let _guard = guard;
        run_turn(
            &repo_path,
            &command_template,
            &prompt,
            &secret_bindings,
            &turn_id,
            &turn,
            &on_event,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Kill the child process for `turn_id`. Returns true when a live turn was
/// found and killed, false when there was nothing to cancel.
///
/// An unknown id is `Ok(false)` and not an error: the turn may have finished
/// between the user's click and this call, and that race is the normal case,
/// not a fault. The turn's own future resolves with `cancelled: true` — this
/// command does not wait for it.
#[tauri::command]
pub async fn agent_cancel_turn(turn_id: String) -> Result<bool, String> {
    // Snapshot and drop the map reference in one statement: `kill_turn` reads
    // the registry (to decide about escalation) and the reaping thread writes
    // it, so holding a reference across the call risks a deadlock.
    let Some(turn) = turns().get(&turn_id).map(|entry| entry.clone()) else {
        return Ok(false);
    };
    // Set first, kill second. The waiting thread may observe the exit before
    // this function returns, and it must find the flag already true or it will
    // report the kill as a CLI failure.
    turn.cancelled.store(true, Ordering::SeqCst);
    kill_turn(&turn_id, &turn);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// A channel that throws events away. Most tests care about the process
    /// lifecycle, not the bytes.
    fn null_channel() -> Channel<AgentStreamEvent> {
        Channel::new(|_| Ok(()))
    }

    /// A channel that records the raw JSON bodies it was handed, so a test can
    /// assert on the wire shape the frontend will actually parse.
    #[cfg(unix)]
    fn recording_channel() -> (Channel<AgentStreamEvent>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        });
        (channel, seen)
    }

    fn temp_repo() -> String {
        std::env::temp_dir().to_string_lossy().to_string()
    }

    /// Poll until `predicate` holds or the deadline passes. Polling beats a
    /// fixed sleep for the same reason it always does: the fast machine does
    /// not wait and the loaded CI machine does not flake.
    #[cfg(unix)]
    fn wait_until(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn one_shot_and_streaming_build_the_same_command() {
        // Both `run_cli` and `run_turn` spawn exactly what `build_cli_command`
        // returns, so agreement between two calls is agreement between the two
        // paths — which is the property the refactor exists to guarantee. The
        // day someone re-implements the login shell in one of them, the two
        // programs stop matching.
        let repo = temp_repo();
        let template = "echo 'hello world'";
        let a = build_cli_command(&repo, template, &[]).expect("one-shot build");
        let b = build_cli_command(&repo, template, &[]).expect("streaming build");

        assert_eq!(a.cmd.get_program(), b.cmd.get_program());
        assert_eq!(
            a.cmd.get_args().collect::<Vec<_>>(),
            b.cmd.get_args().collect::<Vec<_>>()
        );
        assert_eq!(
            a.cmd.get_envs().collect::<Vec<_>>(),
            b.cmd.get_envs().collect::<Vec<_>>()
        );
        assert_eq!(a.cmd.get_current_dir(), b.cmd.get_current_dir());
        // argv is the template's, not the shell wrapper's — error messages
        // depend on that.
        assert_eq!(a.argv, vec!["echo".to_string(), "hello world".to_string()]);
        assert_eq!(a.argv, b.argv);
    }

    #[test]
    fn an_empty_template_is_rejected_before_spawning() {
        let err = build_cli_command(&temp_repo(), "   ", &[])
            .err()
            .expect("an empty template must be rejected");
        assert_eq!(err, "No AI command configured.");
    }

    #[test]
    fn a_blank_prompt_is_rejected() {
        let result = tauri::async_runtime::block_on(agent_stream_query(
            temp_repo(),
            "cat".to_string(),
            "  \n ".to_string(),
            Vec::new(),
            "blank-prompt-turn".to_string(),
            null_channel(),
        ));
        assert_eq!(result.err().as_deref(), Some("Empty prompt."));
        // The rejection happens before the id is reserved, so nothing leaks.
        assert!(turns().get("blank-prompt-turn").is_none());
    }

    #[test]
    fn cancelling_an_unknown_turn_reports_false() {
        let found = tauri::async_runtime::block_on(agent_cancel_turn(
            "no-such-turn-at-all".to_string(),
        ))
        .expect("must not error");
        assert!(!found);
    }

    #[cfg(unix)]
    #[test]
    fn a_completed_turn_streams_its_output_and_clears_the_registry() {
        let (channel, seen) = recording_channel();
        let result = tauri::async_runtime::block_on(agent_stream_query(
            temp_repo(),
            // `cat` echoes the piped prompt, which also proves stdin reached
            // the child and was closed.
            "cat".to_string(),
            "héllo".to_string(),
            Vec::new(),
            "echo-turn".to_string(),
            channel,
        ))
        .expect("turn must succeed");

        assert!(!result.cancelled);
        assert_eq!(result.exit_code, Some(0));
        assert!(turns().get("echo-turn").is_none());

        let bodies = seen.lock().unwrap();
        let text: String = bodies
            .iter()
            .map(|json| {
                let value: serde_json::Value = serde_json::from_str(json).unwrap();
                assert_eq!(value["event"], "chunk");
                value["data"]["text"].as_str().unwrap().to_string()
            })
            .collect();
        assert_eq!(text, "héllo");
    }

    #[cfg(unix)]
    #[test]
    fn a_duplicate_turn_id_is_rejected() {
        let id = "duplicate-turn";
        let first = std::thread::spawn(move || {
            tauri::async_runtime::block_on(agent_stream_query(
                temp_repo(),
                "sleep 30".to_string(),
                "prompt".to_string(),
                Vec::new(),
                id.to_string(),
                null_channel(),
            ))
        });
        assert!(
            wait_until(|| turns().get(id).is_some()),
            "the first turn never registered"
        );

        let second = tauri::async_runtime::block_on(agent_stream_query(
            temp_repo(),
            "sleep 30".to_string(),
            "prompt".to_string(),
            Vec::new(),
            id.to_string(),
            null_channel(),
        ));
        assert_eq!(
            second.err().as_deref(),
            Some("A turn with this id is already running.")
        );

        assert!(tauri::async_runtime::block_on(agent_cancel_turn(id.to_string())).unwrap());
        assert!(first.join().unwrap().unwrap().cancelled);
    }

    #[cfg(unix)]
    #[test]
    fn cancelling_a_turn_reaps_the_child_and_leaves_no_orphan() {
        let id = "cancel-turn";
        let running = std::thread::spawn(move || {
            tauri::async_runtime::block_on(agent_stream_query(
                temp_repo(),
                // Under the login-shell wrapper this is `$SHELL -lc 'sleep' '30'`,
                // so the sleep is a grandchild — exactly the orphan case.
                "sleep 30".to_string(),
                "prompt".to_string(),
                Vec::new(),
                id.to_string(),
                null_channel(),
            ))
        });

        // Wait for the pid to be published, not merely for the entry: cancel
        // before spawn is a different code path and not what this test covers.
        let mut pgid = 0;
        assert!(
            wait_until(|| {
                pgid = turns()
                    .get(id)
                    .map(|entry| entry.pgid.load(Ordering::SeqCst))
                    .unwrap_or(0);
                pgid > 0
            }),
            "the turn never published a pid"
        );

        assert!(tauri::async_runtime::block_on(agent_cancel_turn(id.to_string())).unwrap());

        let result = running.join().unwrap().expect("a cancel is not an error");
        assert!(result.cancelled, "a killed turn must report cancelled");
        assert!(turns().get(id).is_none(), "the registry entry must be gone");

        // The child was reaped by the turn's own `wait()`, and no member of its
        // process group survived the kill — `kill(0)` on the group is how `ps`
        // would answer the same question, without shelling out.
        let alive = unsafe { libc::kill(-pgid, 0) } == 0;
        assert!(!alive, "process group {pgid} still has a live member");
    }

    #[test]
    fn utf8_decoding_holds_back_a_split_character() {
        // "é" is 0xC3 0xA9. Split across two reads, lossy decoding would emit
        // "�" twice; the incremental decoder must emit nothing then "é".
        let mut pending = vec![0xC3];
        assert_eq!(take_utf8(&mut pending), "");
        pending.push(0xA9);
        assert_eq!(take_utf8(&mut pending), "é");
        assert!(pending.is_empty());
    }

    #[test]
    fn utf8_decoding_replaces_genuinely_invalid_bytes_and_continues() {
        let mut pending = b"ok\xFFmore".to_vec();
        assert_eq!(take_utf8(&mut pending), "ok\u{FFFD}more");
        assert!(pending.is_empty());
    }
}
