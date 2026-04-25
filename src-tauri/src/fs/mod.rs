use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}


#[tauri::command]
pub fn fs_list_dir(path: String, include_ignored: Option<bool>) -> Result<Vec<FsEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let _include_ignored = include_ignored.unwrap_or(false);

    // Load gitignore patterns from the directory or any parent.
    let ignore_builder = {
        let mut b = ignore::WalkBuilder::new(dir);
        b.hidden(false)
         .ignore(true)
         .git_ignore(!_include_ignored)
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

        let metadata = entry_path.metadata().map_err(|e| e.to_string())?;
        let is_dir = metadata.is_dir();
        let size = if is_dir { 0 } else { metadata.len() };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);

        entries.push(FsEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir,
            size,
            modified,
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
