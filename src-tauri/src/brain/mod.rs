use std::fs;
use std::path::Path;
use serde::{Deserialize, Serialize};

use crate::git::repo::open_repo;

/// Type → content-repo folder name, mirroring @brain/core's TYPE_FOLDER. Kept
/// in sync by hand since this module only reads/writes the vault, it doesn't
/// own the contract — @brain/core (in the `brain` repo / voidlink/cli) is the
/// source of truth for the write path.
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
    /// Vault-relative path, e.g. "notes/2026-07-19-foo.md".
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
/// body. The frontmatter shape here is fixed and flat (see @brain/core's
/// buildFrontmatter), so a hand-rolled split is enough — no YAML parser.
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

/// Reject a vault-relative path that isn't actually confined to the vault —
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

/// List every entry across the known type folders, metadata only (no body —
/// list views don't need it, and skipping the read keeps this cheap even as
/// the vault grows).
#[tauri::command]
pub fn brain_list_entries(vault_path: String) -> Result<Vec<BrainEntry>, String> {
    let root = Path::new(&vault_path);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", vault_path));
    }

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
pub fn brain_read_entry(vault_path: String, rel_path: String) -> Result<BrainEntryDetail, String> {
    reject_unsafe_rel_path(&rel_path)?;
    let full_path = Path::new(&vault_path).join(&rel_path);
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

/// Write a file into the vault and commit it in one step — write + stage +
/// commit fused into a single call, composing the same building blocks the
/// git module uses separately (open_repo, index.add_path, write_tree,
/// commit). Used for quick-capture and in-app edits; the full typed-entry
/// pipeline (id generation, idempotency, frontmatter building) stays in the
/// CLI, which owns the @brain/core contract.
#[tauri::command]
pub fn brain_save_entry(
    vault_path: String,
    rel_path: String,
    content: String,
    message: String,
) -> Result<String, String> {
    reject_unsafe_rel_path(&rel_path)?;
    let repo = open_repo(&vault_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "bare repositories not supported".to_string())?
        .to_path_buf();

    // vault_path must be the repo root, not a subdirectory of it — otherwise
    // writing under vault_path (below, matching brain_list_entries /
    // brain_read_entry) and staging rel_path against the repo root (via
    // index.add_path, which is workdir-relative) would silently target two
    // different files. Compare canonicalized paths, not raw strings — one
    // side comes from the OS-provided vault_path, the other from libgit2's
    // workdir(), and on macOS these disagree on symlinked prefixes like
    // /tmp → /private/tmp even when they're the same directory.
    let canonical_vault = fs::canonicalize(&vault_path).map_err(|e| e.to_string())?;
    let canonical_workdir = fs::canonicalize(&workdir).map_err(|e| e.to_string())?;
    if canonical_vault != canonical_workdir {
        return Err(format!(
            "Vault path {} is not the root of its git repository ({}) — point Settings \u{2192} Brain at the repo root",
            vault_path,
            workdir.display()
        ));
    }

    let full_path = Path::new(&vault_path).join(&rel_path);
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&full_path, content.as_bytes()).map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.message().to_string())?;
    index
        .add_path(Path::new(&rel_path))
        .map_err(|e| e.message().to_string())?;
    index.write().map_err(|e| e.message().to_string())?;

    let tree_oid = index.write_tree().map_err(|e| e.message().to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.message().to_string())?;
    let sig = repo.signature().map_err(|e| e.message().to_string())?;
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
    fn save_entry_writes_commits_and_is_read_back_by_list_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let vault_path = tmp.path().to_string_lossy().to_string();

        let content = "---\nid: 2026-07-19-round-trip\ntype: note\ntitle: \"round trip\"\nlabels: [test]\ncreated: \"2026-07-19T00:00:00.000-03:00\"\nlinks:\n  - \"[[labels/test]]\"\n---\nbody text\n";
        let oid = brain_save_entry(
            vault_path.clone(),
            "notes/2026-07-19-round-trip.md".to_string(),
            content.to_string(),
            "register: note 2026-07-19-round-trip".to_string(),
        )
        .expect("save should succeed");
        assert_eq!(oid.len(), 40, "expected a full git oid, got {oid}");

        // The commit landed and touched exactly the written file.
        let repo = git2::Repository::open(&vault_path).unwrap();
        let commit = repo.find_commit(git2::Oid::from_str(&oid).unwrap()).unwrap();
        assert_eq!(commit.message(), Some("register: note 2026-07-19-round-trip"));

        // list/read see what save wrote — the base-directory divergence this
        // guards against would otherwise write under repo.workdir() while
        // list/read look under vault_path (identical here, but the read-back
        // is what actually proves it, not just that the two happen to match).
        let listed = brain_list_entries(vault_path.clone()).expect("list should succeed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "2026-07-19-round-trip");
        assert_eq!(listed[0].path, "notes/2026-07-19-round-trip.md");

        let detail = brain_read_entry(vault_path, "notes/2026-07-19-round-trip.md".to_string())
            .expect("read should succeed");
        assert_eq!(detail.body, "body text\n");
    }

    #[test]
    fn save_entry_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let vault_path = tmp.path().to_string_lossy().to_string();

        let result = brain_save_entry(
            vault_path,
            "../../etc/passwd".to_string(),
            "malicious".to_string(),
            "msg".to_string(),
        );
        assert!(result.is_err());
    }
}
