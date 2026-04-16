use reqwest::blocking::Client;
use serde_json::{json, Value};

pub fn parse_github_owner_repo(remote_url: &str) -> Option<(String, String)> {
    let stripped = remote_url.trim_end_matches(".git").trim_end_matches('/');

    if let Some(after_github) = stripped.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = after_github.splitn(2, '/').collect();
        if parts.len() == 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    if let Some(after_colon) = stripped.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = after_colon.splitn(2, '/').collect();
        if parts.len() == 2 {
            return Some((parts[0].to_string(), parts[1].to_string()));
        }
    }

    None
}

#[allow(dead_code)]
fn github_client() -> Option<(Client, String, String, String)> {
    let token = std::env::var("GITHUB_TOKEN").ok()?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .ok()?;
    Some((client, token, String::new(), String::new()))
}

pub fn create_github_pr(
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head_branch: &str,
    base_branch: &str,
    draft: bool,
) -> Result<String, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN environment variable not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("https://api.github.com/repos/{}/{}/pulls", owner, repo);
    let payload = json!({
        "title": title,
        "body": body,
        "head": head_branch,
        "base": base_branch,
        "draft": draft,
    });

    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .json(&payload)
        .send()
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let body_text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API error {}: {}", status, body_text));
    }

    let parsed: Value = serde_json::from_str(&body_text).map_err(|e| e.to_string())?;
    parsed["html_url"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "PR created but no URL returned".to_string())
}

/// Submit a PR given just a repo path (looks up the `origin` remote, parses
/// owner/repo, then delegates to `create_github_pr`). Phase 7E split: the
/// egui app calls this directly so it doesn't need its own `git2` dep.
pub fn submit_pr_by_repo(
    repo_path: &str,
    title: &str,
    body: &str,
    head_branch: &str,
    base_branch: &str,
    draft: bool,
) -> Result<String, String> {
    let repo = git2::Repository::discover(repo_path).map_err(|e| e.message().to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?;
    let url = remote
        .url()
        .ok_or_else(|| "remote origin has no URL".to_string())?;
    let (owner, repo_name) = parse_github_owner_repo(url)
        .ok_or_else(|| format!("could not parse GitHub owner/repo from: {}", url))?;
    create_github_pr(&owner, &repo_name, title, body, head_branch, base_branch, draft)
}
