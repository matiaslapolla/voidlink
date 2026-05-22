use git2::{Cred, CredentialType, RemoteCallbacks};

/// Credential callback shared by every git2-native network operation (push,
/// fetch). Tries the SSH agent first, then a `GITHUB_TOKEN` userpass fallback —
/// each at most once, so a failed attempt surfaces a clear error instead of
/// looping. Note: porcelain shell-outs (`git pull`, tag push) do NOT use this;
/// they rely on the user's configured git credential helper instead.
pub(crate) fn default_remote_callbacks<'a>() -> RemoteCallbacks<'a> {
    let mut tried_ssh = false;
    let mut tried_token = false;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username_from_url, allowed_types| {
        if allowed_types.contains(CredentialType::SSH_KEY) && !tried_ssh {
            tried_ssh = true;
            return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }
        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_token {
            tried_token = true;
            if let Ok(token) = std::env::var("GITHUB_TOKEN") {
                return Cred::userpass_plaintext("x-access-token", &token);
            }
        }
        Err(git2::Error::from_str(
            "git auth failed: set GITHUB_TOKEN or configure SSH agent",
        ))
    });
    callbacks
}
