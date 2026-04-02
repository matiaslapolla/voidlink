use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const APP_IGNORE_DIRS: [&str; 9] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    ".idea",
    ".voidlink",
];

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn first_env(names: &[&str]) -> Option<String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

pub(crate) fn first_env_or_default(names: &[&str], default: &str) -> String {
    first_env(names).unwrap_or_else(|| default.to_string())
}

pub(crate) fn default_db_path() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("VOIDLINK_DB_PATH") {
        return Ok(PathBuf::from(raw));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".voidlink")
        .join("voidlink.sqlite3"))
}

pub(crate) fn canonicalize_repo_path(input: &str) -> Result<String, String> {
    let candidate = PathBuf::from(input);
    if !candidate.exists() {
        return Err(format!("Path does not exist: {input}"));
    }
    let canonical = fs::canonicalize(candidate).map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("Repository path must be a directory".to_string());
    }
    Ok(canonical.to_string_lossy().to_string())
}

pub(crate) fn should_ignore_app_path(path: &Path, root: &Path) -> bool {
    let relative = match path.strip_prefix(root) {
        Ok(value) => value,
        Err(_) => return true,
    };
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if APP_IGNORE_DIRS.iter().any(|item| item == &name) {
            return true;
        }
    }
    false
}

pub(crate) fn normalize_relative_path(input: &str) -> String {
    let normalized_input = input.replace('\\', "/");
    let mut parts = Vec::<String>::new();
    for part in normalized_input.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                if !parts.is_empty() {
                    parts.pop();
                }
            }
            _ => parts.push(part.to_string()),
        }
    }
    if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

pub(crate) fn split_relative_path(input: &str) -> Vec<String> {
    let normalized = normalize_relative_path(input);
    if normalized == "." {
        Vec::new()
    } else {
        normalized.split('/').map(|part| part.to_string()).collect()
    }
}

pub(crate) fn parent_rel_path(path: &str) -> String {
    let normalized = normalize_relative_path(path);
    if normalized == "." {
        return ".".to_string();
    }
    let parent = Path::new(&normalized).parent().and_then(|value| value.to_str());
    match parent {
        Some(value) if !value.is_empty() => normalize_relative_path(value),
        _ => ".".to_string(),
    }
}

pub(crate) fn join_relative(base: &str, suffix: &str) -> String {
    if base == "." || base.is_empty() {
        normalize_relative_path(suffix)
    } else {
        normalize_relative_path(&format!("{base}/{suffix}"))
    }
}

pub(crate) fn detect_language(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "kt" => "kotlin",
        "swift" => "swift",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "css" | "scss" => "css",
        "html" | "htm" => "html",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        _ => "text",
    }
    .to_string()
}
