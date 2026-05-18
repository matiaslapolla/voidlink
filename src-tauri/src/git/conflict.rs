use git2::{Repository, StatusOptions};
use serde::{Deserialize, Serialize};

/// Versions of a conflicted file that the index has stored at the
/// three merge stages. `working` is what's currently on disk (the
/// version with conflict markers `<<<` / `===` / `>>>`). Missing
/// stages — e.g. base when no common ancestor — come back as None.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictVersions {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub working: String,
}

/// List paths the index marks as conflicted. We use `StatusOptions`
/// rather than walking the index manually so submodules / ignored
/// rules behave the same as `git status`.
pub(crate) fn git_list_conflicts_impl(repo_path: String) -> Result<Vec<String>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(false).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in statuses.iter() {
        if entry.status().is_conflicted() {
            if let Some(p) = entry.path() {
                out.push(p.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Pull the three index stages for a conflicted file plus the
/// working-tree content. Stage IDs:
///   - 1 = base (common ancestor)
///   - 2 = ours (current branch)
///   - 3 = theirs (the branch we're merging in)
/// Missing stages can occur for add/add or delete/modify conflicts.
pub(crate) fn git_conflict_versions_impl(
    repo_path: String,
    file_path: String,
) -> Result<ConflictVersions, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repos can't have conflicts".to_string())?;
    let abs = std::path::PathBuf::from(&file_path);
    let rel = abs
        .strip_prefix(workdir)
        .map_err(|_| format!("file is not inside repo: {}", file_path))?;
    let rel_str = rel.to_string_lossy().to_string();

    let working = std::fs::read_to_string(workdir.join(rel))
        .map_err(|e| format!("read working tree: {}", e))?;

    let index = repo.index().map_err(|e| e.to_string())?;
    let mut base: Option<String> = None;
    let mut ours: Option<String> = None;
    let mut theirs: Option<String> = None;

    for entry in index.iter() {
        // git2 0.19 doesn't expose `stage()` on IndexEntry — derive it
        // from the flags field per the git index format: bits 12..13.
        let stage = ((entry.flags >> 12) & 0x3) as i32;
        let path = std::str::from_utf8(&entry.path)
            .map_err(|e| e.to_string())?
            .to_string();
        if path != rel_str {
            continue;
        }
        let blob = repo
            .find_blob(entry.id)
            .map_err(|e| format!("blob {}: {}", entry.id, e))?;
        let content = String::from_utf8_lossy(blob.content()).to_string();
        match stage {
            1 => base = Some(content),
            2 => ours = Some(content),
            3 => theirs = Some(content),
            _ => {} // stage 0 = resolved, ignore
        }
    }

    Ok(ConflictVersions {
        base,
        ours,
        theirs,
        working,
    })
}

/// Overwrite the working file with `content`, then stage it. Staging a
/// previously-conflicted path is what tells git "the conflict is
/// resolved" — no separate `git add --resolve` is needed.
pub(crate) fn git_resolve_conflict_impl(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repos can't be resolved".to_string())?;
    let abs = std::path::PathBuf::from(&file_path);
    let rel = abs
        .strip_prefix(workdir)
        .map_err(|_| format!("file is not inside repo: {}", file_path))?;

    std::fs::write(workdir.join(rel), content).map_err(|e| format!("write: {}", e))?;

    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_path(rel)
        .map_err(|e| format!("stage failed: {}", e))?;
    index.write().map_err(|e| format!("index write: {}", e))?;
    Ok(())
}
