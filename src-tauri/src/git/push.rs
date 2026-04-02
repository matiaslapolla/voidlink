use git2::{Cred, CredentialType, PushOptions, RemoteCallbacks};

use super::repo::open_repo;

pub(crate) fn git_push_impl(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin");

    let branch_name = match branch {
        Some(b) => b,
        None => {
            let head = repo.head().map_err(|e| e.message().to_string())?;
            head.shorthand()
                .ok_or_else(|| "HEAD is detached — specify a branch".to_string())?
                .to_string()
        }
    };

    let refspec = format!(
        "refs/heads/{}:refs/heads/{}",
        branch_name, branch_name
    );

    let mut remote_obj = repo
        .find_remote(remote_name)
        .map_err(|e| e.message().to_string())?;

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
            "push auth failed: set GITHUB_TOKEN or configure SSH agent",
        ))
    });

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    remote_obj
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| e.message().to_string())?;

    Ok(())
}
