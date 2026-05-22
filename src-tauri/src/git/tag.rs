use super::cmd::run_git;
use super::repo::open_repo;

/// Create a tag at `target` (default HEAD). When `message` is Some, makes an
/// annotated tag (tagger = repo signature); otherwise a lightweight tag.
pub(crate) fn git_create_tag_impl(
    repo_path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let target_ref = target.as_deref().unwrap_or("HEAD");
    let obj = repo
        .revparse_single(target_ref)
        .map_err(|e| format!("could not resolve '{target_ref}': {}", e.message()))?;

    match message {
        Some(msg) if !msg.trim().is_empty() => {
            let sig = repo.signature().map_err(|e| e.message().to_string())?;
            repo.tag(&name, &obj, &sig, &msg, false)
                .map_err(|e| e.message().to_string())?;
        }
        _ => {
            repo.tag_lightweight(&name, &obj, false)
                .map_err(|e| e.message().to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn git_delete_tag_impl(repo_path: String, name: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    repo.tag_delete(&name).map_err(|e| e.message().to_string())
}

/// Push a single tag to `remote` (default "origin"). Shells out so it uses the
/// user's git credential helper, matching how they'd push tags by hand.
pub(crate) fn git_push_tag_impl(
    repo_path: String,
    name: String,
    remote: Option<String>,
) -> Result<(), String> {
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    let refspec = format!("refs/tags/{name}");
    run_git(&repo_path, &["push", &remote_name, &refspec])?;
    Ok(())
}
