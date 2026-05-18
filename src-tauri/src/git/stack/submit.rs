//! GitHub stack submit: create or update one PR per branch in the stack.
//!
//! Auth: reuses `GITHUB_TOKEN` from the environment, matching the
//! authentication convention `push.rs` already establishes. No token is ever
//! stored on disk by voidlink — BYO-token, no telemetry.
//!
//! Behavior per branch (walked **top-down** so the base of an existing PR is
//! always the just-handled branch below):
//! 1. Find PR via `GET /repos/{o}/{r}/pulls?head={o}:{branch}`.
//! 2. If exists and base mismatches parent: `PATCH /pulls/{n}` to update base.
//! 3. If exists and base matches: NoChange.
//! 4. If no PR: `POST /pulls` with base=parent, draft=true.
//! 5. After write, append the stack footer to the PR body.
//! 6. Record `branch.<name>.prnumber = <n>` for future runs.
//!
//! Per-branch failures are non-fatal — we collect a `SubmitResult` for each
//! and return the full vector to the UI.

use std::collections::HashMap;
use std::time::Duration;

use git2::Repository;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::git::repo::open_repo;

const GITHUB_API: &str = "https://api.github.com";
const ACCEPT_VERSION: &str = "application/vnd.github+json";
const VOIDLINK_UA: &str = "voidlink-stack-submit";
/// Markdown sentinel bracketing the auto-rendered stack footer in PR bodies.
/// Any text between these markers is replaced on each submit; everything
/// outside is preserved so users can keep editing the description.
const FOOTER_BEGIN: &str = "<!-- voidlink-stack-footer:begin -->";
const FOOTER_END: &str = "<!-- voidlink-stack-footer:end -->";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    pub branch: String,
    pub outcome: SubmitOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubmitOutcome {
    /// Newly-opened PR.
    Created { number: u32, url: String },
    /// Existing PR whose base ref was changed to match the recorded parent.
    Updated { number: u32, url: String },
    /// Existing PR; base already matched parent. Body footer may still have
    /// been refreshed.
    NoChange { number: u32, url: String },
    /// Per-branch failure. `reason` is surfaced verbatim in the UI.
    Failed { reason: String },
}

#[derive(Debug, Deserialize)]
struct PullSummary {
    number: u32,
    html_url: String,
    base: PullRef,
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PullRef {
    #[serde(rename = "ref")]
    name: String,
}

// ─── Entry point ─────────────────────────────────────────────────────────────

pub(crate) fn submit_impl(
    repo_path: String,
    branches: Vec<String>,
) -> Result<Vec<SubmitResult>, String> {
    let token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| "GITHUB_TOKEN is not set — export a PAT before submitting".to_string())?;
    let repo = open_repo(&repo_path)?;

    let (owner, name) = origin_owner_repo(&repo)?;
    let client = build_client()?;

    // Build parent map up front — we read it many times below, and discovery
    // already validates trunk/cycles.
    let mut parents: HashMap<String, String> = HashMap::new();
    for branch in &branches {
        let parent =
            super::discovery::read_config_string_pub(&repo, &format!("branch.{}.parent", branch))?
                .ok_or_else(|| format!("branch `{}` is not in a stack", branch))?;
        parents.insert(branch.clone(), parent);
    }

    // Process top-down so a freshly-created PR for the topmost branch points
    // its base at a branch that already has a PR (if it had to be created
    // first). For NEW PRs this ordering doesn't strictly matter for GitHub's
    // validation; for the stack footer it gives us a consistent newest-first
    // narrative.
    let mut results: Vec<SubmitResult> = Vec::with_capacity(branches.len());
    let ordered_top_down: Vec<&String> = branches.iter().rev().collect();
    let footer = render_stack_footer(&branches);

    for branch in ordered_top_down {
        let parent = parents.get(branch).cloned().unwrap_or_default();
        let outcome = submit_one(&client, &owner, &name, branch, &parent, &footer, &token);
        if let SubmitOutcome::Created { number, .. } | SubmitOutcome::Updated { number, .. } =
            &outcome
        {
            // Record the PR number for next time so the read-only view shows
            // the badge without us re-querying GitHub on every render.
            if let Err(e) = write_pr_number(&repo, branch, *number) {
                log::warn!(
                    "failed to persist branch.{}.prnumber: {}",
                    branch,
                    e
                );
            }
        }
        results.push(SubmitResult {
            branch: branch.clone(),
            outcome,
        });
    }

    // Surface in caller-visible (top-down) order.
    Ok(results)
}

// ─── Per-branch worker ───────────────────────────────────────────────────────

fn submit_one(
    client: &Client,
    owner: &str,
    repo_name: &str,
    branch: &str,
    parent: &str,
    footer: &str,
    token: &str,
) -> SubmitOutcome {
    let head_filter = format!("{}:{}", owner, branch);
    let list_url = format!(
        "{}/repos/{}/{}/pulls?head={}&state=open",
        GITHUB_API, owner, repo_name, head_filter
    );
    let list_resp = match client
        .get(&list_url)
        .bearer_auth(token)
        .header(ACCEPT, ACCEPT_VERSION)
        .send()
    {
        Ok(r) => r,
        Err(e) => return SubmitOutcome::Failed { reason: e.to_string() },
    };
    if !list_resp.status().is_success() {
        return SubmitOutcome::Failed {
            reason: format!("list-PRs failed: {}", list_resp.status()),
        };
    }
    let list: Vec<PullSummary> = match list_resp.json() {
        Ok(v) => v,
        Err(e) => return SubmitOutcome::Failed { reason: format!("decode list: {}", e) },
    };

    if let Some(existing) = list.into_iter().next() {
        // Existing PR. Update base if necessary, refresh footer in body.
        let new_body = patch_footer(existing.body.as_deref(), footer);
        let base_matches = existing.base.name == parent;
        let patch_url = format!(
            "{}/repos/{}/{}/pulls/{}",
            GITHUB_API, owner, repo_name, existing.number
        );
        let mut payload = serde_json::Map::new();
        payload.insert("body".into(), serde_json::Value::String(new_body));
        if !base_matches {
            payload.insert("base".into(), serde_json::Value::String(parent.into()));
        }
        let resp = match client
            .patch(&patch_url)
            .bearer_auth(token)
            .header(ACCEPT, ACCEPT_VERSION)
            .json(&serde_json::Value::Object(payload))
            .send()
        {
            Ok(r) => r,
            Err(e) => return SubmitOutcome::Failed { reason: e.to_string() },
        };
        if !resp.status().is_success() {
            return SubmitOutcome::Failed {
                reason: format!("patch PR #{}: {}", existing.number, resp.status()),
            };
        }
        return if base_matches {
            SubmitOutcome::NoChange {
                number: existing.number,
                url: existing.html_url,
            }
        } else {
            SubmitOutcome::Updated {
                number: existing.number,
                url: existing.html_url,
            }
        };
    }

    // No existing PR. Create one as draft so the user gets to review what
    // voidlink opened before requesting reviewers.
    let create_url = format!("{}/repos/{}/{}/pulls", GITHUB_API, owner, repo_name);
    let title = format!("{}", branch);
    let body = patch_footer(None, footer);
    let payload = serde_json::json!({
        "title": title,
        "head": branch,
        "base": parent,
        "body": body,
        "draft": true,
    });
    let resp = match client
        .post(&create_url)
        .bearer_auth(token)
        .header(ACCEPT, ACCEPT_VERSION)
        .json(&payload)
        .send()
    {
        Ok(r) => r,
        Err(e) => return SubmitOutcome::Failed { reason: e.to_string() },
    };
    if resp.status() == StatusCode::UNPROCESSABLE_ENTITY {
        // Most common cause: branch isn't pushed yet.
        return SubmitOutcome::Failed {
            reason: "422 — branch likely not pushed to origin yet".into(),
        };
    }
    if !resp.status().is_success() {
        return SubmitOutcome::Failed {
            reason: format!("create PR: {}", resp.status()),
        };
    }
    let new_pr: PullSummary = match resp.json() {
        Ok(v) => v,
        Err(e) => return SubmitOutcome::Failed { reason: format!("decode created PR: {}", e) },
    };
    SubmitOutcome::Created {
        number: new_pr.number,
        url: new_pr.html_url,
    }
}

// ─── Repo URL parsing ────────────────────────────────────────────────────────

/// Pull the `origin` remote URL out of the repo and parse owner + repo name.
/// Accepts both SSH (`git@github.com:owner/repo.git`) and HTTPS
/// (`https://github.com/owner/repo.git`) forms. Non-GitHub hosts are rejected
/// — the REST shape this module speaks is GitHub-specific.
fn origin_owner_repo(repo: &Repository) -> Result<(String, String), String> {
    let remote = repo
        .find_remote("origin")
        .map_err(|_| "no `origin` remote configured".to_string())?;
    let url = remote
        .url()
        .ok_or_else(|| "origin URL is not valid UTF-8".to_string())?;
    parse_owner_repo(url)
}

pub(crate) fn parse_owner_repo(url: &str) -> Result<(String, String), String> {
    // Normalize the trailing `.git` and any surrounding whitespace.
    let trimmed = url.trim().trim_end_matches(".git").trim_end_matches('/');

    // SSH: git@github.com:owner/repo
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return split_owner_repo(rest);
    }
    // SSH (ssh://) form: ssh://git@github.com/owner/repo
    if let Some(rest) = trimmed.strip_prefix("ssh://git@github.com/") {
        return split_owner_repo(rest);
    }
    // HTTPS: https://github.com/owner/repo or with token in URL
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
    ] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return split_owner_repo(rest);
        }
    }
    // HTTPS with embedded user (e.g. `https://USER@github.com/owner/repo`).
    if let Some(rest) = trimmed.strip_prefix("https://") {
        if let Some(after_at) = rest.split_once('@').map(|(_, r)| r) {
            if let Some(rest) = after_at.strip_prefix("github.com/") {
                return split_owner_repo(rest);
            }
        }
    }
    Err(format!(
        "origin URL `{}` is not recognized as a GitHub remote",
        url
    ))
}

fn split_owner_repo(rest: &str) -> Result<(String, String), String> {
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next().unwrap_or("").trim();
    let name = parts.next().unwrap_or("").trim();
    if owner.is_empty() || name.is_empty() {
        return Err(format!("could not split owner/repo from `{}`", rest));
    }
    Ok((owner.to_string(), name.to_string()))
}

// ─── Footer rendering ────────────────────────────────────────────────────────

/// Render the auto-managed stack footer block. Branches are listed
/// top-to-bottom (topmost first) to match how stack tools display chains.
pub(crate) fn render_stack_footer(branches: &[String]) -> String {
    let mut s = String::new();
    s.push_str(FOOTER_BEGIN);
    s.push('\n');
    s.push_str("**Stack** (top → bottom):\n\n");
    for branch in branches.iter().rev() {
        s.push_str("- `");
        s.push_str(branch);
        s.push_str("`\n");
    }
    s.push_str("\n_managed by voidlink — edits inside this block are overwritten_\n");
    s.push_str(FOOTER_END);
    s
}

/// Insert or replace the footer block in `body`. If markers exist, replace
/// the content between them; otherwise append a blank line and the block.
/// Preserves all user-authored content outside the marker pair.
pub(crate) fn patch_footer(body: Option<&str>, footer: &str) -> String {
    match body {
        None => footer.to_string(),
        Some(existing) => {
            if let (Some(begin), Some(end)) = (existing.find(FOOTER_BEGIN), existing.find(FOOTER_END))
            {
                if end > begin {
                    let end_after = end + FOOTER_END.len();
                    let mut out = String::new();
                    out.push_str(&existing[..begin]);
                    out.push_str(footer);
                    out.push_str(&existing[end_after..]);
                    return out;
                }
            }
            // No marker pair — append.
            let trimmed = existing.trim_end();
            if trimmed.is_empty() {
                footer.to_string()
            } else {
                format!("{}\n\n{}", trimmed, footer)
            }
        }
    }
}

// ─── Misc ────────────────────────────────────────────────────────────────────

fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(VOIDLINK_UA)
        .timeout(Duration::from_secs(20))
        .default_headers({
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(USER_AGENT, VOIDLINK_UA.parse().unwrap());
            h.insert(
                AUTHORIZATION,
                "Bearer placeholder".parse().unwrap(), // overridden per-request
            );
            h
        })
        .build()
        .map_err(|e| e.to_string())
}

fn write_pr_number(repo: &Repository, branch: &str, number: u32) -> Result<(), String> {
    let mut cfg = repo.config().map_err(|e| e.message().to_string())?;
    cfg.set_str(&format!("branch.{}.prnumber", branch), &number.to_string())
        .map_err(|e| e.message().to_string())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_form() {
        let (o, r) = parse_owner_repo("git@github.com:matiaslapolla/voidlink.git").unwrap();
        assert_eq!(o, "matiaslapolla");
        assert_eq!(r, "voidlink");
    }

    #[test]
    fn parses_https_form() {
        let (o, r) = parse_owner_repo("https://github.com/matiaslapolla/voidlink.git").unwrap();
        assert_eq!(o, "matiaslapolla");
        assert_eq!(r, "voidlink");
    }

    #[test]
    fn parses_https_without_dot_git() {
        let (o, r) = parse_owner_repo("https://github.com/foo/bar").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar");
    }

    #[test]
    fn parses_https_with_token_user() {
        let (o, r) =
            parse_owner_repo("https://oauth2-token@github.com/foo/bar.git").unwrap();
        assert_eq!(o, "foo");
        assert_eq!(r, "bar");
    }

    #[test]
    fn rejects_non_github_url() {
        assert!(parse_owner_repo("git@gitlab.com:foo/bar.git").is_err());
        assert!(parse_owner_repo("https://bitbucket.org/foo/bar").is_err());
    }

    #[test]
    fn footer_appended_when_body_is_none() {
        let footer = render_stack_footer(&["a".into(), "b".into()]);
        let out = patch_footer(None, &footer);
        assert_eq!(out, footer);
    }

    #[test]
    fn footer_appended_with_blank_line_when_no_markers() {
        let footer = render_stack_footer(&["a".into()]);
        let out = patch_footer(Some("user body here"), &footer);
        assert!(out.starts_with("user body here\n\n"));
        assert!(out.contains(FOOTER_BEGIN));
        assert!(out.ends_with(FOOTER_END));
    }

    #[test]
    fn footer_replaced_between_markers_preserves_outside_content() {
        let footer1 = render_stack_footer(&["a".into()]);
        let body = format!("hello\n\n{}\n\nafterword", footer1);

        let footer2 = render_stack_footer(&["a".into(), "b".into()]);
        let out = patch_footer(Some(&body), &footer2);
        assert!(out.starts_with("hello\n\n"));
        assert!(out.ends_with("afterword"));
        assert!(out.contains("`a`"));
        assert!(out.contains("`b`"));
        // Exactly one footer block should remain — otherwise we're stacking
        // footers each submit instead of replacing them.
        assert_eq!(
            out.matches(FOOTER_BEGIN).count(),
            1,
            "should contain exactly one footer-begin marker, got: {}",
            out
        );
        assert_eq!(
            out.matches(FOOTER_END).count(),
            1,
            "should contain exactly one footer-end marker, got: {}",
            out
        );
    }

    #[test]
    fn footer_lists_branches_top_down() {
        let s = render_stack_footer(&["bottom".into(), "middle".into(), "top".into()]);
        let top_pos = s.find("`top`").unwrap();
        let mid_pos = s.find("`middle`").unwrap();
        let bot_pos = s.find("`bottom`").unwrap();
        assert!(
            top_pos < mid_pos && mid_pos < bot_pos,
            "expected top→bottom order, got positions top={} mid={} bot={}",
            top_pos,
            mid_pos,
            bot_pos
        );
    }
}
