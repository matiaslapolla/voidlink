use git2::{BlameOptions, Repository};
use serde::{Deserialize, Serialize};

/// One per-line blame entry. We pre-truncate the summary on the Rust
/// side because Monaco's inline decoration text width is limited and
/// long subjects look noisy in the gutter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// 1-based line number in the current file revision.
    pub line: u32,
    pub commit_oid: String,
    pub short_oid: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time in seconds since epoch (matches `GitCommitInfo.time`).
    pub time: i64,
    pub summary: String,
    /// True when this line is part of an uncommitted change in the
    /// working tree. git2 marks those hunks with the zero OID; we
    /// **return** them (the frontend renders them as "Uncommitted" and
    /// the status-bar chip says so) rather than dropping them, so a
    /// caller can tell "not committed yet" from "no blame at all".
    /// `commit_oid` and `short_oid` are empty for these; the signature
    /// git2 gives us is passed through as-is.
    pub uncommitted: bool,
}

const SUMMARY_MAX: usize = 80;

/// Run `git blame` on a working-tree file and return a flat list of
/// per-line entries, suitable for rendering as Monaco inline decorations.
/// `file_path` is absolute; we strip the repo root to derive the path
/// git2 needs.
pub(crate) fn git_blame_file_impl(
    repo_path: String,
    file_path: String,
) -> Result<Vec<BlameLine>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repos can't be blamed".to_string())?;

    let abs = std::path::PathBuf::from(&file_path);
    let rel = abs
        .strip_prefix(workdir)
        .map_err(|_| format!("file is not inside repo: {}", file_path))?;

    let mut opts = BlameOptions::new();
    opts.track_copies_same_commit_moves(false)
        .track_copies_same_commit_copies(false)
        .first_parent(false);

    let blame = repo
        .blame_file(rel, Some(&mut opts))
        .map_err(|e| format!("blame failed: {}", e))?;

    // The blame iterator gives us hunks, not per-line entries, so the file's
    // line count is only ever a capacity hint for the expansion below.
    //
    // Deliberately `read` and count newline *bytes* rather than
    // `read_to_string().lines()`. The old version's error aborted the whole
    // command, so a non-UTF-8 file got no blame at all even though
    // `blame_file` had already succeeded — and the frontend swallowed the
    // failure into a `console.debug`. Nothing here needs the text decoded, and
    // a missing hint costs one reallocation, so both failure modes are
    // non-fatal now.
    let abs_path = workdir.join(rel);
    let total_lines = std::fs::read(&abs_path)
        .map(|bytes| bytes.iter().filter(|b| **b == b'\n').count() + 1)
        .unwrap_or(0);

    let mut out: Vec<BlameLine> = Vec::with_capacity(total_lines);
    // Cache resolved commit metadata per OID — repeated blame hunks on
    // the same commit are common, and revwalk lookups aren't free.
    let mut meta_cache: std::collections::HashMap<git2::Oid, (String, String, String, i64, String)> =
        std::collections::HashMap::new();

    for hunk in blame.iter() {
        let oid = hunk.final_commit_id();
        let start = hunk.final_start_line() as u32;
        let lines = hunk.lines_in_hunk() as u32;
        // git2 marks uncommitted hunks with the zero OID.
        let uncommitted = oid.is_zero();

        let (short_oid, author_name, author_email, time, summary) = if uncommitted {
            (
                String::new(),
                hunk.final_signature().name().unwrap_or("").to_string(),
                hunk.final_signature().email().unwrap_or("").to_string(),
                hunk.final_signature().when().seconds(),
                "Uncommitted changes".to_string(),
            )
        } else if let Some(m) = meta_cache.get(&oid) {
            m.clone()
        } else {
            let commit = repo
                .find_commit(oid)
                .map_err(|e| format!("blame: missing commit {}: {}", oid, e))?;
            let summary = commit.summary().unwrap_or("").to_string();
            let truncated = if summary.chars().count() > SUMMARY_MAX {
                let mut s: String = summary.chars().take(SUMMARY_MAX).collect();
                s.push('…');
                s
            } else {
                summary
            };
            let short = oid.to_string()[..7].to_string();
            let auth = commit.author();
            let entry = (
                short,
                auth.name().unwrap_or("").to_string(),
                auth.email().unwrap_or("").to_string(),
                commit.time().seconds(),
                truncated,
            );
            meta_cache.insert(oid, entry.clone());
            entry
        };

        for i in 0..lines {
            out.push(BlameLine {
                line: start + i,
                commit_oid: if uncommitted { String::new() } else { oid.to_string() },
                short_oid: short_oid.clone(),
                author_name: author_name.clone(),
                author_email: author_email.clone(),
                time,
                summary: summary.clone(),
                uncommitted,
            });
        }
    }
    Ok(out)
}
