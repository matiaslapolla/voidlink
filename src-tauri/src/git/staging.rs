use std::path::Path;

use serde::{Deserialize, Serialize};

use super::repo::open_repo;

/// Who a commit is attributed to.
///
/// Both fields are required: git rejects an empty name or email, and a
/// half-filled identity is a mistake we would rather catch here than let
/// libgit2 report as a cryptic signature error.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
}

impl CommitIdentity {
    fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("author name cannot be empty".to_string());
        }
        if self.email.trim().is_empty() {
            return Err("author email cannot be empty".to_string());
        }
        // git stores these inside `Name <email>`, so a stray angle bracket or
        // newline would corrupt the commit header.
        for (field, value) in [("name", &self.name), ("email", &self.email)] {
            if value.contains('<') || value.contains('>') || value.contains('\n') {
                return Err(format!("author {field} cannot contain <, > or a newline"));
            }
        }
        Ok(())
    }
}

/// Build a signature from an explicit identity, validating it first.
/// Shared with the amend path in `reset.rs`.
pub(crate) fn signature_for(identity: &CommitIdentity) -> Result<git2::Signature<'static>, String> {
    identity.validate()?;
    git2::Signature::now(identity.name.trim(), identity.email.trim())
        .map_err(|e| e.message().to_string())
}

/// The signature a commit should carry.
///
/// With no override this is `repo.signature()` — exactly what plain `git
/// commit` would use, honouring the full config cascade (repo → global →
/// system). An override replaces *both* author and committer, which is what
/// `git -c user.name=… -c user.email=…` does and what someone switching
/// between a work and a personal identity expects.
fn resolve_signature<'a>(
    repo: &'a git2::Repository,
    identity: Option<&CommitIdentity>,
) -> Result<git2::Signature<'a>, String> {
    match identity {
        Some(id) => signature_for(id),
        None => repo.signature().map_err(|e| {
            // The default message here is "config value 'user.name' was not
            // found", which does not tell a GUI user what to do about it.
            format!(
                "{} — set an author in the commit box, or run `git config user.name` and `user.email`",
                e.message()
            )
        }),
    }
}

/// Read the identity git would use for a commit in this repository, without
/// committing anything. Feeds the commit box's author fields so an override
/// starts from the real default rather than an empty form.
pub(crate) fn git_config_identity_impl(
    repo_path: String,
) -> Result<Option<CommitIdentity>, String> {
    let repo = open_repo(&repo_path)?;
    Ok(repo.signature().ok().and_then(|sig| {
        match (sig.name(), sig.email()) {
            (Some(name), Some(email)) => Some(CommitIdentity {
                name: name.to_string(),
                email: email.to_string(),
            }),
            _ => None,
        }
    }))
}

pub(crate) fn git_stage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();
    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    for path_str in &paths {
        let rel = Path::new(path_str);
        let abs = workdir.join(rel);
        if abs.exists() {
            index
                .add_path(rel)
                .map_err(|e| e.message().to_string())?;
        } else {
            index
                .remove_path(rel)
                .map_err(|e| e.message().to_string())?;
        }
    }

    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_stage_all_impl(repo_path: String) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_unstage_files_impl(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let mut index = repo.index().map_err(|e| e.message().to_string())?;

    for path_str in &paths {
        let rel = Path::new(path_str);
        match &head_tree {
            Some(tree) => {
                // Reset to HEAD version
                if let Some(entry) = tree.get_path(rel).ok() {
                    index
                        .add(&git2::IndexEntry {
                            ctime: git2::IndexTime::new(0, 0),
                            mtime: git2::IndexTime::new(0, 0),
                            dev: 0,
                            ino: 0,
                            mode: entry.filemode() as u32,
                            uid: 0,
                            gid: 0,
                            file_size: 0,
                            id: entry.id(),
                            flags: 0,
                            flags_extended: 0,
                            path: rel.to_string_lossy().as_bytes().to_vec(),
                        })
                        .map_err(|e| e.message().to_string())?;
                } else {
                    // File didn't exist in HEAD — remove from index
                    index.remove_path(rel).map_err(|e| e.message().to_string())?;
                }
            }
            None => {
                // No commits yet — remove from index
                index.remove_path(rel).map_err(|e| e.message().to_string())?;
            }
        }
    }

    index.write().map_err(|e| e.message().to_string())?;
    Ok(())
}

pub(crate) fn git_commit_impl(
    repo_path: String,
    message: String,
    identity: Option<CommitIdentity>,
) -> Result<String, String> {
    let repo = open_repo(&repo_path)?;
    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| e.message().to_string())?;
    let sig = resolve_signature(&repo, identity.as_ref())?;

    let parent_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| e.message().to_string())?;

    Ok(oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str, email: &str) -> CommitIdentity {
        CommitIdentity {
            name: name.to_string(),
            email: email.to_string(),
        }
    }

    #[test]
    fn accepts_a_normal_identity() {
        assert!(id("Ada Lovelace", "ada@example.com").validate().is_ok());
    }

    #[test]
    fn rejects_blank_fields() {
        assert!(id("", "ada@example.com").validate().is_err());
        assert!(id("   ", "ada@example.com").validate().is_err());
        assert!(id("Ada", "").validate().is_err());
        assert!(id("Ada", "  ").validate().is_err());
    }

    #[test]
    fn rejects_characters_that_would_corrupt_the_commit_header() {
        // `Name <email>` is the on-disk format, so these would break parsing.
        assert!(id("Ada <hax>", "ada@example.com").validate().is_err());
        assert!(id("Ada", "ada@example.com>").validate().is_err());
        assert!(id("Ada\nCommitter: Eve", "ada@example.com").validate().is_err());
    }

    #[test]
    fn signature_trims_surrounding_whitespace() {
        let sig = signature_for(&id("  Ada Lovelace  ", "  ada@example.com  ")).unwrap();
        assert_eq!(sig.name(), Some("Ada Lovelace"));
        assert_eq!(sig.email(), Some("ada@example.com"));
    }
}
