use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

use crate::secrets::SecretBinding;

/// A spawn-ready BYO-CLI invocation, plus the argv it was parsed from.
///
/// `argv` is the *template's* argv, not the child's: on unix `cmd` is a login
/// shell wrapping it (see [`build_cli_command`]), so `argv[0]` is the only
/// thing left that names the binary the user actually asked for. Error
/// messages quote it, because "failed to spawn `/bin/zsh`" tells a user
/// nothing about the `claude` they mistyped.
pub(crate) struct BuiltCli {
    pub cmd: Command,
    pub argv: Vec<String>,
}

/// Turn a command template into a configured, unspawned [`Command`].
///
/// This is the single place that knows how a BYO-CLI child is assembled — the
/// login-shell re-exec and the keychain secret injection both live here and
/// nowhere else. Every caller (the one-shot [`run_cli`] and the streaming
/// agent turn in [`crate::agent`]) spawns whatever this returns, unmodified
/// apart from platform lifecycle flags. Duplicating either half would drift
/// into the worst class of bug this app has: works when launched from a
/// terminal, broken when launched from the Dock.
///
/// `command_template` is a shell command string, e.g.
///   • `claude --no-tools -p "Answer the question about this repo:"`
///   • `ollama run llama3.2`
///
/// `secret_bindings` names keychain-stored provider keys and the environment
/// variables to export them as. This is the *only* place a stored secret is
/// read; the value goes straight into the child's environment and is never
/// returned, logged, or sent to the frontend. Injection is additive — see
/// [`crate::secrets::merge_env`] for the precedence rule.
pub(crate) fn build_cli_command(
    repo_path: &str,
    command_template: &str,
    secret_bindings: &[SecretBinding],
) -> Result<BuiltCli, String> {
    let template = command_template.trim();
    if template.is_empty() {
        return Err("No AI command configured.".to_string());
    }

    let argv = split_command(template).map_err(|e| format!("invalid AI command template: {e}"))?;
    if argv.is_empty() {
        return Err("AI command template is empty after parsing.".to_string());
    }

    // When launched from Finder/Dock, the Tauri process inherits a minimal
    // env (no Homebrew, no version-manager shims), so user CLIs like `claude`
    // aren't findable. Re-run through the login shell so /etc/zprofile and
    // ~/.zprofile rebuild PATH the way Terminal.app does. Unix only; on
    // Windows the inherited env is generally fine.
    #[cfg(unix)]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let joined = argv
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ");
        let mut cmd = Command::new(shell);
        cmd.args(["-lc", &joined]);
        cmd
    };
    #[cfg(not(unix))]
    let mut cmd = {
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..]);
        cmd
    };

    cmd.current_dir(repo_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // ── Secret injection ──────────────────────────────────────────────────
    // Applied last so it lands on whichever `cmd` we ended up with (the direct
    // spawn, or the login-shell wrapper above). Resolving can fail hard — a
    // locked or denied keychain aborts the AI action rather than quietly
    // running the CLI unauthenticated.
    //
    // Precedence: anything this process already exports wins here, and on unix
    // the login shell sources the user's profile *after* inheriting what we
    // set, so an `export ANTHROPIC_API_KEY=…` in ~/.zprofile wins too. Either
    // way the user's own configuration is never overridden — voidlink's stored
    // key is only ever the fallback.
    let resolved = crate::secrets::resolve_bindings(secret_bindings)?;
    if !resolved.is_empty() {
        let inherited: HashMap<String, String> = std::env::vars().collect();
        for (name, value) in crate::secrets::merge_env(&inherited, &resolved) {
            cmd.env(name, value);
        }
    }

    Ok(BuiltCli { cmd, argv })
}

/// The message a failed spawn produces. Shared so the one-shot and streaming
/// paths report an uninstalled CLI identically — this is the error users hit
/// most often, and it is the one that has to name the binary.
pub(crate) fn spawn_error(argv0: &str, e: std::io::Error) -> String {
    format!("failed to spawn `{argv0}`: {e}. Is it installed and on PATH?")
}

/// Shared BYO-CLI runner. VoidLink never embeds an LLM client — it shells out
/// to whatever generative-text command the user already has (`claude`,
/// `ollama`, `gh copilot`, …), piping `stdin_text` to the child and returning
/// its stdout.
///
/// This is the *one-shot* path: it blocks until the child exits and hands back
/// the whole answer, which is what AI commit drafting wants (there is nothing
/// to show until the message is complete). A turn the user watches arrive
/// belongs on [`crate::agent::agent_stream_query`] instead; both build their
/// child with [`build_cli_command`], so they cannot disagree about how it is
/// spawned.
pub(crate) fn run_cli(
    repo_path: &str,
    command_template: &str,
    stdin_text: &str,
    secret_bindings: &[SecretBinding],
) -> Result<String, String> {
    let BuiltCli { mut cmd, argv } =
        build_cli_command(repo_path, command_template, secret_bindings)?;

    let mut child = cmd.spawn().map_err(|e| spawn_error(&argv[0], e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(stdin_text.as_bytes())
            .map_err(|e| format!("failed to pipe input to AI command: {e}"))?;
        // Drop stdin to send EOF.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("AI command failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "AI command exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return Err("AI command returned empty output.".to_string());
    }
    Ok(trimmed.to_string())
}

/// Minimal POSIX-style shell split: handles single and double quotes, no
/// variable expansion, no backslash escaping outside quotes. Enough for the
/// command templates we expect (`claude -p "Write a commit message"`).
pub(crate) fn split_command(input: &str) -> Result<Vec<String>, &'static str> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_token = false;

    for ch in input.chars() {
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
            } else {
                cur.push(ch);
            }
            continue;
        }
        match ch {
            '\'' => {
                in_single = true;
                in_token = true;
            }
            '"' => {
                in_double = true;
                in_token = true;
            }
            c if c.is_whitespace() => {
                if in_token {
                    out.push(std::mem::take(&mut cur));
                    in_token = false;
                }
            }
            c => {
                cur.push(c);
                in_token = true;
            }
        }
    }
    if in_single || in_double {
        return Err("unterminated quote");
    }
    if in_token {
        out.push(cur);
    }
    Ok(out)
}
