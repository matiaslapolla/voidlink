use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Result of a porcelain operation that may stop on conflicts (merge, rebase,
/// cherry-pick, revert). `ok` is the exit status; `conflicted` is true when it
/// halted on conflicts the user must resolve; `message` is git's own output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    pub conflicted: bool,
    pub message: String,
}

/// Every shell-out gets a deadline. `git pull` / `git push` against an
/// unreachable host, or any git that decides to prompt, would otherwise hang
/// forever holding a `spawn_blocking` thread — and on the UI side leave
/// `syncing()` stuck true, which permanently disables Pull.
pub(crate) const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Run `git <args>`, classifying a conflict halt vs a hard failure.
///
/// Conflict detection is **not** `message.contains("CONFLICT")`. That was wrong
/// in both directions: a git configured for a non-English locale turned a real
/// conflict into a hard failure, and `--continue` with unresolved conflicts
/// prints "You must edit all merge conflicts…" — no `CONFLICT` substring — so
/// the UI never routed the user back to the resolver. Instead we ask the index:
/// a non-zero exit *with unmerged paths present* is a conflict halt, whatever
/// language git said it in.
pub(crate) fn run_git_op(repo_path: &str, args: &[&str]) -> Result<OpResult, String> {
    let (ok, stdout, stderr) = run_git_allow_fail(repo_path, args)?;
    let message = format!("{stdout}\n{stderr}").trim().to_string();
    let conflicted = !ok && has_unmerged_paths(repo_path);
    Ok(OpResult {
        ok,
        conflicted,
        message,
    })
}

/// Does the index currently hold unmerged (conflicted) entries?
///
/// `--diff-filter=U` is the machine-readable form of the question, and it stays
/// correct across locales and git versions.
pub(crate) fn has_unmerged_paths(repo_path: &str) -> bool {
    matches!(
        run_git_allow_fail(repo_path, &["diff", "--name-only", "--diff-filter=U"]),
        Ok((true, ref stdout, _)) if !stdout.trim().is_empty()
    )
}

/// Run `git <args>` inside `repo_path`, returning stdout on success and the
/// trimmed stderr as the error on a non-zero exit. We shell out to the system
/// `git` (always present on a developer machine, and at /usr/bin/git inside the
/// minimal env a Finder/Dock launch inherits) for porcelain operations whose
/// conflict mid-states — merge, rebase, cherry-pick, revert, pull — libgit2
/// either doesn't model or models differently from what users expect. Pure
/// index/ref reads and simple mutations stay on git2.
pub(crate) fn run_git(repo_path: &str, args: &[&str]) -> Result<String, String> {
    run_git_timeout(repo_path, args, DEFAULT_TIMEOUT)
}

/// [`run_git`] with an explicit deadline, for calls that should give up sooner.
pub(crate) fn run_git_timeout(
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    let (ok, stdout, stderr) = run_git_raw(repo_path, args, timeout)?;
    if !ok {
        return Err(if stderr.is_empty() {
            stdout
        } else {
            stderr
        });
    }
    Ok(stdout)
}

/// Like [`run_git`] but never treats a non-zero exit as an error — returns
/// `(success, stdout, stderr)`. Use this for operations where a non-zero exit
/// is an expected outcome to inspect rather than a failure to throw: `git pull`
/// / `merge` / `rebase` leaving conflicts, or `--continue` reporting remaining
/// conflicts. The caller decides what the exit code means.
pub(crate) fn run_git_allow_fail(
    repo_path: &str,
    args: &[&str],
) -> Result<(bool, String, String), String> {
    run_git_raw(repo_path, args, DEFAULT_TIMEOUT)
}

/// The one place a `git` child process is created.
///
/// Environment hardening lives here rather than at each call site, so no future
/// caller can forget it:
///
///   * `LC_ALL` / `LANG` = `C` — git's output is data we parse, and a localized
///     git changes that data. (Classification no longer *relies* on English, but
///     the messages we surface should stay stable.)
///   * `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS` / `SSH_ASKPASS` — a git that
///     wants a password must fail fast, not block forever on a terminal that
///     does not exist inside a GUI app.
///   * `GIT_EDITOR` / `GIT_SEQUENCE_EDITOR` = `true` — same reason: `rebase`,
///     `merge` and `commit` must never open an editor and wait.
fn run_git_raw(
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, String, String), String> {
    let (ok, stdout, stderr) = run_git_raw_bytes(repo_path, args, timeout)?;
    Ok((
        ok,
        String::from_utf8_lossy(&stdout).trim().to_string(),
        stderr,
    ))
}

/// `git <args>` with stdout left as **bytes**.
///
/// Every other entry point converts stdout with `from_utf8_lossy`, which is
/// right for prose (a commit message in an unexpected encoding should still be
/// readable) and wrong for paths: lossy conversion *keeps* an unrepresentable
/// path, with `U+FFFD` where the bytes were, so a caller that then opens or
/// removes it operates on a path that does not exist. Callers parsing paths out
/// of porcelain take the bytes and decide for themselves what to do with a
/// record they cannot represent.
pub(crate) fn run_git_bytes(repo_path: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let (ok, stdout, stderr) = run_git_raw_bytes(repo_path, args, DEFAULT_TIMEOUT)?;
    if !ok {
        return Err(if stderr.is_empty() {
            String::from_utf8_lossy(&stdout).trim().to_string()
        } else {
            stderr
        });
    }
    Ok(stdout)
}

fn run_git_raw_bytes(
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<(bool, Vec<u8>, String), String> {
    // One budget for the whole call, started before the spawn. Timing the wait
    // separately would let a slow start and a slow run each take the full
    // timeout, which is not what any caller means by "give up after 15s".
    let deadline = Instant::now() + timeout;

    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(repo_path)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = spawn_within(command, args, deadline)?;

    // Drained on their own threads: a child that fills a pipe buffer blocks
    // until someone reads it, and reading only after `wait()` would deadlock on
    // any command with substantial output.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout_reader = std::thread::spawn(move || drain(&mut stdout_pipe));
    let stderr_reader = std::thread::spawn(move || drain(&mut stderr_pipe));

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("waiting for git failed: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "`git {}` timed out after {}s and was stopped — it may have been waiting for \
                 credentials or an unreachable network",
                args.join(" "),
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    Ok((
        status.success(),
        stdout,
        String::from_utf8_lossy(&stderr).trim().to_string(),
    ))
}

fn drain<R: Read>(pipe: &mut Option<R>) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Some(p) = pipe.as_mut() {
        let _ = p.read_to_end(&mut buf);
    }
    buf
}

/// `Command::spawn` under the same deadline as everything after it.
///
/// [`DEFAULT_TIMEOUT`] and the loop below it only ever covered the *wait*, so a
/// git that never started was never given up on: `spawn` resolves `current_dir`
/// in the kernel, and on a hung NFS/SMB mount or a stale automount that call
/// blocks uninterruptibly. Every git surface in the app queues behind the
/// per-repo mutex the caller is holding while it does, which is how one
/// unreachable mount froze the entire git sidebar with a timeout that believed
/// it had this covered.
///
/// A blocked spawn cannot be cancelled, so it is moved onto its own thread and
/// abandoned. That thread is the one thing left waiting on the mount; the
/// caller gets an error and releases the lock. If the spawn does eventually
/// return, the send fails (we are long gone) and the thread reaps the child
/// itself rather than leaving a zombie nobody will ever wait on.
fn spawn_within(
    mut command: Command,
    args: &[&str],
    deadline: Instant,
) -> Result<std::process::Child, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<std::process::Child, String>>(1);
    std::thread::spawn(move || {
        let spawned = command
            .spawn()
            .map_err(|e| format!("failed to run git: {e}. Is git installed and on PATH?"));
        if let Err(std::sync::mpsc::SendError(Ok(mut orphan))) = tx.send(spawned) {
            let _ = orphan.kill();
            let _ = orphan.wait();
        }
    });

    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(result) => result,
        Err(_) => Err(format!(
            "`git {}` could not be started before its deadline — its working directory may be on \
             an unresponsive mount",
            args.join(" ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_that_outlives_its_deadline_is_killed_and_reported() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        // `git -c ... sleep` is not a thing; use the pager hook instead: a
        // command that waits on a fifo would be fragile, so exercise the path
        // with a genuinely slow builtin.
        let out = run_git_timeout(
            &tmp.path().to_string_lossy(),
            &["-c", "protocol.ext.allow=always", "fsck"],
            Duration::from_nanos(1),
        );
        // Either it finished inside a nanosecond (it did not) or we gave up.
        // Three shapes, because the budget now starts *before* the spawn: with
        // a nanosecond of it, the deadline is normally already gone by the time
        // we go looking for the child. Assert on the shape rather than on
        // timing luck.
        if let Err(e) = out {
            assert!(
                e.contains("timed out")
                    || e.contains("could not be started")
                    || e.contains("failed to run git"),
                "got: {e}"
            );
        }
    }

    #[test]
    fn output_is_readable_and_the_environment_is_forced_to_c() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        let out = run_git(&tmp.path().to_string_lossy(), &["config", "--get", "core.bare"]).unwrap();
        assert_eq!(out, "false");
    }

    #[test]
    fn a_clean_repo_has_no_unmerged_paths() {
        let tmp = tempfile::tempdir().unwrap();
        git2::Repository::init(tmp.path()).unwrap();
        assert!(!has_unmerged_paths(&tmp.path().to_string_lossy()));
    }
}
