pub mod search;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    /// True when the entry only surfaced because `include_ignored` was set —
    /// i.e. gitignore would normally hide it. The tree dims these so an
    /// ignored `.env` still reads as ignored while being openable.
    pub ignored: bool,
}

/// Direct children of `dir` after gitignore filtering. Used to work out which
/// of the unfiltered entries are only visible because ignores were disabled.
fn visible_children(dir: &Path) -> HashSet<PathBuf> {
    let mut b = ignore::WalkBuilder::new(dir);
    b.hidden(false)
        .ignore(true)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .max_depth(Some(1));
    b.build()
        .filter_map(|r| r.ok())
        .filter(|e| e.depth() == 1)
        .map(|e| e.path().to_path_buf())
        .collect()
}

#[tauri::command]
pub fn fs_list_dir(path: String, include_ignored: Option<bool>) -> Result<Vec<FsEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let include_ignored = include_ignored.unwrap_or(false);
    // Only needed to label the extra entries; skipped entirely on the default
    // path, where nothing ignored is listed in the first place.
    let visible = if include_ignored {
        visible_children(dir)
    } else {
        HashSet::new()
    };

    // Load gitignore patterns from the directory or any parent.
    let ignore_builder = {
        let mut b = ignore::WalkBuilder::new(dir);
        b.hidden(false)
         .ignore(!include_ignored)
         .git_ignore(!include_ignored)
         .git_global(false)
         .git_exclude(false)
         .max_depth(Some(1));
        b
    };

    let mut entries: Vec<FsEntry> = Vec::new();

    for result in ignore_builder.build() {
        let entry = result.map_err(|e| e.to_string())?;
        let entry_path = entry.path();

        // Skip the root itself
        if entry_path == dir {
            continue;
        }

        // Only include direct children (depth 1)
        if entry.depth() != 1 {
            continue;
        }

        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if name.is_empty() {
            continue;
        }

        // With ignores off the walker will happily descend into `.git`; the
        // repository's internals are never something to browse.
        if name == ".git" {
            continue;
        }

        let metadata = entry_path.metadata().map_err(|e| e.to_string())?;
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        let ignored = include_ignored && !visible.contains(entry_path);

        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size,
            modified,
            ignored,
        });
    }

    Ok(entries)
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 2 * 1024 * 1024; // 2 MB guard
    let p = Path::new(&path);
    let meta = p.metadata().map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!("File too large to open ({} bytes > 2 MB)", meta.len()));
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    // Atomic write: write to a temp file next to the target, then rename.
    let tmp_path = p.with_extension(format!(
        "{}.tmp",
        p.extension().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp_path, content.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        e.to_string()
    })
}

#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(p).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(Path::new(&from), Path::new(&to)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

/// Walk upward from `path` looking for a `.git` entry (directory or worktree
/// file). Returns the directory containing it, or None if no repo is found
/// before hitting filesystem root.
#[tauri::command]
pub fn fs_find_repo_root(path: String) -> Result<Option<String>, String> {
    let mut current = Path::new(&path).to_path_buf();
    if !current.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    // If a file was passed, start from its parent dir.
    if current.is_file() {
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        }
    }
    loop {
        if current.join(".git").exists() {
            return Ok(Some(current.to_string_lossy().to_string()));
        }
        match current.parent() {
            Some(p) if p != current => current = p.to_path_buf(),
            _ => return Ok(None),
        }
    }
}

/// Modification stamp for one path. `exists: false` covers a file deleted out
/// from under an open tab, which is a change like any other.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub path: String,
    pub exists: bool,
    /// Seconds since the epoch. `None` on a filesystem that does not report it.
    pub modified: Option<i64>,
    pub size: u64,
}

/// Stat a batch of paths in one call.
///
/// Batched deliberately: the editor polls every open buffer on window focus and
/// after every git ref change, and one IPC round trip per open tab would make a
/// branch switch with twenty tabs open twenty round trips. There is no watcher
/// because a watcher means a new dependency and an OS-level handle per file,
/// for information that is only ever consumed at two discrete moments.
#[tauri::command]
pub fn fs_stat_files(paths: Vec<String>) -> Vec<FileStamp> {
    paths
        .into_iter()
        .map(|path| match std::fs::metadata(Path::new(&path)) {
            Ok(meta) => FileStamp {
                exists: true,
                modified: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64),
                size: meta.len(),
                path,
            },
            Err(_) => FileStamp {
                path,
                exists: false,
                modified: None,
                size: 0,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_report_existence_size_and_absence() {
        let dir = std::env::temp_dir().join("voidlink-fs-stat-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("a.txt");
        std::fs::write(&present, "hello").unwrap();
        let missing = dir.join("gone.txt");

        let stamps = fs_stat_files(vec![
            present.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ]);
        assert_eq!(stamps.len(), 2);
        assert!(stamps[0].exists);
        assert_eq!(stamps[0].size, 5);
        // A file deleted out from under an open tab is a change like any other.
        assert!(!stamps[1].exists);
        assert_eq!(stamps[1].size, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A gitignored file is invisible by default and appears, flagged, once
    /// ignores are off — the `.env` case the toggle exists for.
    #[test]
    fn lists_ignored_entries_only_on_request() {
        let dir = std::env::temp_dir().join("voidlink-fs-list-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The `ignore` crate only honours `.gitignore` inside a repository, so
        // the marker directory is part of the fixture.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".gitignore"), ".env\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::write(dir.join("main.rs"), "").unwrap();

        let path = dir.to_string_lossy().to_string();

        let default = fs_list_dir(path.clone(), None).unwrap();
        assert!(!default.iter().any(|e| e.name == ".env"));
        assert!(default.iter().any(|e| e.name == ".gitignore"));

        let all = fs_list_dir(path, Some(true)).unwrap();
        let env = all.iter().find(|e| e.name == ".env").expect(".env listed");
        assert!(env.ignored);
        assert!(!all.iter().find(|e| e.name == "main.rs").unwrap().ignored);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
