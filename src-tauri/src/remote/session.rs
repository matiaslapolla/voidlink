//! One live SSH connection and the file operations it can serve.
//!
//! Everything here is *below* the command layer: no `tauri::command`, no
//! session registry, no events. `mod.rs` owns those. What this file owns is the
//! two-protocol split that makes remote browsing work at all —
//!
//! - **SFTP** for everything that is one round trip over a path: list, read,
//!   mkdir, touch, rename, unlink. `russh-sftp` speaks version 3, which is what
//!   OpenSSH's `sftp-server` offers, and the subsystem is opened once per
//!   session and reused.
//! - **A command channel** for the two operations SFTP has no verb for:
//!   recursive copy and recursive delete. Version 3 has no `cp` and no `rm -r`;
//!   doing them over SFTP means walking the tree from the client, one round
//!   trip per entry, and reimplementing permission/mtime preservation by hand.
//!   `cp -a` and `rm -rf` already exist on the far side and run there, at
//!   local-disk speed. The price is that both take a *shell*, which is why
//!   every path they see goes through [`shell_escape::unix::escape`] — a
//!   directory called `; rm -rf ~` is a legal directory name, and string
//!   concatenation would make it a command.
//!
//! Authentication is ssh-agent only, deliberately: no password prompt, no
//! passphrase UI, no key file picked out of the config. If the agent cannot
//! sign for the host, the answer is to fix the agent, not to grow a second
//! credential path through the app.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle};
use russh::keys::PublicKey;
use russh::keys::agent::AgentIdentity;
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileType;

use crate::fs::FsEntry;
use crate::remote::config::ResolvedHost;

/// What the user is told to do about a host key we will not accept. Spelled
/// once because both rejection paths (never seen, seen and different) end in
/// the same instruction, and it is the *only* action that resolves either.
const TRUST_HINT: &str = "connect once from a terminal to trust this host";

/// A protocol-level ping every 30s, dropped after 3 unanswered. Without it a
/// session that died with the laptop lid stays "connected" in the tree until
/// the user clicks something, and the failure then reads as a broken file
/// operation rather than a lost connection.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVE_MAX: usize = 3;

/// Same 2 MB ceiling `fs_read_file` applies locally — with the extra force
/// that here the bytes cross a network before anything can decide they were
/// too many.
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;

/// Verifies the server's key against `known_hosts` and records *why* it said
/// no, which is the part russh's own error cannot carry.
///
/// `check_server_key` can only answer yes/no; a bare "no" surfaces as
/// `UnknownKey`, which tells the user nothing about which fingerprint was
/// offered or what to do next. So the handler writes its reason into shared
/// state and [`RemoteSession::connect`] prefers that over russh's error text.
struct HostKeyHandler {
    host: String,
    port: u16,
    known_hosts: Option<PathBuf>,
    rejection: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = key.fingerprint(Default::default());
        let Some(path) = self.known_hosts.clone() else {
            *self.rejection.lock().unwrap() = Some(format!(
                "No ~/.ssh/known_hosts to check {fingerprint} against — {TRUST_HINT}"
            ));
            return Ok(false);
        };
        match russh::keys::check_known_hosts_path(&self.host, self.port, key, &path) {
            Ok(true) => Ok(true),
            Ok(false) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "Unknown host key for {} ({fingerprint}) — {TRUST_HINT}",
                    self.host
                ));
                Ok(false)
            }
            // A *changed* key is the case worth spelling out separately: it is
            // either a rebuilt machine or the attack known_hosts exists to
            // catch, and the two are indistinguishable from here.
            Err(russh::keys::Error::KeyChanged { line }) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "Host key for {} CHANGED ({fingerprint}); ~/.ssh/known_hosts line {line} says \
                     otherwise. If the machine was genuinely rebuilt, remove that line and \
                     {TRUST_HINT}",
                    self.host
                ));
                Ok(false)
            }
            Err(e) => {
                *self.rejection.lock().unwrap() = Some(format!(
                    "Could not check {} against known_hosts: {e}",
                    self.host
                ));
                Ok(false)
            }
        }
    }
}

pub struct RemoteSession {
    /// The alias as the user picked it, for messages and the tree's chip.
    pub alias: String,
    handle: Handle<HostKeyHandler>,
    sftp: SftpSession,
}

/// Quote one path for the remote *shell*. Always the unix rules, never the
/// host platform's: the far side is an OpenSSH server running a POSIX shell
/// regardless of what this app is compiled for.
fn quote(path: &str) -> Cow<'_, str> {
    shell_escape::unix::escape(Cow::Borrowed(path))
}

impl RemoteSession {
    /// Open a session and its SFTP subsystem, and report the login directory.
    ///
    /// The home directory comes from `canonicalize(".")` rather than from
    /// `/home/<user>`: the SFTP server's start directory *is* the login
    /// directory, and guessing its path gets `/root`, `/Users`, and every
    /// non-standard layout wrong.
    pub async fn connect(host: &ResolvedHost) -> Result<(Self, String), String> {
        if let Some(jump) = &host.proxy_jump {
            return Err(format!(
                "{} needs ProxyJump ({jump}), which is not supported yet",
                host.alias
            ));
        }

        let config = Arc::new(client::Config {
            keepalive_interval: Some(KEEPALIVE_INTERVAL),
            keepalive_max: KEEPALIVE_MAX,
            ..Default::default()
        });

        let rejection = Arc::new(Mutex::new(None));
        let handler = HostKeyHandler {
            host: host.hostname.clone(),
            port: host.port,
            known_hosts: super::config::known_hosts_path(),
            rejection: Arc::clone(&rejection),
        };

        let mut handle = client::connect(config, (host.hostname.as_str(), host.port), handler)
            .await
            .map_err(|e| {
                // The handler's reason, when it has one, is the real story;
                // russh's own error is the symptom.
                rejection
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| format!("Could not connect to {}: {e}", host.alias))
            })?;

        authenticate_with_agent(&mut handle, &host.user).await?;

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Could not open a session channel: {e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("Remote host refused the sftp subsystem: {e}"))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("Could not start sftp: {e}"))?;

        let home = sftp
            .canonicalize(".")
            .await
            .map_err(|e| format!("Could not resolve the home directory: {e}"))?;

        Ok((
            Self {
                alias: host.alias.clone(),
                handle,
                sftp,
            },
            home,
        ))
    }

    /// Whether the transport is still up. Read by the supervisor rather than
    /// by commands — a command finds out by failing, which is more accurate.
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// A protocol ping. The supervisor's liveness probe.
    pub async fn ping(&self) -> Result<(), String> {
        self.handle
            .send_keepalive(true)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn list_dir(&self, path: &str) -> Result<Vec<FsEntry>, String> {
        let dir = self
            .sftp
            .read_dir(path)
            .await
            .map_err(|e| format!("Could not list {path}: {e}"))?;

        let base = path.trim_end_matches('/');
        let mut entries = Vec::new();
        let mut symlinks = Vec::new();
        for entry in dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let full = format!("{base}/{name}");
            let is_dir = entry.file_type().is_dir();
            // A symlink's own attributes say "symlink", not "directory", so a
            // link to a directory would render as an unopenable file. Only
            // links pay the extra stat — resolving every entry would be one
            // round trip per row.
            if matches!(entry.file_type(), FileType::Symlink) {
                symlinks.push(entries.len());
            }
            entries.push(FsEntry {
                name,
                path: full,
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified: meta.mtime.map(|t| t as i64),
                // Remote roots carry no git decorations at all (see the
                // frontend's provider), so nothing is ever "only visible
                // because ignores are off".
                ignored: false,
            });
        }

        for idx in symlinks {
            if let Some(e) = entries.get_mut(idx) {
                if let Ok(meta) = self.sftp.metadata(e.path.clone()).await {
                    e.is_dir = meta.file_type().is_dir();
                    if e.is_dir {
                        e.size = 0;
                    }
                }
            }
        }

        Ok(entries)
    }

    pub async fn read_file(&self, path: &str) -> Result<String, String> {
        let meta = self
            .sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("Could not stat {path}: {e}"))?;
        if meta.len() > MAX_READ_BYTES {
            return Err(format!(
                "File too large to open ({} bytes > 2 MB)",
                meta.len()
            ));
        }
        let bytes = self
            .sftp
            .read(path.to_string())
            .await
            .map_err(|e| format!("Could not read {path}: {e}"))?;
        String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8"))
    }

    pub async fn create_file(&self, path: &str) -> Result<(), String> {
        // `create` truncates, which is the same bargain `fs_create_file` makes
        // locally with `File::create`.
        self.sftp
            .create(path.to_string())
            .await
            .map(|_| ())
            .map_err(|e| format!("Could not create {path}: {e}"))
    }

    pub async fn create_dir(&self, path: &str) -> Result<(), String> {
        self.sftp
            .create_dir(path.to_string())
            .await
            .map_err(|e| format!("Could not create {path}: {e}"))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        self.sftp
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(|e| format!("Could not rename {from}: {e}"))
    }

    pub async fn delete(&self, path: &str) -> Result<(), String> {
        let meta = self
            .sftp
            .metadata(path.to_string())
            .await
            .map_err(|e| format!("Could not stat {path}: {e}"))?;
        if meta.file_type().is_dir() {
            // SFTP v3's `rmdir` only removes an empty directory, so a
            // recursive delete would be a client-side walk. The UI has already
            // taken the user's confirmation by the time this runs.
            self.run_ok(&format!("rm -rf -- {}", quote(path))).await
        } else {
            self.sftp
                .remove_file(path.to_string())
                .await
                .map_err(|e| format!("Could not delete {path}: {e}"))
        }
    }

    /// Recursive copy, preserving mode and timestamps. `to` is the full
    /// destination path, not a directory to drop `from` into — same contract
    /// as `fs_copy`.
    pub async fn copy(&self, from: &str, to: &str) -> Result<(), String> {
        self.run_ok(&format!("cp -a -- {} {}", quote(from), quote(to)))
            .await
    }

    /// Run one command and fail with its stderr when it exits non-zero.
    async fn run_ok(&self, command: &str) -> Result<(), String> {
        let (code, stderr) = self.run(command).await?;
        if code == 0 {
            Ok(())
        } else {
            let msg = stderr.trim();
            Err(if msg.is_empty() {
                format!("Remote command failed (exit {code})")
            } else {
                msg.to_string()
            })
        }
    }

    async fn run(&self, command: &str) -> Result<(u32, String), String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| format!("Could not open a session channel: {e}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("Could not run the remote command: {e}"))?;

        let mut stderr = String::new();
        // A command that closes without ever sending an exit status is a
        // failure we cannot name; 1 keeps the caller on the error path rather
        // than reporting a success nothing confirmed.
        let mut code = 1u32;
        // Drained to the end rather than stopped at `Eof`: OpenSSH sends EOF
        // *before* `exit-status`, so leaving the loop there reads every
        // command as the failure above, however well it went.
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::ExtendedData { data, .. } => {
                    stderr.push_str(&String::from_utf8_lossy(&data));
                }
                ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok((code, stderr))
    }

    /// Close the transport. Best effort: a session being torn down because it
    /// already died has nothing to say goodbye to.
    pub async fn disconnect(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

/// Public-key auth against every identity the agent holds.
///
/// Each identity is offered in turn because the agent's order is not the
/// server's preference, and a host that accepts the third key would otherwise
/// look unreachable. Certificates in the agent are skipped: they authenticate
/// through a different message and no slice needs them yet.
#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut Handle<HostKeyHandler>,
    user: &str,
) -> Result<(), String> {
    use russh::keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env().await.map_err(|e| {
        format!("No usable ssh-agent (SSH_AUTH_SOCK): {e}. Start an agent and `ssh-add` your key.")
    })?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("Could not list ssh-agent identities: {e}"))?;
    if identities.is_empty() {
        return Err("ssh-agent holds no identities — run `ssh-add` first".to_string());
    }

    let hash_alg = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| format!("Could not negotiate a signature algorithm: {e}"))?
        .flatten();

    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        match handle
            .authenticate_publickey_with(user, key, hash_alg, &mut agent)
            .await
        {
            Ok(result) if result.success() => return Ok(()),
            // A key the server rejects is normal — try the next one. A signing
            // error is the agent's problem and ends the attempt.
            Ok(_) => continue,
            Err(e) => return Err(format!("ssh-agent could not sign: {e}")),
        }
    }
    Err(format!("No key in ssh-agent was accepted for {user}"))
}

#[cfg(not(unix))]
async fn authenticate_with_agent(
    _handle: &mut Handle<HostKeyHandler>,
    _user: &str,
) -> Result<(), String> {
    Err("ssh-agent authentication is only wired for Unix sockets in this slice".to_string())
}

#[cfg(test)]
mod tests {
    use super::quote;

    /// The reason `cp -a` and `rm -rf` are allowed to exist at all: a path
    /// with shell metacharacters in it must reach the far side as one word.
    #[test]
    fn quotes_paths_that_would_otherwise_be_shell_syntax() {
        assert_eq!(quote("/tmp/a b"), "'/tmp/a b'");
        assert_eq!(quote("/tmp/x; rm -rf ~"), "'/tmp/x; rm -rf ~'");
        assert_eq!(quote("/tmp/$(whoami)"), "'/tmp/$(whoami)'");
        // An embedded single quote is the case naive quoting gets wrong.
        assert_eq!(quote("/tmp/it's"), r#"'/tmp/it'\''s'"#);
        // Ordinary paths stay readable in logs.
        assert_eq!(quote("/tmp/plain-path.txt"), "/tmp/plain-path.txt");
    }
}
