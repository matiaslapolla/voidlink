use super::cmd::run_git;
use super::repo::open_repo;

/// Create a tag at `target` (default HEAD). When `message` is Some, makes an
/// annotated tag (tagger = repo signature, synthesized when git config has no
/// identity); otherwise a lightweight tag. `force` overwrites an existing tag of
/// the same name — without it, retagging always failed and the UI had no way to
/// say "yes, move it".
pub(crate) fn git_create_tag_impl(
    repo_path: String,
    name: String,
    target: Option<String>,
    message: Option<String>,
    force: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let target_ref = target.as_deref().unwrap_or("HEAD");
    let obj = repo
        .revparse_single(target_ref)
        .map_err(|e| format!("could not resolve '{target_ref}': {}", e.message()))?;

    match message {
        Some(msg) if !msg.trim().is_empty() => {
            // An annotated tag needs a tagger, and hard-failing because
            // `user.name` is unset would make the annotated path unusable in a
            // repo the user can otherwise work in. Same helper the stash uses.
            let sig = super::staging::housekeeping_signature(&repo)?;
            repo.tag(&name, &obj, &sig, &msg, force)
                .map_err(|e| e.message().to_string())?;
        }
        _ => {
            repo.tag_lightweight(&name, &obj, force)
                .map_err(|e| e.message().to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn git_delete_tag_impl(repo_path: String, name: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    repo.tag_delete(&name).map_err(|e| e.message().to_string())
}

/// Delete a tag on the remote as well. Local deletion leaves the published tag
/// in place — the version everyone else fetches — which the UI now offers to
/// remove explicitly rather than leaving unmentioned.
pub(crate) fn git_delete_remote_tag_impl(
    repo_path: String,
    name: String,
    remote: Option<String>,
) -> Result<(), String> {
    let remote_name = remote.unwrap_or_else(|| "origin".to_string());
    let refspec = format!("refs/tags/{name}");
    run_git(&repo_path, &["push", &remote_name, "--delete", &refspec])?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    #[test]
    fn force_moves_an_existing_tag_and_without_it_retagging_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        write_file(tmp.path(), "a.txt", "one\n");
        commit_all(&repo, "one");
        let path = tmp.path().to_string_lossy().to_string();

        git_create_tag_impl(path.clone(), "v1".into(), None, None, false).unwrap();
        write_file(tmp.path(), "a.txt", "two\n");
        let second = commit_all(&repo, "two");

        assert!(
            git_create_tag_impl(path.clone(), "v1".into(), None, None, false).is_err(),
            "retagging without force must still refuse"
        );
        git_create_tag_impl(path.clone(), "v1".into(), None, None, true).unwrap();
        let moved = repo.revparse_single("refs/tags/v1").unwrap().id();
        assert_eq!(moved, second);
    }

    #[test]
    fn an_annotated_tag_works_without_a_configured_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(tmp.path()).unwrap();
        write_file(tmp.path(), "a.txt", "one\n");
        let tree_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new("a.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        {
            let tree = repo.find_tree(tree_oid).unwrap();
            let sig = git2::Signature::now("x", "x@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "one", &tree, &[])
                .unwrap();
        }

        git_create_tag_impl(
            tmp.path().to_string_lossy().to_string(),
            "v1".into(),
            None,
            Some("release".into()),
            false,
        )
        .expect("an annotated tag must not require user.name");
    }
}
