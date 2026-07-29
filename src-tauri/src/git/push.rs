use std::cell::RefCell;
use std::rc::Rc;

use git2::{BranchType, PushOptions};

use super::auth::default_remote_callbacks;
use super::repo::open_repo;

/// Push one branch to a remote.
///
/// Three things this has to get right, all of which it previously got wrong:
///
///   * **A rejected push is a failure.** libgit2's `Remote::push` returns `Ok`
///     when the transport succeeded even if the server rejected every ref, so a
///     non-fast-forward reject showed a green ✓ in the UI. The per-ref verdict
///     only arrives through the `push_update_reference` callback, so we register
///     one and turn any status into an error.
///   * **Detached HEAD.** `Reference::shorthand()` returns `"HEAD"` for a
///     detached head rather than `None`, so the old `ok_or_else` never fired and
///     we cheerfully pushed `refs/heads/HEAD` to the remote.
///   * **Upstream.** Nothing ever set one, so ahead/behind stayed 0/0 after the
///     first push and the header had nothing to report.
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
            if repo.head_detached().unwrap_or(false) {
                return Err(
                    "HEAD is detached — check out a branch (or pick one) before pushing".to_string(),
                );
            }
            let head = repo.head().map_err(|e| {
                format!(
                    "{} — this branch has no commits yet, so there is nothing to push",
                    e.message()
                )
            })?;
            if !head.is_branch() {
                return Err("HEAD does not point at a branch — cannot push".to_string());
            }
            head.shorthand()
                .ok_or_else(|| "could not read the current branch name".to_string())?
                .to_string()
        }
    };

    let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");

    let mut remote_obj = repo
        .find_remote(remote_name)
        .map_err(|e| format!("remote '{remote_name}': {}", e.message()))?;

    // The callback fires once per pushed ref; `status` is `None` on success and
    // the server's reason on a reject. Collected rather than returned directly
    // because libgit2 keeps going through the remaining refs.
    let rejections: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
    let mut callbacks = default_remote_callbacks();
    {
        let sink = Rc::clone(&rejections);
        callbacks.push_update_reference(move |refname, status| {
            if let Some(reason) = status {
                sink.borrow_mut().push(format!("{refname}: {reason}"));
            }
            Ok(())
        });
    }

    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    remote_obj
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| e.message().to_string())?;

    let rejected = rejections.borrow().clone();
    if !rejected.is_empty() {
        return Err(format!(
            "{remote_name} rejected the push — {}",
            rejected.join("; ")
        ));
    }

    // First push of a new branch: give it an upstream so ahead/behind, Pull and
    // the compare-with-upstream affordance have something to read. Best-effort —
    // the push itself already succeeded, and a remote whose tracking ref libgit2
    // did not create is not a reason to report failure.
    if let Ok(mut local) = repo.find_branch(&branch_name, BranchType::Local) {
        if local.upstream().is_err() {
            let tracking = format!("{remote_name}/{branch_name}");
            if let Err(e) = local.set_upstream(Some(&tracking)) {
                log::warn!("pushed {branch_name} but could not set upstream {tracking}: {e}");
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::testfix::{commit_all, init_repo, write_file};

    /// A local bare repo as the remote: enough to exercise the real push path,
    /// including the server-side non-fast-forward reject.
    #[test]
    fn a_rejected_push_is_an_error_not_a_silent_success() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut init = git2::RepositoryInitOptions::new();
        init.bare(true).initial_head("main");
        git2::Repository::init_opts(remote_dir.path(), &init).unwrap();

        // Repo A pushes one commit.
        let a_dir = tempfile::tempdir().unwrap();
        let a = init_repo(a_dir.path());
        a.set_head("refs/heads/main").unwrap();
        write_file(a_dir.path(), "f.txt", "one\n");
        commit_all(&a, "one");
        a.remote("origin", &remote_dir.path().to_string_lossy())
            .unwrap();
        let a_path = a_dir.path().to_string_lossy().to_string();
        git_push_impl(a_path.clone(), None, None).expect("first push should land");
        assert!(
            a.find_branch("main", BranchType::Local)
                .unwrap()
                .upstream()
                .is_ok(),
            "the first push should leave an upstream so ahead/behind works"
        );

        // Repo B clones, rewrites history, and pushes — a non-fast-forward the
        // remote must reject.
        let b_dir = tempfile::tempdir().unwrap();
        let b = git2::Repository::clone(&remote_dir.path().to_string_lossy(), b_dir.path()).unwrap();
        {
            let mut cfg = b.config().unwrap();
            cfg.set_str("user.name", "Test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        write_file(b_dir.path(), "f.txt", "rewritten\n");
        let tree_oid = {
            let mut index = b.index().unwrap();
            index.add_path(std::path::Path::new("f.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        {
            let tree = b.find_tree(tree_oid).unwrap();
            let sig = git2::Signature::now("Test", "test@example.com").unwrap();
            // A root commit, then force the branch at it: guaranteed
            // non-fast-forward, which is exactly what a real force-push-worthy
            // divergence looks like to the remote.
            let oid = b
                .commit(None, &sig, &sig, "rewrite", &tree, &[])
                .unwrap();
            b.reference("refs/heads/main", oid, true, "rewrite").unwrap();
        }

        let err = git_push_impl(b_dir.path().to_string_lossy().to_string(), None, None)
            .expect_err("a rejected push must not report success");
        // libgit2 catches some non-fast-forwards client-side (it knows the
        // remote-tracking ref) and the server catches the rest; either way this
        // must be an Err, which before the `push_update_reference` callback it
        // was not — the UI showed a green ✓.
        let lowered = err.to_lowercase();
        assert!(
            lowered.contains("rejected") || lowered.contains("fastforward"),
            "got: {err}"
        );
    }

    #[test]
    fn a_detached_head_is_refused_instead_of_pushing_refs_heads_head() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        write_file(dir.path(), "f.txt", "one\n");
        let tip = commit_all(&repo, "one");
        repo.set_head_detached(tip).unwrap();
        repo.remote("origin", "https://example.invalid/x.git").unwrap();

        let err = git_push_impl(dir.path().to_string_lossy().to_string(), None, None).unwrap_err();
        assert!(err.contains("detached"), "got: {err}");
    }
}
