/// Shell integration scripts embedded at compile time.
/// These emit OSC 133 sequences (prompt marking) and OSC 7 (CWD tracking).

pub const BASH_INTEGRATION: &str = include_str!("bash.sh");
pub const ZSH_INTEGRATION: &str = include_str!("zsh.sh");
pub const FISH_INTEGRATION: &str = include_str!("fish.sh");

/// Returns the appropriate shell integration script for the given shell path,
/// or `None` if the shell isn't recognised.
pub fn integration_for_shell(shell: &str) -> Option<&'static str> {
    let basename = shell.rsplit('/').next().unwrap_or(shell);
    match basename {
        "bash" => Some(BASH_INTEGRATION),
        "zsh" => Some(ZSH_INTEGRATION),
        "fish" => Some(FISH_INTEGRATION),
        _ => None,
    }
}
