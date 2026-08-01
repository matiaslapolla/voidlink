use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

/// Where a project's brain lives, relative to its repository root. `.voidlink/`
/// is already this app's per-repo scratch directory (see
/// `git::worktree_setup`), which is normally gitignored — so a project brain is
/// yours and stable across branches rather than something that appears and
/// vanishes as you check out.
const BRAIN_DIR: [&str; 2] = [".voidlink", "brain"];

/// Type → folder name. The same six types the `brain` CLI uses, so an entry
/// written here reads the same as one in a personal vault — but this module
/// shares no code and no config with that CLI. A project brain is entirely
/// app-owned: nothing else reads or writes it.
const TYPE_FOLDERS: &[(&str, &str)] = &[
    ("decision", "decisions"),
    ("shipped", "shipped"),
    ("note", "notes"),
    ("discovery", "discoveries"),
    ("content", "content"),
    ("training", "training"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainEntry {
    pub id: String,
    pub entry_type: String,
    pub title: String,
    pub project: Option<String>,
    pub ticket: Option<String>,
    pub labels: Vec<String>,
    pub created: Option<String>,
    /// Brain-relative path, e.g. "notes/2026-07-19-foo.md".
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainEntryDetail {
    #[serde(flatten)]
    pub meta: BrainEntry,
    pub body: String,
}

/// Split a markdown file's leading `---`-fenced frontmatter block from its
/// body. The frontmatter shape here is fixed and flat, so a hand-rolled split
/// is enough — no YAML parser.
fn split_frontmatter(raw: &str) -> (Option<&str>, &str) {
    if !raw.starts_with("---") {
        return (None, raw);
    }
    let after_open = raw[3..].strip_prefix('\n').unwrap_or(&raw[3..]);
    match after_open.find("\n---") {
        Some(end) => {
            let frontmatter = &after_open[..end];
            let rest = &after_open[end + 4..];
            let body = rest.strip_prefix('\n').unwrap_or(rest);
            (Some(frontmatter), body)
        }
        None => (None, raw),
    }
}

fn unquote_scalar(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        s[1..s.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        s.to_string()
    }
}

fn parse_flow_array(s: &str) -> Vec<String> {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('[') && s.ends_with(']') {
        s[1..s.len() - 1]
            .split(',')
            .map(|v| unquote_scalar(v.trim()))
            .filter(|v| !v.is_empty())
            .collect()
    } else {
        Vec::new()
    }
}

/// Parse the flat frontmatter block into a `BrainEntry`. `id`/`path` are
/// derived from the file's location by the caller, not from the frontmatter.
fn parse_frontmatter(fm: &str, entry_type: &str, id: String, path: String) -> BrainEntry {
    let mut title = String::new();
    let mut project = None;
    let mut ticket = None;
    let mut labels = Vec::new();
    let mut created = None;

    for line in fm.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("title:") {
            title = unquote_scalar(rest);
        } else if let Some(rest) = line.strip_prefix("project:") {
            project = Some(unquote_scalar(rest));
        } else if let Some(rest) = line.strip_prefix("ticket:") {
            ticket = Some(unquote_scalar(rest));
        } else if let Some(rest) = line.strip_prefix("created:") {
            created = Some(unquote_scalar(rest));
        } else if let Some(rest) = line.strip_prefix("labels:") {
            labels = parse_flow_array(rest);
        }
    }

    BrainEntry { id, entry_type: entry_type.to_string(), title, project, ticket, labels, created, path }
}

fn entry_type_for_folder(folder: &str) -> &'static str {
    TYPE_FOLDERS
        .iter()
        .find(|(_, f)| *f == folder)
        .map(|(t, _)| *t)
        .unwrap_or("note")
}

/// Reject a brain-relative path that isn't actually confined to the brain —
/// absolute, or containing a `..` component. `rel_path` is currently always
/// either server-generated (from `brain_list_entries`) or a `slug()`'d id,
/// but these commands are a Tauri IPC boundary, so validate defensively
/// rather than trust the caller.
fn reject_unsafe_rel_path(rel_path: &str) -> Result<(), String> {
    let p = Path::new(rel_path);
    if p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("Invalid entry path: {}", rel_path));
    }
    Ok(())
}

/// `<repo_root>/.voidlink/brain`. Not required to exist: a repo with no entries
/// yet is the common case, and the directory is created by the first write.
fn brain_root(repo_root: &str) -> PathBuf {
    let mut p = PathBuf::from(repo_root);
    for segment in BRAIN_DIR {
        p.push(segment);
    }
    p
}

/// List every entry across the known type folders, metadata only (no body —
/// list views don't need it, and skipping the read keeps this cheap even as
/// the brain grows).
///
/// An absent brain directory is an empty list, not an error: every repo starts
/// without one and gets it on first capture, so "no entries yet" is the
/// ordinary state rather than a misconfiguration to report.
#[tauri::command]
pub fn brain_list_entries(repo_root: String) -> Result<Vec<BrainEntry>, String> {
    let root = brain_root(&repo_root);

    let mut out = Vec::new();
    for (entry_type, folder) in TYPE_FOLDERS {
        let dir = root.join(folder);
        let read_dir = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            // Folder doesn't exist yet (e.g. no `content`/`training` entries
            // registered so far) — not an error, just nothing to list here.
            Err(_) => continue,
        };
        for entry in read_dir {
            // One unreadable directory entry or file shouldn't blank the
            // entire list — skip it and keep going.
            let Ok(entry) = entry else { continue };
            let file_path = entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&file_path) else { continue };
            let (fm, _body) = split_frontmatter(&raw);
            let id = file_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel_path = format!("{}/{}.md", folder, id);
            if let Some(fm) = fm {
                out.push(parse_frontmatter(fm, entry_type, id, rel_path));
            }
        }
    }

    out.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

/// Read one entry's full frontmatter + body.
#[tauri::command]
pub fn brain_read_entry(repo_root: String, rel_path: String) -> Result<BrainEntryDetail, String> {
    reject_unsafe_rel_path(&rel_path)?;
    let full_path = brain_root(&repo_root).join(&rel_path);
    let raw = fs::read_to_string(&full_path).map_err(|e| e.to_string())?;
    let (fm, body) = split_frontmatter(&raw);
    let fm = fm.ok_or_else(|| format!("No frontmatter found in {}", rel_path))?;

    let folder = rel_path.split('/').next().unwrap_or("");
    let entry_type = entry_type_for_folder(folder);
    let id = Path::new(&rel_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    let meta = parse_frontmatter(fm, entry_type, id, rel_path);
    Ok(BrainEntryDetail { meta, body: body.to_string() })
}

/// Write one entry into the project's brain, creating its type folder on the
/// way. Returns the path written, repo-relative, for the caller to report.
///
/// **The write is the whole operation — nothing is staged or committed.** When
/// this wrote into a dedicated content repo, fusing write + stage + commit was
/// right: that repo existed for the entries and had no other work in flight.
/// A project brain lives inside the repo you are *working* in, where a commit
/// made behind your back lands on your branch, in the middle of your change,
/// alongside whatever you had staged. So the file is written and left in the
/// working tree, where `.voidlink/` is normally gitignored and it stays out of
/// your history entirely.
#[tauri::command]
pub fn brain_save_entry(
    repo_root: String,
    rel_path: String,
    content: String,
) -> Result<String, String> {
    reject_unsafe_rel_path(&rel_path)?;

    let full_path = brain_root(&repo_root).join(&rel_path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full_path, content.as_bytes()).map_err(|e| e.to_string())?;

    Ok(format!("{}/{}/{}", BRAIN_DIR[0], BRAIN_DIR[1], rel_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures below are verbatim real entries from a live brain-kb vault
    // (@brain/core's buildMarkdown output), not hand-simplified — this is
    // what actually has to parse correctly, em-dash and all.

    const DECISION_ENTRY: &str = "---\nid: 2026-07-19-brain-cli-writes-directly-to-brain-kb-instead-of-posting-to-vercel\ntype: decision\ntitle: brain CLI writes directly to brain-kb instead of POSTing to Vercel\nproject: brain\ncreated: \"2026-07-19T17:31:22.116-03:00\"\nlinks:\n  - \"[[projects/brain]]\"\n---\nRewrote packages/cli's write path.\n- Idempotency suffix now checks the filesystem instead of querying Neon\n";

    const NOTE_ENTRY: &str = "---\nid: 2026-06-13-credit-system-prod-migrated-engine-verified-polar-setup-is-the-remaining-blocker\ntype: note\ntitle: Credit system \u{2014} prod migrated + engine verified; Polar setup is the remaining blocker\nlabels: [topyourproduct, billing, credits]\ncreated: \"2026-06-13T03:03:22.767-03:00\"\nlinks:\n  - \"[[labels/topyourproduct]]\"\n  - \"[[labels/billing]]\"\n  - \"[[labels/credits]]\"\n---\nState as of 2026-06-13 (post-merge of credit-system to main):\n\nDONE:\n- Migration 0002 applied to Neon prod.\n";

    #[test]
    fn split_frontmatter_isolates_block_and_body_for_a_decision_entry() {
        let (fm, body) = split_frontmatter(DECISION_ENTRY);
        let fm = fm.expect("frontmatter should be found");
        assert!(fm.contains("id: 2026-07-19-brain-cli-writes-directly-to-brain-kb-instead-of-posting-to-vercel"));
        assert!(body.starts_with("Rewrote packages/cli's write path."));
        assert!(!body.contains("---"));
    }

    #[test]
    fn parse_frontmatter_extracts_project_scalar_for_a_decision_entry() {
        let (fm, _) = split_frontmatter(DECISION_ENTRY);
        let entry = parse_frontmatter(
            fm.unwrap(),
            "decision",
            "2026-07-19-brain-cli-writes-directly-to-brain-kb-instead-of-posting-to-vercel".to_string(),
            "decisions/2026-07-19-brain-cli-writes-directly-to-brain-kb-instead-of-posting-to-vercel.md".to_string(),
        );
        assert_eq!(entry.title, "brain CLI writes directly to brain-kb instead of POSTing to Vercel");
        assert_eq!(entry.project.as_deref(), Some("brain"));
        assert_eq!(entry.ticket, None);
        assert!(entry.labels.is_empty());
        assert_eq!(entry.created.as_deref(), Some("2026-07-19T17:31:22.116-03:00"));
    }

    #[test]
    fn parse_frontmatter_extracts_labels_array_and_unicode_title_for_a_note_entry() {
        let (fm, body) = split_frontmatter(NOTE_ENTRY);
        let entry = parse_frontmatter(
            fm.unwrap(),
            "note",
            "2026-06-13-credit-system".to_string(),
            "notes/2026-06-13-credit-system.md".to_string(),
        );
        assert_eq!(
            entry.title,
            "Credit system \u{2014} prod migrated + engine verified; Polar setup is the remaining blocker"
        );
        assert_eq!(entry.project, None);
        assert_eq!(entry.labels, vec!["topyourproduct", "billing", "credits"]);
        assert!(body.starts_with("State as of 2026-06-13"));
    }

    #[test]
    fn entry_type_for_folder_maps_known_folders_and_falls_back_to_note() {
        assert_eq!(entry_type_for_folder("decisions"), "decision");
        assert_eq!(entry_type_for_folder("shipped"), "shipped");
        assert_eq!(entry_type_for_folder("canvases"), "note");
    }

    #[test]
    fn unquote_scalar_handles_bare_and_double_quoted_values() {
        assert_eq!(unquote_scalar("brain"), "brain");
        assert_eq!(unquote_scalar("\"2026-07-19T17:31:22.116-03:00\""), "2026-07-19T17:31:22.116-03:00");
        assert_eq!(unquote_scalar("\"a \\\"quoted\\\" value\""), "a \"quoted\" value");
    }

    #[test]
    fn reject_unsafe_rel_path_blocks_absolute_and_parent_dir_paths() {
        assert!(reject_unsafe_rel_path("notes/2026-07-19-foo.md").is_ok());
        assert!(reject_unsafe_rel_path("/etc/passwd").is_err());
        assert!(reject_unsafe_rel_path("../../etc/passwd").is_err());
        assert!(reject_unsafe_rel_path("notes/../../../etc/passwd").is_err());
    }

    fn init_repo(path: &std::path::Path) -> git2::Repository {
        let repo = git2::Repository::init(path).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        repo
    }

    #[test]
    fn save_entry_writes_under_dot_voidlink_and_is_read_back_by_list_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let repo_root = tmp.path().to_string_lossy().to_string();

        let content = "---\nid: 2026-07-19-round-trip\ntype: note\ntitle: \"round trip\"\nlabels: [test]\ncreated: \"2026-07-19T00:00:00.000-03:00\"\nlinks:\n  - \"[[labels/test]]\"\n---\nbody text\n";
        let written = brain_save_entry(
            repo_root.clone(),
            "notes/2026-07-19-round-trip.md".to_string(),
            content.to_string(),
        )
        .expect("save should succeed");
        assert_eq!(written, ".voidlink/brain/notes/2026-07-19-round-trip.md");

        // The path is the point: an entry written to the repo root instead of
        // under `.voidlink/` would land in the user's tracked tree.
        assert!(tmp
            .path()
            .join(".voidlink/brain/notes/2026-07-19-round-trip.md")
            .is_file());

        let listed = brain_list_entries(repo_root.clone()).expect("list should succeed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "2026-07-19-round-trip");
        assert_eq!(listed[0].path, "notes/2026-07-19-round-trip.md");

        let detail = brain_read_entry(repo_root, "notes/2026-07-19-round-trip.md".to_string())
            .expect("read should succeed");
        assert_eq!(detail.body, "body text\n");
    }

    /// The behaviour change that made a project brain safe to put inside a
    /// working repo: capture leaves history alone. A commit here would land on
    /// whatever branch the user was mid-change on.
    #[test]
    fn save_entry_neither_commits_nor_stages() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        let repo_root = tmp.path().to_string_lossy().to_string();

        brain_save_entry(
            repo_root,
            "notes/2026-07-19-quiet.md".to_string(),
            "---\ntitle: quiet\n---\nbody\n".to_string(),
        )
        .expect("save should succeed");

        assert!(repo.head().is_err(), "no commit should have been created");
        assert_eq!(repo.index().unwrap().len(), 0, "nothing should be staged");
    }

    /// Every repo starts without a brain, so an absent directory is the
    /// ordinary state and has to read as "no entries", not as an error.
    #[test]
    fn list_entries_returns_empty_for_a_repo_with_no_brain() {
        let tmp = tempfile::tempdir().unwrap();
        let listed = brain_list_entries(tmp.path().to_string_lossy().to_string())
            .expect("an absent brain is not an error");
        assert!(listed.is_empty());
    }

    #[test]
    fn save_entry_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        let result = brain_save_entry(
            tmp.path().to_string_lossy().to_string(),
            "../../etc/passwd".to_string(),
            "malicious".to_string(),
        );
        assert!(result.is_err());
    }
}
