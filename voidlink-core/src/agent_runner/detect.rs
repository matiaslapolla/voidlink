/// Returns the names of CLI agent tools found in PATH.
/// Checks for: claude (Claude Code), codex (OpenAI Codex), opencode (OpenCode).
pub fn detect_tools() -> Vec<String> {
    ["claude", "codex", "opencode"]
        .iter()
        .filter(|&&bin| which(bin))
        .map(|&s| s.to_string())
        .collect()
}

fn which(bin: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {bin}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}
