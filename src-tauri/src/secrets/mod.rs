//! OS-credential-store backed secret storage for AI provider keys.
//!
//! VoidLink stays BYO-CLI: it never talks to a provider API itself. What it
//! can do is *hold* a provider key in the OS credential store (macOS Keychain,
//! Windows Credential Manager, Linux secret-service) and export it into the
//! environment of the AI CLI the user already configured. Nothing is written
//! to `localStorage`, to the settings JSON, or to any file voidlink owns.
//!
//! **Hard rule: a secret value never crosses the IPC boundary back to the
//! webview.** `secret_set` writes, `secret_delete` removes, `secret_status`
//! reports presence plus a hint of at most 4 characters. There is deliberately
//! no `secret_get` command — reads of the real value are Rust-internal and
//! happen only in [`resolve_bindings`], at the subprocess spawn site.
//!
//! The keychain-touching functions are thin; everything with a rule in it
//! ([`mask_hint`], [`validate_env_var`], [`validate_id`], [`merge_env`]) is a
//! pure function so it is unit-testable without a keychain.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Keychain service name. Every voidlink credential is stored under this
/// service with the binding `id` as the account, so `security find-generic-
/// password -s com.voidlink.app` lists exactly what the app owns.
pub(crate) const SERVICE: &str = "com.voidlink.app";

/// Maximum number of trailing characters ever revealed by a status hint.
const HINT_CHARS: usize = 4;

/// Values shorter than this get no hint at all — showing the last 4 of a
/// 5-character secret would leak most of it.
const MIN_HINTABLE_LEN: usize = 8;

/// Non-secret identity of a stored key: which keychain account holds the
/// value, and which environment variable it is exported as. Sent *to* Rust by
/// the frontend (it lives in the settings store); never carries a value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretBinding {
    pub id: String,
    pub env_var: String,
}

/// What the settings UI is allowed to know about a stored key.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub id: String,
    pub present: bool,
    /// At most [`HINT_CHARS`] trailing characters, empty for short values.
    pub hint: String,
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

/// The only projection of a secret value that may be shown to the user: the
/// last few characters, so "is the key I pasted the one I think it is?" is
/// answerable without revealing it. Never returns more than [`HINT_CHARS`]
/// characters, and returns nothing for values short enough that a 4-character
/// tail would be a meaningful fraction of the whole.
pub(crate) fn mask_hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < MIN_HINTABLE_LEN {
        return String::new();
    }
    chars[chars.len() - HINT_CHARS..].iter().collect()
}

/// Variables that control how a process finds code or libraries. Letting a
/// stored "key" be exported under one of these names would turn the settings
/// dialog into a code-execution vector against the user's own AI CLI.
const RESERVED_ENV_VARS: &[&str] = &[
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "IFS",
    "ENV",
    "BASH_ENV",
    "ZDOTDIR",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "NODE_OPTIONS",
    "PERL5OPT",
    "RUBYOPT",
];

/// POSIX-shaped environment variable name check: `[A-Za-z_][A-Za-z0-9_]*`,
/// bounded length, and not one of the loader/shell variables above.
pub(crate) fn validate_env_var(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Environment variable name is empty.".to_string());
    }
    if name.len() > 128 {
        return Err("Environment variable name is too long (max 128 characters).".to_string());
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap_or('\0');
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!(
            "`{name}` is not a valid environment variable name — it must start with a letter or underscore."
        ));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!(
            "`{name}` is not a valid environment variable name — use only letters, digits, and underscores."
        ));
    }
    if RESERVED_ENV_VARS.contains(&name.to_ascii_uppercase().as_str()) {
        return Err(format!(
            "`{name}` is reserved by the shell and can't be used to carry an API key."
        ));
    }
    Ok(())
}

/// Keychain account names voidlink is willing to own. Kept deliberately
/// narrow so an id can never smuggle a path separator or NUL into a
/// platform credential store.
pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("Key id is empty.".to_string());
    }
    if id.len() > 64 {
        return Err("Key id is too long (max 64 characters).".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(format!(
            "`{id}` is not a valid key id — use only letters, digits, `.`, `-`, and `_`."
        ));
    }
    Ok(())
}

/// Additive environment merge for a child process.
///
/// `inherited` is the environment the child would get anyway; `secrets` are
/// the `(env var, value)` pairs voidlink would like to add. **An inherited
/// variable always wins** — if the user's shell already exports
/// `ANTHROPIC_API_KEY`, voidlink does not override it, so a working shell
/// setup keeps working and voidlink is only ever a fallback. Duplicate names
/// inside `secrets` resolve first-wins.
///
/// Returns only the pairs that should actually be set on the child; the
/// caller applies them with `Command::env`, leaving everything else inherited
/// and untouched.
pub(crate) fn merge_env(
    inherited: &HashMap<String, String>,
    secrets: &[(String, String)],
) -> Vec<(String, String)> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for (name, value) in secrets {
        if inherited.contains_key(name) {
            continue;
        }
        if !seen.insert(name.as_str()) {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    out
}

// ─── Credential store ────────────────────────────────────────────────────────

/// Turn a keyring failure into a message a user can act on. The important
/// distinction is *denial* (locked keychain, user clicked Deny on the OS
/// prompt) versus a genuinely absent entry — the latter never reaches here,
/// callers map it to "not set" instead.
fn keychain_error(op: &str, id: &str, e: keyring::Error) -> String {
    match e {
        keyring::Error::NoStorageAccess(inner) => format!(
            "Keychain access denied while trying to {op} `{id}` ({inner}). Unlock your keychain, or click Allow when macOS asks, then try again."
        ),
        keyring::Error::NoDefaultStore => format!(
            "No OS credential store is available on this system, so `{id}` can't be {op}d."
        ),
        keyring::Error::NotSupportedByStore(msg) => {
            format!("The OS credential store refused to {op} `{id}`: {msg}")
        }
        keyring::Error::Ambiguous(_) => format!(
            "Multiple keychain entries match `{id}`. Remove the duplicates in Keychain Access, then try again."
        ),
        keyring::Error::TooLong(what, max) => {
            format!("Value rejected by the credential store: {what} exceeds {max} bytes.")
        }
        other => format!("Keychain error while trying to {op} `{id}`: {other}"),
    }
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    validate_id(id)?;
    keyring::Entry::new(SERVICE, id).map_err(|e| keychain_error("open", id, e))
}

/// Write (or overwrite) the value stored under `id`.
pub(crate) fn set(id: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("Refusing to store an empty key.".to_string());
    }
    entry(id)?
        .set_password(value)
        .map_err(|e| keychain_error("store", id, e))
}

/// Remove the credential under `id`. Already-absent is success: the caller
/// asked for "not stored" and that is the resulting state.
pub(crate) fn delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keychain_error("delete", id, e)),
    }
}

/// Rust-internal read. **Never exposed as a Tauri command.** `Ok(None)` means
/// no such credential; any `Err` is a real keychain problem (denied, locked,
/// malformed) that the caller must surface rather than swallow.
fn read(id: &str) -> Result<Option<String>, String> {
    match entry(id)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_error("read", id, e)),
    }
}

/// Presence + masked hint for each requested id.
pub(crate) fn status(ids: &[String]) -> Result<Vec<SecretStatus>, String> {
    ids.iter()
        .map(|id| {
            let value = read(id)?;
            Ok(SecretStatus {
                id: id.clone(),
                present: value.is_some(),
                hint: value.as_deref().map(mask_hint).unwrap_or_default(),
            })
        })
        .collect()
}

/// Resolve bindings against the credential store into `(env var, value)`
/// pairs ready for `Command::env`.
///
/// A binding whose credential is missing is skipped — bindings live in
/// settings and can outlive the key they name. Anything else (denied, locked,
/// unreadable keychain) is a hard error so the AI action fails loudly instead
/// of silently running the CLI unauthenticated.
pub(crate) fn resolve_bindings(
    bindings: &[SecretBinding],
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(bindings.len());
    for binding in bindings {
        validate_env_var(&binding.env_var)?;
        match read(&binding.id)? {
            Some(value) => out.push((binding.env_var.clone(), value)),
            // id only — never the value, and never the env var's contents.
            None => log::debug!("secret binding `{}` has no stored credential", binding.id),
        }
    }
    Ok(out)
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

/// Store `value` under `id`. `env_var` is validated but not persisted here —
/// it lives in the frontend settings store; validating it on the write path
/// means a bad name is rejected while the user is still looking at the form,
/// with one implementation of the rule instead of two.
#[tauri::command]
pub async fn secret_set(id: String, env_var: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&id)?;
        validate_env_var(&env_var)?;
        set(&id, &value)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_delete(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn secret_status(ids: Vec<String>) -> Result<Vec<SecretStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || status(&ids))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    // ── hint masking ────────────────────────────────────────────────────────

    #[test]
    fn hint_never_exposes_more_than_four_characters() {
        let samples = [
            "",
            "a",
            "abc",
            "abcdefg",
            "abcdefgh",
            "sk-ant-api03-0123456789abcdef",
            &"x".repeat(4096),
        ];
        for s in samples {
            let hint = mask_hint(s);
            assert!(
                hint.chars().count() <= 4,
                "hint for a {}-char value was {} chars: {hint:?}",
                s.chars().count(),
                hint.chars().count()
            );
        }
    }

    #[test]
    fn hint_is_the_trailing_four_characters_of_long_values() {
        assert_eq!(mask_hint("sk-ant-api03-0123456789abcdef"), "cdef");
        assert_eq!(mask_hint("abcdefgh"), "efgh");
    }

    #[test]
    fn short_values_get_no_hint_at_all() {
        // A 4-char hint of a 7-char secret would be most of the secret.
        for s in ["a", "abcd", "abcdefg"] {
            assert_eq!(mask_hint(s), "", "expected no hint for {s:?}");
        }
    }

    #[test]
    fn hint_counts_characters_not_bytes() {
        // Multi-byte tail must not panic on a byte-index slice and must still
        // be capped at 4 characters.
        let hint = mask_hint("key-with-emoji-🔑🔑🔑🔑");
        assert_eq!(hint.chars().count(), 4);
        assert_eq!(hint, "🔑🔑🔑🔑");
    }

    // ── env merge precedence ────────────────────────────────────────────────

    #[test]
    fn env_merge_leaves_an_inherited_variable_untouched() {
        let inherited = env(&[("ANTHROPIC_API_KEY", "from-user-shell"), ("PATH", "/usr/bin")]);
        let added = merge_env(&inherited, &pairs(&[("ANTHROPIC_API_KEY", "from-keychain")]));
        assert!(
            added.is_empty(),
            "voidlink must not override a variable the user's shell already exports, got {added:?}"
        );
    }

    #[test]
    fn env_merge_adds_only_variables_that_are_missing() {
        let inherited = env(&[("OPENAI_API_KEY", "from-user-shell")]);
        let added = merge_env(
            &inherited,
            &pairs(&[
                ("OPENAI_API_KEY", "from-keychain"),
                ("ANTHROPIC_API_KEY", "from-keychain"),
            ]),
        );
        assert_eq!(added, pairs(&[("ANTHROPIC_API_KEY", "from-keychain")]));
    }

    #[test]
    fn env_merge_is_first_wins_on_duplicate_names() {
        let added = merge_env(
            &env(&[]),
            &pairs(&[("GEMINI_API_KEY", "first"), ("GEMINI_API_KEY", "second")]),
        );
        assert_eq!(added, pairs(&[("GEMINI_API_KEY", "first")]));
    }

    #[test]
    fn env_merge_with_nothing_stored_changes_nothing() {
        assert!(merge_env(&env(&[("PATH", "/usr/bin")]), &[]).is_empty());
    }

    // ── validation ──────────────────────────────────────────────────────────

    #[test]
    fn valid_env_var_names_are_accepted() {
        for name in [
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "_PRIVATE",
            "X",
            "a1_b2",
        ] {
            assert!(validate_env_var(name).is_ok(), "{name} should be valid");
        }
    }

    #[test]
    fn invalid_env_var_names_are_rejected() {
        for name in [
            "",                  // empty
            "1KEY",              // leading digit
            "MY KEY",            // space
            "MY-KEY",            // hyphen
            "KEY=VALUE",         // assignment smuggling
            "KEY;rm -rf /",      // shell metacharacters
            "KÉY",               // non-ascii
            "KEY\0NUL",          // embedded NUL
            "KEY\nOTHER=1",      // newline smuggling
        ] {
            assert!(
                validate_env_var(name).is_err(),
                "{name:?} should have been rejected"
            );
        }
        assert!(validate_env_var(&"A".repeat(129)).is_err(), "over-long name");
    }

    #[test]
    fn loader_and_shell_variables_are_rejected() {
        for name in [
            "PATH",
            "path",
            "HOME",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "NODE_OPTIONS",
            "BASH_ENV",
        ] {
            assert!(
                validate_env_var(name).is_err(),
                "{name} must not be usable as a key carrier"
            );
        }
    }

    #[test]
    fn ids_are_constrained_to_safe_characters() {
        for id in ["anthropic", "custom.MY_KEY", "a-b_c.1"] {
            assert!(validate_id(id).is_ok(), "{id} should be valid");
        }
        for id in ["", "has space", "has/slash", "has:colon", "has\0nul"] {
            assert!(validate_id(id).is_err(), "{id:?} should be rejected");
        }
        assert!(validate_id(&"a".repeat(65)).is_err(), "over-long id");
    }

    // ── the value never leaks through the status shape ──────────────────────

    #[test]
    fn status_payload_serializes_without_the_value() {
        let json = serde_json::to_string(&SecretStatus {
            id: "anthropic".to_string(),
            present: true,
            hint: mask_hint("sk-ant-api03-0123456789abcdef"),
        })
        .expect("status serializes");
        assert_eq!(json, r#"{"id":"anthropic","present":true,"hint":"cdef"}"#);
        assert!(!json.contains("0123456789"));
    }
}
