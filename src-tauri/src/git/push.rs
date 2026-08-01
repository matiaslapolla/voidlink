use std::cell::RefCell;
use std::rc::Rc;

use git2::{
    BranchType, ErrorClass, ErrorCode, FetchOptions, FetchPrune, Oid, PushOptions, Repository,
};
use serde::{Deserialize, Serialize};

use super::auth::{default_remote_callbacks, AUTH_EXHAUSTED_MESSAGE};
use super::repo::open_repo;

/// Why a push did not land.
///
/// This exists for one reason: the force-push recovery affordance is offered
/// for `NonFastForward` and for nothing else. A push that failed because the
/// user's token expired, because the network is down, or because a pre-receive
/// hook said no is not a push that force would fix — offering force there would
/// teach people to reach for it whenever a push goes red, which is precisely
/// the habit the whole design is arranged to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PushFailure {
    /// The remote's branch carries commits this branch does not contain. The
    /// only class force-push can resolve.
    NonFastForward,
    /// Credentials were refused or never found.
    Auth,
    /// Network, missing remote, hook rejection, ref lock — anything where the
    /// remedy is not "overwrite the remote".
    Other,
}

/// The verdict on one push, as the UI needs it.
///
/// `git_push` used to answer `Result<(), String>`, which collapsed every way a
/// push can fail into one red line of prose. The recovery affordance has to
/// distinguish them, and it cannot do that by reading the prose.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub ok: bool,
    /// `None` exactly when `ok`.
    pub failure: Option<PushFailure>,
    /// git's own words, shown as-is. Empty on success.
    pub message: String,
    /// The remote and branch actually pushed to, after defaulting. The recovery
    /// UI names both in its confirm, and it must name what was *used*, not what
    /// the caller happened to pass (which is usually nothing).
    pub remote: String,
    pub branch: String,
}

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
) -> Result<PushOutcome, String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin").to_string();
    let branch_name = resolve_branch(&repo, branch)?;

    let refspec = format!("refs/heads/{branch_name}:refs/heads/{branch_name}");

    let failed = |failure: PushFailure, message: String| {
        Ok(PushOutcome {
            ok: false,
            failure: Some(failure),
            message,
            remote: remote_name.clone(),
            branch: branch_name.clone(),
        })
    };

    let mut remote_obj = match repo.find_remote(&remote_name) {
        Ok(r) => r,
        // A remote that is not configured is `Other`: nothing about it is fixed
        // by overwriting a branch on a remote that does not exist.
        Err(e) => return failed(PushFailure::Other, format!("remote '{remote_name}': {}", e.message())),
    };

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

    if let Err(e) = remote_obj.push(&[&refspec], Some(&mut push_opts)) {
        return failed(classify_push_error(&e), e.message().to_string());
    }

    let rejected = rejections.borrow().clone();
    if !rejected.is_empty() {
        // Every rejected ref gets a vote, and any one of them saying
        // non-fast-forward is enough — we push a single refspec, so in practice
        // there is exactly one.
        let kind = if rejected
            .iter()
            .any(|r| classify_reject_reason(r) == PushFailure::NonFastForward)
        {
            PushFailure::NonFastForward
        } else {
            PushFailure::Other
        };
        return failed(
            kind,
            format!("{remote_name} rejected the push — {}", rejected.join("; ")),
        );
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

    Ok(PushOutcome {
        ok: true,
        failure: None,
        message: String::new(),
        remote: remote_name,
        branch: branch_name,
    })
}

/// The branch a push acts on: the caller's, or HEAD's.
///
/// Kept out of the push bodies because both the ordinary push and the
/// force-with-lease push need the identical answer, and a force-push that
/// resolved the branch even slightly differently from the push that was just
/// rejected would overwrite a ref the user was never shown.
fn resolve_branch(repo: &Repository, branch: Option<String>) -> Result<String, String> {
    if let Some(b) = branch {
        return Ok(b);
    }
    if repo.head_detached().unwrap_or(false) {
        return Err("HEAD is detached — check out a branch (or pick one) before pushing".to_string());
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
    Ok(head
        .shorthand()
        .ok_or_else(|| "could not read the current branch name".to_string())?
        .to_string())
}

/// Classify an error libgit2 raised itself, before or instead of the server.
///
/// `NotFastForward` is a libgit2 *error code*, not prose: it is set when
/// libgit2 checks fast-forwardability against the remote-tracking ref it
/// already has and refuses before uploading a pack. Switching on the code
/// cannot over-match the way reading a message can.
fn classify_push_error(e: &git2::Error) -> PushFailure {
    match e.code() {
        ErrorCode::NotFastForward => PushFailure::NonFastForward,
        ErrorCode::Auth => PushFailure::Auth,
        // An error raised *inside* our credential callback comes back with a
        // generic code and class `Callback`, so the message is the only thing
        // left to recognise it by — and it is our own constant, not the
        // server's prose. Anything we cannot place is `Other`, which is the
        // safe direction: it withholds force rather than offering it.
        _ if e.class() == ErrorClass::Callback && e.message().contains(AUTH_EXHAUSTED_MESSAGE) => {
            PushFailure::Auth
        }
        _ => PushFailure::Other,
    }
}

/// Classify a rejection the *server* wrote.
///
/// There is no code here — `push_update_reference` hands us whatever
/// receive-pack chose to say, which is prose, and prose is exactly what a
/// classifier should not lean on. So the match is deliberately narrow: only the
/// two phrases every git server uses for a diverged ref, with separators
/// stripped so "non-fast-forward", "non fast forward" and libgit2's own
/// "non-fastforwardable" all land the same way.
///
/// What is *not* matched matters more than what is. "failed to update ref" is a
/// lock contention or a hook; "pre-receive hook declined" is a policy; "you are
/// not allowed to push" is permissions. None of those are fixed by forcing, and
/// a looser match — anything containing "reject", say — would offer force for
/// all three.
fn classify_reject_reason(reason: &str) -> PushFailure {
    let squashed: String = reason
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if squashed.contains("nonfastforward") || squashed.contains("fetchfirst") {
        PushFailure::NonFastForward
    } else {
        PushFailure::Other
    }
}

/// The oid of `refs/remotes/<remote>/<branch>`, or `None` when there is no such
/// tracking ref. This is the value a push lease is taken *on*: it records what
/// the last fetch said the remote was holding.
pub(crate) fn git_remote_tracking_oid_impl(
    repo_path: String,
    remote: String,
    branch: String,
) -> Result<Option<String>, String> {
    let repo = open_repo(&repo_path)?;
    let oid = match repo.find_branch(&format!("{remote}/{branch}"), BranchType::Remote) {
        Ok(b) => b.get().target(),
        Err(e) if e.code() == ErrorCode::NotFound => None,
        Err(e) => return Err(e.message().to_string()),
    };
    Ok(oid.map(|oid| oid.to_string()))
}

/// Force-push one branch, but only if the remote is still where the lease says.
///
/// **libgit2 has no `--force-with-lease`.** Native git puts the expected old oid
/// inside the ref-update line it sends, so the *server* performs the
/// compare-and-swap and the guarantee is total: there is no window at all.
/// libgit2's push API gives no way to set that field, so the comparison has to
/// happen on this side of the wire — and once it does, there is a window, and no
/// amount of care closes it. What follows is how small it is made and what
/// exactly remains open, because a lease whose limits are not written down
/// eventually gets described as "safe" by somebody reading the function name.
///
/// The sequence:
///
///   1. **Re-read the remote for real** — a fetch of this one branch. Comparing
///      against `refs/remotes/<r>/<b>` as we already hold it would prove nothing
///      except that we have not fetched; the whole hazard is that the ref is
///      stale. The fetch is also the reason a refusal leaves the UI *correct*:
///      ahead/behind now reflects the remote that moved, rather than the stale
///      value that produced the refusal.
///   2. **Compare** that freshly-fetched tip against the lease, and refuse on any
///      difference — including the branch having disappeared.
///   3. **Push**, forced.
///
/// What remains open: from the instant the fetch's ref advertisement was written
/// to the instant receive-pack applies our update. That is one fetch round trip
/// plus the push connection and its round trip — a fraction of a second on a
/// normal remote, but not zero. A push landing on the remote inside that
/// interval is overwritten and this code cannot know. Nothing in the UI says
/// "safe" for exactly this reason.
///
/// The advertisement is read through a fetch rather than `Remote::list()`
/// deliberately: `list()` in git2 0.19 builds a slice from the null pointer
/// libgit2 hands back when a remote advertises no refs at all, which aborts the
/// process under debug assertions. A safety check that can crash is not a safety
/// check. `Remote::fetch` goes straight to C and has no such hole.
///
/// `expected_remote_oid` must parse. A lease on a branch we have never seen on
/// the remote is not a lease, and refusing here is what forces the caller to
/// have fetched.
pub(crate) fn git_push_force_with_lease_impl(
    repo_path: String,
    remote: Option<String>,
    branch: Option<String>,
    expected_remote_oid: String,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let remote_name = remote.as_deref().unwrap_or("origin").to_string();
    let branch_name = resolve_branch(&repo, branch)?;

    let expected = Oid::from_str(expected_remote_oid.trim())
        .map_err(|_| "No lease was taken — fetch first, then force-push".to_string())?;

    let refname = format!("refs/heads/{branch_name}");
    let mut remote_obj = repo
        .find_remote(&remote_name)
        .map_err(|e| format!("remote '{remote_name}': {}", e.message()))?;

    // Pruning is what turns "the branch was deleted on the remote" into an
    // absent tracking ref rather than a stale one that still matches the lease.
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(default_remote_callbacks());
    fetch_opts.prune(FetchPrune::On);
    let tracking = format!("refs/remotes/{remote_name}/{branch_name}");
    let fetch_spec = format!("+{refname}:{tracking}");
    remote_obj
        .fetch(&[&fetch_spec], Some(&mut fetch_opts), None)
        .map_err(|e| format!("could not re-check {remote_name} before forcing: {}", e.message()))?;

    let actual = repo
        .find_reference(&tracking)
        .ok()
        .and_then(|r| r.target());

    match actual {
        // Refusing is the feature working, not a fault in it: the branch we were
        // about to overwrite is not the branch the user looked at.
        None => {
            return Err(format!(
                "Refused: {remote_name} no longer has a branch named {branch_name}. It was deleted or renamed since the fetch, so the lease cannot be honoured. Fetch again and look before forcing."
            ))
        }
        Some(actual) if actual != expected => {
            return Err(format!(
                "Refused: {remote_name}/{branch_name} moved after the fetch. The lease was taken on {} and the remote is now at {} — someone pushed in between. Fetch again and read what changed before forcing.",
                short(&expected),
                short(&actual),
            ))
        }
        Some(_) => {}
    }

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

    // The leading `+` is the force. The callback is registered for the same
    // reason the ordinary push registers one: libgit2 returns `Ok` when the
    // transport succeeded and the server rejected every ref.
    let refspec = format!("+{refname}:{refname}");
    remote_obj
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| e.message().to_string())?;

    let rejected = rejections.borrow().clone();
    if !rejected.is_empty() {
        return Err(format!(
            "{remote_name} rejected the force-push — {}",
            rejected.join("; ")
        ));
    }
    Ok(())
}

fn short(oid: &Oid) -> String {
    oid.to_string().chars().take(7).collect()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::fetch::git_fetch_impl;
    use crate::git::testfix::{commit_all, init_repo, write_file};
    use std::path::Path;

    /// A bare repository standing in for the server. Local, but there is a real
    /// `receive-pack` on the far end of a real transport, so the rejects and the
    /// ref advertisement the lease reads are the genuine article rather than a
    /// mock's idea of one.
    fn bare_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut init = git2::RepositoryInitOptions::new();
        init.bare(true).initial_head("main");
        git2::Repository::init_opts(dir.path(), &init).unwrap();
        dir
    }

    fn path_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    fn identify(repo: &git2::Repository) {
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "Test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
    }

    /// A working repo on `main` wired to `remote`, with one commit already
    /// pushed — so it has a remote-tracking ref, which is what a lease is taken
    /// on.
    fn author_repo(remote: &tempfile::TempDir) -> (tempfile::TempDir, git2::Repository) {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        repo.set_head("refs/heads/main").unwrap();
        write_file(dir.path(), "f.txt", "one\n");
        commit_all(&repo, "one");
        repo.remote("origin", &remote.path().to_string_lossy())
            .unwrap();
        let out = git_push_impl(path_of(&dir), None, None).unwrap();
        assert!(out.ok, "first push should land: {}", out.message);
        (dir, repo)
    }

    /// Somebody else pushes a commit while we are not looking. Kept as its own
    /// repo rather than poking the bare repo's refs directly, because "the
    /// remote moved" only means anything if it moved the way a push moves it.
    fn third_party_push(remote: &tempfile::TempDir) -> git2::Oid {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::clone(&remote.path().to_string_lossy(), dir.path()).unwrap();
        identify(&repo);
        write_file(dir.path(), "theirs.txt", "theirs\n");
        let oid = commit_all(&repo, "theirs");
        let out = git_push_impl(path_of(&dir), None, Some("main".into())).unwrap();
        assert!(out.ok, "a fast-forward push should land: {}", out.message);
        // The TempDir has to outlive the push, hence the explicit drop.
        drop(dir);
        oid
    }

    fn tracking_oid(repo_dir: &tempfile::TempDir) -> String {
        git_remote_tracking_oid_impl(path_of(repo_dir), "origin".into(), "main".into())
            .unwrap()
            .expect("a branch that has been pushed has a tracking ref")
    }

    fn remote_main(remote: &tempfile::TempDir) -> git2::Oid {
        git2::Repository::open(remote.path())
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap()
    }

    /// Move `main` onto a fresh root commit: guaranteed non-fast-forward, which
    /// is what a rebase or an amend looks like from the remote's side.
    fn rewrite_main(dir: &tempfile::TempDir, repo: &git2::Repository, contents: &str) -> git2::Oid {
        write_file(dir.path(), "f.txt", contents);
        let tree_oid = {
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("f.txt")).unwrap();
            index.write().unwrap();
            index.write_tree().unwrap()
        };
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let oid = repo
            .commit(None, &sig, &sig, "rewrite", &tree, &[])
            .unwrap();
        repo.reference("refs/heads/main", oid, true, "rewrite")
            .unwrap();
        oid
    }

    // ── Classification ──────────────────────────────────────────────────────

    #[test]
    fn a_rejected_push_is_a_failure_not_a_silent_success_and_is_named_non_fast_forward() {
        let remote = bare_remote();
        let (a_dir, a) = author_repo(&remote);
        assert!(
            a.find_branch("main", BranchType::Local)
                .unwrap()
                .upstream()
                .is_ok(),
            "the first push should leave an upstream so ahead/behind works"
        );

        rewrite_main(&a_dir, &a, "rewritten\n");
        let out = git_push_impl(path_of(&a_dir), None, None).unwrap();

        // Before the `push_update_reference` callback this reported success and
        // the UI drew a green tick. Now it not only fails, it says *why* — the
        // recovery affordance keys off exactly this field.
        assert!(!out.ok, "a rejected push must not report success");
        assert_eq!(out.failure, Some(PushFailure::NonFastForward), "{}", out.message);
        assert_eq!(out.remote, "origin");
        assert_eq!(out.branch, "main");
    }

    /// The constraint force-push recovery hangs on: everything that is not a
    /// divergence must stay out of the `NonFastForward` bucket, because that
    /// bucket is the only thing standing between the user and a force button.
    #[test]
    fn a_remote_that_is_not_configured_is_not_a_divergence() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        repo.set_head("refs/heads/main").unwrap();
        write_file(dir.path(), "f.txt", "one\n");
        commit_all(&repo, "one");

        let out = git_push_impl(path_of(&dir), None, None).unwrap();
        assert!(!out.ok);
        assert_eq!(out.failure, Some(PushFailure::Other), "{}", out.message);
    }

    #[test]
    fn a_transport_failure_is_not_a_divergence() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        repo.set_head("refs/heads/main").unwrap();
        write_file(dir.path(), "f.txt", "one\n");
        commit_all(&repo, "one");
        // A path that does not exist: a transport error, with no network and no
        // DNS involved, so the test is neither slow nor flaky.
        repo.remote("origin", &dir.path().join("no-such-remote.git").to_string_lossy())
            .unwrap();

        let out = git_push_impl(path_of(&dir), None, None).unwrap();
        assert!(!out.ok);
        assert_eq!(out.failure, Some(PushFailure::Other), "{}", out.message);
    }

    #[test]
    fn a_detached_head_is_refused_instead_of_pushing_refs_heads_head() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(dir.path());
        write_file(dir.path(), "f.txt", "one\n");
        let tip = commit_all(&repo, "one");
        repo.set_head_detached(tip).unwrap();
        repo.remote("origin", "https://example.invalid/x.git").unwrap();

        let err = git_push_impl(path_of(&dir), None, None).unwrap_err();
        assert!(err.contains("detached"), "got: {err}");
    }

    /// libgit2 catches the divergences it can see locally, so the server-side
    /// path is hard to reach from a local bare remote — but it is the path a
    /// real GitHub reject takes, so its classifier is tested directly. The
    /// negatives are the point: each of them is a real receive-pack message
    /// that a looser match would have handed a force button.
    #[test]
    fn the_server_reject_classifier_matches_divergence_and_nothing_else() {
        for reason in [
            "non-fast-forward",
            "non fast forward",
            "cannot push non-fastforwardable reference",
            "failed to push some refs, fetch first",
        ] {
            assert_eq!(
                classify_reject_reason(reason),
                PushFailure::NonFastForward,
                "{reason}"
            );
        }
        for reason in [
            "pre-receive hook declined",
            "failed to update ref",
            "cannot lock ref 'refs/heads/main'",
            "permission denied to user",
            "the remote end hung up unexpectedly",
            "protected branch update failed",
        ] {
            assert_eq!(classify_reject_reason(reason), PushFailure::Other, "{reason}");
        }
    }

    #[test]
    fn an_exhausted_credential_callback_is_classified_as_auth() {
        let e = git2::Error::new(
            ErrorCode::GenericError,
            ErrorClass::Callback,
            AUTH_EXHAUSTED_MESSAGE,
        );
        assert_eq!(classify_push_error(&e), PushFailure::Auth);
        assert_eq!(
            classify_push_error(&git2::Error::new(
                ErrorCode::NotFastForward,
                ErrorClass::Reference,
                "cannot push non-fastforwardable reference",
            )),
            PushFailure::NonFastForward
        );
    }

    // ── The lease ───────────────────────────────────────────────────────────

    #[test]
    fn a_branch_never_pushed_has_no_lease_to_take() {
        let remote = bare_remote();
        let (a_dir, _a) = author_repo(&remote);
        assert_eq!(
            git_remote_tracking_oid_impl(path_of(&a_dir), "origin".into(), "nope".into()).unwrap(),
            None
        );
        // And without a lease value the force path refuses outright rather than
        // quietly degrading into a plain `--force`.
        let err = git_push_force_with_lease_impl(
            path_of(&a_dir),
            None,
            Some("main".into()),
            String::new(),
        )
        .unwrap_err();
        assert!(err.contains("fetch first"), "got: {err}");
    }

    #[test]
    fn the_lease_holds_and_the_force_lands_when_the_remote_is_where_the_fetch_left_it() {
        let remote = bare_remote();
        let (a_dir, a) = author_repo(&remote);
        let theirs = third_party_push(&remote);

        // A fetches, so the lease records what is actually on the remote —
        // including the commit A is about to destroy.
        git_fetch_impl(path_of(&a_dir), None).unwrap();
        let lease = tracking_oid(&a_dir);
        assert_eq!(lease, theirs.to_string(), "the lease must be the fetched tip");

        let rewritten = rewrite_main(&a_dir, &a, "rewritten\n");
        assert_eq!(
            git_push_impl(path_of(&a_dir), None, None).unwrap().failure,
            Some(PushFailure::NonFastForward),
            "the setup must be a real divergence, or the force proves nothing"
        );

        git_push_force_with_lease_impl(path_of(&a_dir), None, None, lease)
            .expect("the lease holds, so the force should land");
        assert_eq!(remote_main(&remote), rewritten);
    }

    /// The whole feature, in one test: A last looked at the remote before B
    /// pushed, so A's lease is on a commit that is no longer the tip. Forcing
    /// would delete work A has never seen. It is refused, and the refusal says
    /// both oids so the user can go and look at what they nearly discarded.
    #[test]
    fn the_lease_refuses_when_the_remote_moved_after_the_fetch() {
        let remote = bare_remote();
        let (a_dir, a) = author_repo(&remote);
        let stale_lease = tracking_oid(&a_dir);

        let theirs = third_party_push(&remote);
        assert_ne!(stale_lease, theirs.to_string());

        rewrite_main(&a_dir, &a, "rewritten\n");
        let err = git_push_force_with_lease_impl(path_of(&a_dir), None, None, stale_lease.clone())
            .unwrap_err();

        assert!(err.contains("moved after the fetch"), "got: {err}");
        assert!(err.contains(&stale_lease[..7]), "the refusal names the lease: {err}");
        assert!(
            err.contains(&theirs.to_string()[..7]),
            "the refusal names where the remote actually is: {err}"
        );
        assert_eq!(
            remote_main(&remote),
            theirs,
            "a refused force must leave the remote untouched"
        );
    }

    #[test]
    fn a_lease_on_a_branch_the_remote_no_longer_has_is_refused() {
        let remote = bare_remote();
        let (a_dir, a) = author_repo(&remote);
        let lease = tracking_oid(&a_dir);

        git2::Repository::open(remote.path())
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .delete()
            .unwrap();

        rewrite_main(&a_dir, &a, "rewritten\n");
        let err = git_push_force_with_lease_impl(path_of(&a_dir), None, None, lease).unwrap_err();
        assert!(err.contains("no longer has a branch named main"), "got: {err}");
    }
}
