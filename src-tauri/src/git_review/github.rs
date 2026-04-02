use reqwest::blocking::Client;
use serde_json::Value;

use crate::git_agent::parse_github_owner_repo;

use super::PullRequestInfo;

pub(super) fn github_api_get(url: &str) -> Result<Value, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .send()
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API {}: {}", status, body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub(super) fn github_api_put(url: &str, payload: &Value) -> Result<Value, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .put(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .json(payload)
        .send()
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub API {}: {}", status, body));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

pub(super) fn github_api_delete(url: &str) -> Result<(), String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN not set".to_string())?;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .delete(url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "VoidLink/1.0")
        .send()
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("delete failed: {}", body));
    }
    Ok(())
}

pub(super) fn get_owner_repo_from_path(repo_path: &str) -> Result<(String, String), String> {
    let repo = git2::Repository::discover(repo_path)
        .map_err(|e| e.message().to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| e.message().to_string())?;
    let url = remote
        .url()
        .ok_or_else(|| "remote origin has no URL".to_string())?;
    parse_github_owner_repo(url)
        .ok_or_else(|| format!("could not parse GitHub owner/repo from: {}", url))
}

pub(super) fn value_to_pr_info(v: &Value) -> PullRequestInfo {
    let ci_status = v["head"]["sha"]
        .as_str()
        .and_then(|_| v["mergeable_state"].as_str())
        .map(|s| s.to_string());

    PullRequestInfo {
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: v["title"].as_str().unwrap_or("").to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("open").to_string(),
        draft: v["draft"].as_bool().unwrap_or(false),
        base_branch: v["base"]["ref"].as_str().unwrap_or("").to_string(),
        head_branch: v["head"]["ref"].as_str().unwrap_or("").to_string(),
        author: v["user"]["login"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
        additions: v["additions"].as_u64().unwrap_or(0) as u32,
        deletions: v["deletions"].as_u64().unwrap_or(0) as u32,
        changed_files: v["changed_files"].as_u64().unwrap_or(0) as u32,
        mergeable: v["mergeable"].as_bool(),
        ci_status,
        review_status: "pending".to_string(),
        url: v["html_url"].as_str().unwrap_or("").to_string(),
    }
}
