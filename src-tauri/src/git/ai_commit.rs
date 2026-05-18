use std::io::Write;
use std::process::{Command, Stdio};

use super::diff::git_diff_working_impl;
use super::{DiffLine, FileDiff};

/// Shell out to a user-configured CLI (claude, ollama, gh copilot, ...) and
/// ask it to draft a commit message from the staged diff. The diff is written
/// to the child process's stdin; stdout becomes the suggested message.
///
/// This is the BYO-CLI design called for in session-1.md: voidlink has no
/// embedded LLM client, no API keys, no telemetry. Users plug in whatever
/// model they already have configured locally.
///
/// `command_template` is the shell command to run, e.g.:
///   • `claude --no-tools -p "Write a concise git commit message for this diff:"`
///   • `ollama run llama3.2 "Write a concise commit message from this diff:"`
///
/// We split on shell quoting rules (handled by `shell-words`-style logic
/// below — minimal subset, no env expansion). On macOS/Linux the user-
/// configured PATH is preserved via env passthrough.
pub(crate) fn git_ai_generate_commit_impl(
    repo_path: String,
    command_template: String,
) -> Result<String, String> {
    let template = command_template.trim();
    if template.is_empty() {
        return Err(
            "No AI command configured. Set one in Settings → AI (e.g. `claude -p \"…\"`)."
                .to_string(),
        );
    }

    let diff = git_diff_working_impl(repo_path.clone(), true)?;
    if diff.files.is_empty() {
        return Err("No staged changes — stage some files first.".to_string());
    }

    let diff_text = render_diff_for_prompt(&diff.files);

    let argv = split_command(template)
        .map_err(|e| format!("invalid AI command template: {}", e))?;
    if argv.is_empty() {
        return Err("AI command template is empty after parsing.".to_string());
    }

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    cmd.current_dir(&repo_path);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // When Voidlink is launched from Finder/Dock, the Tauri process inherits
    // a minimal env (PATH = /usr/bin:/bin:/usr/sbin:/sbin, no Homebrew, no
    // version-manager shims). User-installed CLIs like `claude` / `ollama`
    // then aren't findable. Mirror the PTY env strategy from lib.rs: ask the
    // user's login shell to run the command via `-lc`, so /etc/zprofile and
    // ~/.zprofile rebuild PATH the same way Terminal.app does. We only do
    // this on Unix; on Windows the inherited env is generally fine.
    let original_argv = argv.clone();
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        // Re-quote our argv into a single shell string. Each argument is
        // single-quoted; any single quote inside is escaped by closing the
        // quote, inserting an escaped quote, and reopening.
        let joined = original_argv
            .iter()
            .map(|a| format!("'{}'", a.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" ");
        cmd = Command::new(shell);
        cmd.args(["-lc", &joined]);
        cmd.current_dir(&repo_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "failed to spawn `{}`: {}. Is it installed and on PATH?",
            original_argv[0], e
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(diff_text.as_bytes())
            .map_err(|e| format!("failed to pipe diff to AI command: {}", e))?;
        // Drop stdin to send EOF.
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("AI command failed: {}", e))?;

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

fn render_diff_for_prompt(files: &[FileDiff]) -> String {
    let mut out = String::new();
    for f in files {
        let path = f.new_path.clone().or_else(|| f.old_path.clone()).unwrap_or_default();
        out.push_str(&format!(
            "--- {} ({}, +{} -{}) ---\n",
            path, f.status, f.additions, f.deletions
        ));
        if f.is_binary {
            out.push_str("[binary file]\n");
            continue;
        }
        for hunk in &f.hunks {
            out.push_str(&hunk.header);
            out.push('\n');
            for line in &hunk.lines {
                push_diff_line(&mut out, line);
            }
        }
        out.push('\n');
    }
    out
}

fn push_diff_line(out: &mut String, line: &DiffLine) {
    let prefix = match line.origin.as_str() {
        "+" => '+',
        "-" => '-',
        _ => ' ',
    };
    out.push(prefix);
    out.push_str(&line.content);
    out.push('\n');
}

/// Minimal POSIX-style shell split: handles single and double quotes, no
/// variable expansion, no backslash escaping outside quotes. Enough for the
/// command templates we expect (`claude -p "Write a commit message"`).
fn split_command(input: &str) -> Result<Vec<String>, &'static str> {
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
