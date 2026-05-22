use git2::PushOptions;

use super::auth::default_remote_callbacks;
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

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(default_remote_callbacks());

    remote_obj
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| e.message().to_string())?;

    Ok(())
}
