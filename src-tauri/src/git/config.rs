//! Real git configuration: reading the effective cascade and writing a single
//! key at a chosen scope.
//!
//! This is the one place in voidlink that writes files git owns, and the one
//! place that can write *outside* the repository (`~/.gitconfig`). Two rules
//! follow from that and are load-bearing:
//!
//!   1. **Writes are allowlist-gated here, in Rust** — not only in the UI. A
//!      key outside [`WRITABLE_KEYS`] is rejected before libgit2 is touched, so
//!      a bug (or a future caller) in the frontend cannot turn this into an
//!      arbitrary config editor.
//!   2. **Write failures name the resolved file.** "permission denied" is
//!      useless when the user cannot tell whether the write was aimed at the
//!      repo or their home directory, so every error carries the path.
//!
//! Reads are unrestricted and return the *whole* cascade, shadowed entries
//! included — the same key can appear at `global` and `local` in the returned
//! list. That duplication is deliberate: it is the only way a caller can tell
//! "set here" from "set here, overriding global", which is exactly the case a
//! user needs to see before editing.
//!
//! Everything here is libgit2, never `git config` as a subprocess: config is
//! the case libgit2 models correctly, including the level of each entry.

use git2::{Config, ConfigLevel, ErrorCode};
use serde::{Deserialize, Serialize};

use super::repo::open_repo;

/// The keys voidlink will write. Curated, not open-ended: the point of this
/// surface is a safe, discoverable set of the keys people actually change —
/// editing an arbitrary key is a terminal's job.
///
/// Reads are not filtered by this list; only `set` and `unset` are.
pub(crate) const WRITABLE_KEYS: &[&str] = &[
    "user.name",
    "user.email",
    "user.signingkey",
    "commit.gpgsign",
    "core.editor",
    "core.autocrlf",
    "core.ignorecase",
    "core.filemode",
    "init.defaultBranch",
    "pull.rebase",
    "push.default",
    "push.autoSetupRemote",
    "fetch.prune",
    "rebase.autoStash",
    "merge.conflictstyle",
    "diff.algorithm",
];

/// One entry of the effective cascade. `level` is a string rather than an enum
/// because it crosses to TypeScript, where the union type is the schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub value: String,
    /// `"system" | "global" | "local" | "worktree" | "app" | "unknown"`.
    pub level: String,
}

/// The files a write would actually land in, resolved by libgit2 rather than
/// guessed by the frontend. `local` is `None` when no repository is open.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigScopePaths {
    pub local: Option<String>,
    pub global: String,
}

/// What `git_config_list` hands the UI: the cascade plus the resolved target
/// paths, in one round trip. The paths are part of the read because the pane
/// must state, continuously and without hovering, which file an edit will
/// touch — and it must not compose that path itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub entries: Vec<ConfigEntry>,
    pub scopes: ConfigScopePaths,
}

/// `ConfigLevel` → the wire string. XDG is reported as `global` because that is
/// what it is to a user: their own per-user file. ProgramData is Windows'
/// machine-wide file, so it joins `system`.
fn level_name(level: ConfigLevel) -> &'static str {
    match level {
        ConfigLevel::ProgramData | ConfigLevel::System => "system",
        ConfigLevel::XDG | ConfigLevel::Global => "global",
        ConfigLevel::Local => "local",
        ConfigLevel::Worktree => "worktree",
        ConfigLevel::App => "app",
        _ => "unknown",
    }
}

/// The multi-level config to read from. With a repository this is the full
/// repo → global → system cascade; without one it is still the global and
/// system files, because "no repo open" must not empty the pane.
fn open_cascade(repo_path: &str) -> Result<Config, String> {
    match open_repo(repo_path) {
        Ok(repo) => repo.config().map_err(|e| e.message().to_string()),
        Err(_) => Config::open_default().map_err(|e| e.message().to_string()),
    }
}

/// The file a write at `scope` lands in. Resolved before the write so a failure
/// can name it, and returned to the UI so the user can read it before editing.
fn scope_path(repo_path: &str, scope: &str) -> Result<String, String> {
    match scope {
        "local" => {
            let repo = open_repo(repo_path)?;
            let git_dir = repo.path().to_path_buf();
            // In a linked worktree the local config lives in the *main*
            // `.git/config`; `repo.path()` is the worktree's private dir, and
            // the `commondir` file next to it points at the real one. git2
            // 0.19 has no `Repository::commondir`, so resolve it by hand
            // rather than name a file writes would not land in.
            let common = match std::fs::read_to_string(git_dir.join("commondir")) {
                Ok(rel) => {
                    let rel = rel.trim();
                    let joined = git_dir.join(rel);
                    std::fs::canonicalize(&joined).unwrap_or(joined)
                }
                Err(_) => git_dir,
            };
            Ok(common.join("config").to_string_lossy().to_string())
        }
        "global" => Ok(global_config_path()),
        other => Err(format!(
            "unknown config scope `{other}` — expected `local` or `global`"
        )),
    }
}

/// `~/.gitconfig`, or the XDG file when that is the one git would use. Both
/// `find_*` calls fail when the file does not exist yet, in which case the
/// path git *would* create is the honest answer.
fn global_config_path() -> String {
    if let Ok(p) = Config::find_global() {
        return p.to_string_lossy().to_string();
    }
    if let Ok(p) = Config::find_xdg() {
        return p.to_string_lossy().to_string();
    }
    match std::env::var("HOME") {
        Ok(home) => format!("{home}/.gitconfig"),
        Err(_) => "~/.gitconfig".to_string(),
    }
}

/// A single-level config opened for writing. Local goes through the repository
/// so linked worktrees resolve correctly; global goes through `open_global`,
/// which applies git's own rule for choosing between `~/.gitconfig` and the
/// XDG file rather than assuming one of them.
fn open_scope_for_write(repo_path: &str, scope: &str) -> Result<Config, String> {
    match scope {
        "local" => {
            let repo = open_repo(repo_path)?;
            let cfg = repo.config().map_err(|e| e.message().to_string())?;
            cfg.open_level(ConfigLevel::Local)
                .map_err(|e| e.message().to_string())
        }
        "global" => {
            let mut cfg = Config::open_default().map_err(|e| e.message().to_string())?;
            cfg.open_global().map_err(|e| e.message().to_string())
        }
        other => Err(format!(
            "unknown config scope `{other}` — expected `local` or `global`"
        )),
    }
}

/// The allowlist gate. Case-insensitive because git treats section and key
/// names that way (`init.defaultBranch` and `init.defaultbranch` are the same
/// key), and the UI is not the only possible caller.
fn ensure_writable(key: &str) -> Result<(), String> {
    let wanted = key.trim().to_ascii_lowercase();
    if WRITABLE_KEYS
        .iter()
        .any(|k| k.to_ascii_lowercase() == wanted)
    {
        return Ok(());
    }
    Err(format!(
        "`{key}` is not one of the keys voidlink will write — edit it with `git config` instead"
    ))
}

/// The whole effective cascade, shadowed entries included. See the module doc
/// for why the duplicates matter.
pub(crate) fn git_config_list_impl(repo_path: String) -> Result<Vec<ConfigEntry>, String> {
    let mut cfg = open_cascade(&repo_path)?;
    // Snapshot first: a live config can change under the iterator, and half of
    // one read and half of another is worse than a slightly stale whole.
    let snapshot = cfg.snapshot().map_err(|e| e.message().to_string())?;
    let mut out: Vec<ConfigEntry> = Vec::new();
    let entries = snapshot.entries(None).map_err(|e| e.message().to_string())?;
    entries
        .for_each(|entry| {
            if let Some(name) = entry.name() {
                out.push(ConfigEntry {
                    key: name.to_string(),
                    value: entry_value(&entry),
                    level: level_name(entry.level()).to_string(),
                });
            }
        })
        .map_err(|e| e.message().to_string())?;
    Ok(out)
}

/// A valueless entry (`[core]\n\tfilemode`) is git's shorthand for boolean
/// true. `ConfigEntry::value` *panics* in that case, so the guard is required,
/// not defensive.
fn entry_value(entry: &git2::ConfigEntry<'_>) -> String {
    if entry.has_value() {
        entry.value().unwrap_or("").to_string()
    } else {
        "true".to_string()
    }
}

/// The cascade plus the resolved write targets — what the UI actually reads.
pub(crate) fn git_config_snapshot_impl(repo_path: String) -> Result<ConfigSnapshot, String> {
    let entries = git_config_list_impl(repo_path.clone())?;
    Ok(ConfigSnapshot {
        entries,
        scopes: ConfigScopePaths {
            // `None` rather than an error: no repo open is a normal state for
            // this pane, and the global cascade still renders.
            local: scope_path(&repo_path, "local").ok(),
            global: global_config_path(),
        },
    })
}

/// The winning value for one key, with the level it won at. `None` when the
/// key is set nowhere in the cascade.
pub(crate) fn git_config_get_impl(
    repo_path: String,
    key: String,
) -> Result<Option<ConfigEntry>, String> {
    let mut cfg = open_cascade(&repo_path)?;
    let snapshot = cfg.snapshot().map_err(|e| e.message().to_string())?;
    // Bound to a local: the returned `ConfigEntry` borrows `snapshot`, and as
    // the tail expression of the function it would outlive it.
    let found = match snapshot.get_entry(&key) {
        Ok(entry) => Ok(Some(ConfigEntry {
            key: entry.name().unwrap_or(&key).to_string(),
            value: entry_value(&entry),
            level: level_name(entry.level()).to_string(),
        })),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.message().to_string()),
    };
    found
}

/// Write one allowlisted key at `local` or `global`. No system scope: it needs
/// elevation and is not a per-user concern.
pub(crate) fn git_config_set_impl(
    repo_path: String,
    key: String,
    value: String,
    scope: String,
) -> Result<(), String> {
    ensure_writable(&key)?;
    let path = scope_path(&repo_path, &scope)?;
    let mut cfg = open_scope_for_write(&repo_path, &scope)?;
    cfg.set_str(&key, &value)
        .map_err(|e| format!("{} — writing `{}` to {}", e.message(), key, path))
}

/// Remove the key at that scope so the cascade falls through again. Removing
/// something already absent is a no-op, not an error: the user's intent
/// ("don't set this here") is satisfied either way.
pub(crate) fn git_config_unset_impl(
    repo_path: String,
    key: String,
    scope: String,
) -> Result<(), String> {
    ensure_writable(&key)?;
    let path = scope_path(&repo_path, &scope)?;
    let mut cfg = open_scope_for_write(&repo_path, &scope)?;
    match cfg.remove(&key) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(()),
        Err(e) => Err(format!("{} — clearing `{}` in {}", e.message(), key, path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Only ever writes at *local* scope. A test that wrote at global scope
    /// would edit the machine's real `~/.gitconfig`.
    fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        dir
    }

    #[test]
    fn reads_a_local_value_back_with_its_level() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();

        git_config_set_impl(
            path.clone(),
            "user.email".into(),
            "local@example.com".into(),
            "local".into(),
        )
        .unwrap();

        let entry = git_config_get_impl(path.clone(), "user.email".into())
            .unwrap()
            .expect("user.email should resolve after a local write");
        assert_eq!(entry.value, "local@example.com");
        assert_eq!(entry.level, "local");

        // The full listing carries the same entry at the same level.
        let listed = git_config_list_impl(path).unwrap();
        assert!(listed
            .iter()
            .any(|e| e.key == "user.email" && e.value == "local@example.com" && e.level == "local"));
    }

    #[test]
    fn unset_makes_the_key_fall_through_again() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();

        git_config_set_impl(
            path.clone(),
            "init.defaultBranch".into(),
            "trunk".into(),
            "local".into(),
        )
        .unwrap();
        assert_eq!(
            git_config_get_impl(path.clone(), "init.defaultBranch".into())
                .unwrap()
                .map(|e| e.value),
            Some("trunk".to_string())
        );

        git_config_unset_impl(path.clone(), "init.defaultBranch".into(), "local".into()).unwrap();

        // Nothing is left at local level; whatever the machine's global config
        // says (possibly nothing) is what wins now.
        let after = git_config_get_impl(path.clone(), "init.defaultBranch".into()).unwrap();
        assert!(after.as_ref().map(|e| e.level.as_str()) != Some("local"));

        // And clearing an already-absent key is a no-op rather than an error.
        git_config_unset_impl(path, "init.defaultBranch".into(), "local".into()).unwrap();
    }

    #[test]
    fn rejects_a_key_outside_the_allowlist() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();

        let err = git_config_set_impl(
            path.clone(),
            "core.hooksPath".into(),
            "/tmp/hooks".into(),
            "local".into(),
        )
        .unwrap_err();
        assert!(err.contains("core.hooksPath"), "error names the key: {err}");

        // Rejected before libgit2 was touched, so nothing was written.
        assert!(git_config_get_impl(path.clone(), "core.hooksPath".into())
            .unwrap()
            .is_none());

        // Unset is a write too, and is gated the same way.
        assert!(git_config_unset_impl(path, "core.hooksPath".into(), "local".into()).is_err());
    }

    #[test]
    fn allowlist_matching_ignores_case() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();
        git_config_set_impl(path, "INIT.DEFAULTBRANCH".into(), "main".into(), "local".into())
            .unwrap();
    }

    #[test]
    fn snapshot_reports_the_resolved_target_files() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();

        let snap = git_config_snapshot_impl(path).unwrap();
        let local = snap.scopes.local.expect("a repo is open, so local resolves");
        assert!(local.ends_with("config"), "local target was {local}");
        assert!(!snap.scopes.global.is_empty());
    }

    #[test]
    fn no_repo_still_reads_the_global_cascade() {
        // A path that is not a repository: the cascade falls back to the
        // default (global + system) config and local has no target.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().to_string();

        let snap = git_config_snapshot_impl(path).unwrap();
        assert!(snap.scopes.local.is_none());
        assert!(snap.entries.iter().all(|e| e.level != "local"));
    }

    #[test]
    fn an_unknown_scope_is_rejected() {
        let dir = temp_repo();
        let path = dir.path().to_string_lossy().to_string();
        let err =
            git_config_set_impl(path, "user.name".into(), "x".into(), "system".into()).unwrap_err();
        assert!(err.contains("system"), "{err}");
    }
}
