use std::process::Command;

#[derive(serde::Serialize, Clone)]
pub struct LspServerInfo {
    pub language: String,
    pub command: String,
    pub args: Vec<String>,
    pub installed: bool,
}

fn is_installed(bin: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {}", bin)])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn lsp_detect_servers_impl() -> Vec<LspServerInfo> {
    let candidates = vec![
        ("typescript", "typescript-language-server", vec!["--stdio"]),
        ("javascript", "typescript-language-server", vec!["--stdio"]),
        ("rust", "rust-analyzer", vec![]),
        ("python", "pyright-langserver", vec!["--stdio"]),
        ("python", "pylsp", vec![]),
        ("go", "gopls", vec!["serve"]),
        ("c", "clangd", vec![]),
        ("cpp", "clangd", vec![]),
    ];

    let mut results: Vec<LspServerInfo> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (language, command, args) in candidates {
        let key = format!("{}:{}", language, command);
        if seen.contains(&key) {
            continue;
        }

        let installed = is_installed(command);

        // For python, skip pylsp if pyright-langserver is already found and installed
        if language == "python" && command == "pylsp" {
            let pyright_key = "python:pyright-langserver".to_string();
            if seen.contains(&pyright_key) {
                if let Some(existing) = results.iter().find(|r| r.language == "python" && r.command == "pyright-langserver") {
                    if existing.installed {
                        seen.insert(key);
                        continue;
                    }
                }
            }
        }

        seen.insert(key);
        results.push(LspServerInfo {
            language: language.to_string(),
            command: command.to_string(),
            args: args.into_iter().map(|s| s.to_string()).collect(),
            installed,
        });
    }

    results
}
