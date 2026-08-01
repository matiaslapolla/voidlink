use super::cli::run_cli;
use super::diff::git_diff_working_impl;
use super::{DiffLine, FileDiff};
use crate::secrets::SecretBinding;

/// Shell out to a user-configured CLI (claude, ollama, gh copilot, ...) and
/// ask it to draft a commit message from the staged diff. The diff is written
/// to the child process's stdin; stdout becomes the suggested message.
///
/// This is the BYO-CLI design called for in session-1.md: voidlink has no
/// embedded LLM client and no telemetry. Users plug in whatever model they
/// already have configured locally. Provider keys are optional and, when the
/// user stores one, come from the OS keychain via `secret_bindings` — they are
/// exported into the child's environment and never seen by the frontend.
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
    secret_bindings: Vec<SecretBinding>,
) -> Result<String, String> {
    let template = command_template.trim();
    if template.is_empty() {
        return Err(
            "No AI command configured. Set one in Settings → AI (e.g. `claude -p \"…\"`)."
                .to_string(),
        );
    }

    let diff = git_diff_working_impl(repo_path.clone(), true, false)?;
    if diff.files.is_empty() {
        return Err("No staged changes — stage some files first.".to_string());
    }

    let diff_text = render_diff_for_prompt(&diff.files);
    run_cli(&repo_path, template, &diff_text, &secret_bindings)
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
