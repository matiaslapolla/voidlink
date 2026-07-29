use git2::{Config, Cred, CredentialType, RemoteCallbacks};

/// Credentials for every git2-native network operation (fetch, push).
///
/// There used to be two divergent auth paths: git2 for fetch/push, which tried
/// the SSH agent and then `GITHUB_TOKEN`, and a shell-out for pull and tag push,
/// which used whatever the user's **credential helper** provides. Since the
/// helper is how most people are actually authenticated — `osxkeychain`, `gh
/// auth`, `git-credential-manager` — "Fetch fails but Pull works" was routine and
/// looked like a bug in fetch.
///
/// Both paths now resolve credentials the same way, in the order git itself
/// would: the configured credential helper first, then the SSH agent for SSH
/// remotes, then a `GITHUB_TOKEN` from the environment as a last resort. Each is
/// attempted at most once, so a wrong credential surfaces an error instead of
/// looping.
pub(crate) fn default_remote_callbacks<'a>() -> RemoteCallbacks<'a> {
    let mut tried_helper = false;
    let mut tried_ssh = false;
    let mut tried_token = false;
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |url, username_from_url, allowed_types| {
        if allowed_types.contains(CredentialType::USER_PASS_PLAINTEXT) && !tried_helper {
            tried_helper = true;
            // `Config::open_default` reads the same cascade git would, so
            // `credential.helper` set at any level is honoured.
            if let Ok(config) = Config::open_default() {
                if let Ok(cred) = Cred::credential_helper(&config, url, username_from_url) {
                    return Ok(cred);
                }
            }
        }
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
        if allowed_types.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str(
            "git auth failed: configure a credential helper (`git config --global credential.helper`), \
             add your key to the SSH agent, or set GITHUB_TOKEN",
        ))
    });
    callbacks
}
