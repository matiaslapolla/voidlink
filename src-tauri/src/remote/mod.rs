//! Remote (SSH/SFTP) roots for the file explorer.
//!
//! The commands here are deliberately thin. Each one looks a session up by id
//! and forwards to [`session::RemoteSession`]; the protocol work, the host-key
//! policy and the shell quoting all live one layer down. That split is what
//! lets the interesting parts be tested without a Tauri app around them, and
//! it is the same shape `fs` and `git` already have.
//!
//! ## What a session is, and when it stops being one
//!
//! A session is one authenticated SSH connection plus its SFTP subsystem, held
//! in a `DashMap` keyed by an opaque id the frontend carries in every call. It
//! is *not* persisted: reconnecting after an app restart is a later slice, and
//! a stale id restored from disk would be a root that looks alive and answers
//! nothing.
//!
//! Death is detected rather than waited for. A supervisor task pings each
//! session on an interval and, on the first failure, removes it and emits
//! [`DISCONNECTED_EVENT`] with the id. The frontend marks that root dead and
//! offers a reconnect — the alternative (find out when a click fails) turns one
//! dropped Wi-Fi association into a stream of unexplained file errors.
//!
//! ## Why the remote surface mirrors `fs` rather than extending it
//!
//! `fs_list_dir` filters by gitignore, `fs_stat_files` feeds external-change
//! detection, `fs_search_files` walks a repo. None of those apply to a remote
//! root in this slice — no git decorations, no watching, no cross-file search —
//! so the remote command set is exactly the seven explorer operations and
//! nothing else. Sharing [`FsEntry`] is what keeps the tree from caring which
//! side an entry came from.

mod config;
mod session;

use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::fs::FsEntry;
use config::RemoteHost;
use session::RemoteSession;

/// Emitted with the dead session's id. Namespaced with `://` like the other
/// cross-window events the frontend listens for.
const DISCONNECTED_EVENT: &str = "remote://disconnected";

/// How often the supervisor asks a session whether it is still there. Matches
/// the transport keepalive in `session.rs`, so a session that has gone quiet is
/// noticed within roughly one interval either way.
const SUPERVISOR_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct RemoteState {
    sessions: Arc<DashMap<String, Arc<RemoteSession>>>,
}

/// What `remote_connect` hands back: the handle for every later call, and the
/// directory the tree should open at.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnection {
    pub session_id: String,
    pub home_dir: String,
    /// Echoed so the tree's chip can name the host without the caller having
    /// to thread the alias back through itself.
    pub alias: String,
}

/// Look a session up, or say plainly that it is gone. Every command starts
/// here, so a call that arrives after a disconnect fails with the one message
/// the UI knows how to turn into a reconnect prompt.
fn session_of(state: &RemoteState, session_id: &str) -> Result<Arc<RemoteSession>, String> {
    state
        .sessions
        .get(session_id)
        .map(|s| Arc::clone(s.value()))
        .ok_or_else(|| "This remote connection is no longer open".to_string())
}

#[tauri::command]
pub fn remote_hosts() -> Result<Vec<RemoteHost>, String> {
    let text = config::read_user_config()?;
    config::host_aliases(&mut text.as_bytes())
}

#[tauri::command]
pub async fn remote_connect(
    app: AppHandle,
    state: State<'_, RemoteState>,
    host: String,
) -> Result<RemoteConnection, String> {
    let text = config::read_user_config()?;
    let resolved = config::resolve(&mut text.as_bytes(), &host)?;

    let (sess, home_dir) = RemoteSession::connect(&resolved).await?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let sess = Arc::new(sess);
    state.sessions.insert(session_id.clone(), Arc::clone(&sess));

    supervise(app, Arc::clone(&state.sessions), session_id.clone());

    Ok(RemoteConnection {
        session_id,
        home_dir,
        alias: sess.alias.clone(),
    })
}

/// Watch one session and announce its death exactly once.
///
/// The task holds a weak-ish reference in practice — it re-reads the map every
/// tick rather than holding the `Arc` across the sleep — so an explicit
/// `remote_disconnect` ends it on the next wake without a second channel.
fn supervise(app: AppHandle, sessions: Arc<DashMap<String, Arc<RemoteSession>>>, id: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SUPERVISOR_INTERVAL).await;
            let Some(sess) = sessions.get(&id).map(|s| Arc::clone(s.value())) else {
                // Disconnected on purpose; nothing to report.
                return;
            };
            if sess.is_closed() || sess.ping().await.is_err() {
                sessions.remove(&id);
                let _ = app.emit(DISCONNECTED_EVENT, &id);
                return;
            }
        }
    });
}

#[tauri::command]
pub async fn remote_list_dir(
    state: State<'_, RemoteState>,
    session_id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    session_of(&state, &session_id)?.list_dir(&path).await
}

#[tauri::command]
pub async fn remote_read_file(
    state: State<'_, RemoteState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    session_of(&state, &session_id)?.read_file(&path).await
}

#[tauri::command]
pub async fn remote_create_file(
    state: State<'_, RemoteState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    session_of(&state, &session_id)?.create_file(&path).await
}

#[tauri::command]
pub async fn remote_create_dir(
    state: State<'_, RemoteState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    session_of(&state, &session_id)?.create_dir(&path).await
}

#[tauri::command]
pub async fn remote_rename(
    state: State<'_, RemoteState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    session_of(&state, &session_id)?.rename(&from, &to).await
}

#[tauri::command]
pub async fn remote_delete(
    state: State<'_, RemoteState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    session_of(&state, &session_id)?.delete(&path).await
}

#[tauri::command]
pub async fn remote_copy(
    state: State<'_, RemoteState>,
    session_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    session_of(&state, &session_id)?.copy(&from, &to).await
}

/// Close a session the user is done with. Idempotent: disconnecting a root
/// that already died is the same request as disconnecting a live one, and both
/// should end with the id gone.
#[tauri::command]
pub async fn remote_disconnect(
    state: State<'_, RemoteState>,
    session_id: String,
) -> Result<(), String> {
    if let Some((_, sess)) = state.sessions.remove(&session_id) {
        sess.disconnect().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only interesting branch of the registry: a call whose session is
    /// gone must fail with the message the UI turns into a reconnect prompt,
    /// rather than panicking or reporting an empty directory.
    #[test]
    fn missing_session_reports_a_closed_connection() {
        let state = RemoteState::default();
        let Err(err) = session_of(&state, "nope") else {
            panic!("a session that was never opened must not resolve");
        };
        assert!(err.contains("no longer open"), "{err}");
    }
}

/// Live integration tests against a real host.
///
/// Gated on `VOIDLINK_SSH_TEST_HOST` because everything below needs an SSH
/// server, an agent that can authenticate to it, and a writable `/tmp` — none
/// of which CI has. Unset, the whole module is a no-op, which is why each test
/// returns early rather than being `#[ignore]`d: an ignored test is invisible,
/// a skipped one prints.
#[cfg(test)]
mod live_tests {
    use super::*;

    fn test_host() -> Option<String> {
        std::env::var("VOIDLINK_SSH_TEST_HOST").ok()
    }

    async fn connect() -> Option<(RemoteSession, String)> {
        let alias = test_host()?;
        let text = config::read_user_config().expect("read ssh config");
        let resolved = config::resolve(&mut text.as_bytes(), &alias).expect("resolve alias");
        Some(
            RemoteSession::connect(&resolved)
                .await
                .expect("connect to the test host"),
        )
    }

    /// One pass over the whole explorer surface, in the order the UI drives it:
    /// connect, make a scratch dir, create, list, read, copy, rename, delete.
    /// Written as one test because each step's fixture is the previous step's
    /// output, and splitting it would mean seven connections to the same box.
    #[tokio::test]
    async fn explorer_operations_round_trip_against_a_real_host() {
        let Some((sess, home)) = connect().await else {
            eprintln!("skipped: VOIDLINK_SSH_TEST_HOST is unset");
            return;
        };
        assert!(home.starts_with('/'), "home should be absolute: {home}");

        let root = format!("/tmp/voidlink-remote-test-{}", uuid::Uuid::new_v4());
        sess.create_dir(&root).await.expect("create scratch dir");

        // create + read
        let file = format!("{root}/hello.txt");
        sess.create_file(&file).await.expect("create file");
        assert_eq!(sess.read_file(&file).await.expect("read file"), "");

        // list
        let entries = sess.list_dir(&root).await.expect("list scratch dir");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "hello.txt");
        assert!(!entries[0].is_dir);
        assert!(!entries[0].ignored);

        // copy — a directory, so this exercises the recursive path
        let nested = format!("{root}/nested");
        sess.create_dir(&nested).await.expect("create nested dir");
        sess.create_file(&format!("{nested}/inner.txt"))
            .await
            .expect("create nested file");
        let copied = format!("{root}/nested-copy");
        sess.copy(&nested, &copied).await.expect("recursive copy");
        let copied_entries = sess.list_dir(&copied).await.expect("list the copy");
        assert_eq!(copied_entries.len(), 1);
        assert_eq!(copied_entries[0].name, "inner.txt");

        // rename
        let renamed = format!("{root}/renamed.txt");
        sess.rename(&file, &renamed).await.expect("rename");
        let after = sess.list_dir(&root).await.expect("list after rename");
        assert!(after.iter().any(|e| e.name == "renamed.txt"));
        assert!(!after.iter().any(|e| e.name == "hello.txt"));

        // delete: a file, then the whole tree
        sess.delete(&renamed).await.expect("delete file");
        sess.delete(&root).await.expect("delete tree");
        assert!(
            sess.list_dir(&root).await.is_err(),
            "the scratch dir should be gone"
        );

        sess.disconnect().await;
    }

    /// A path a shell would otherwise interpret has to survive `cp -a` and
    /// `rm -rf` intact. This is the test that would catch quoting regressing.
    #[tokio::test]
    async fn hostile_path_names_survive_copy_and_delete() {
        let Some((sess, _)) = connect().await else {
            eprintln!("skipped: VOIDLINK_SSH_TEST_HOST is unset");
            return;
        };
        let root = format!("/tmp/voidlink-remote-quote-{}", uuid::Uuid::new_v4());
        sess.create_dir(&root).await.expect("create scratch dir");

        let hostile = format!("{root}/a b; echo pwned");
        sess.create_dir(&hostile).await.expect("create hostile dir");
        let copy = format!("{root}/copy of a b");
        sess.copy(&hostile, &copy).await.expect("copy hostile dir");

        let names: Vec<String> = sess
            .list_dir(&root)
            .await
            .expect("list")
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert!(names.contains(&"a b; echo pwned".to_string()), "{names:?}");
        assert!(names.contains(&"copy of a b".to_string()), "{names:?}");

        sess.delete(&root).await.expect("delete tree");
        sess.disconnect().await;
    }
}
