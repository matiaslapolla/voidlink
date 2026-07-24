use super::cli::run_cli;
use crate::secrets::SecretBinding;

/// Workspace-grounded repo agent (thin slice of session-1.md Massive #1).
///
/// The *frontend* assembles `prompt` from live workspace state — current
/// branch, status, recent log, staged diff, open files — using the same
/// commands the UI renders from, and shows the user exactly which sources
/// went in (the audit list). The backend's only job is to pipe that prompt
/// to the user's configured BYO-CLI and return the answer. No embedded
/// model, no telemetry: identical trust model to AI commit drafting, sharing
/// the same `run_cli` adapter — including optional keychain-stored provider
/// keys injected into the child's environment via `secret_bindings`.
pub(crate) fn git_agent_query_impl(
    repo_path: String,
    command_template: String,
    prompt: String,
    secret_bindings: Vec<SecretBinding>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Empty prompt.".to_string());
    }
    run_cli(&repo_path, command_template.trim(), &prompt, &secret_bindings)
}
