use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
}

pub fn list_directory(path: &str) -> Result<Vec<DirEntry>, String> {
    let mut entries: Vec<DirEntry> = std::fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntry {
                name,
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read_file_content(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn read_file_base64(path: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

pub fn write_file_content(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| e.to_string())
}

pub fn rename_path(old_path: &str, new_path: &str) -> Result<(), String> {
    std::fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

pub fn copy_path(src: &str, dest: &str) -> Result<(), String> {
    let src_path = std::path::Path::new(src);
    if src_path.is_dir() {
        copy_dir_recursive(src_path, std::path::Path::new(dest))
    } else {
        std::fs::copy(src, dest).map(|_| ()).map_err(|e| e.to_string())
    }
}

pub fn copy_dir_recursive(src: &std::path::Path, dest: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn delete_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

pub fn duplicate_path(path: &str) -> Result<String, String> {
    let src = std::path::Path::new(path);
    let parent = src.parent().ok_or("No parent directory")?;
    let stem = src
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    let mut copy_name = format!("{} copy{}", stem, ext);
    let mut counter = 2u32;
    while parent.join(&copy_name).exists() {
        copy_name = format!("{} copy {}{}", stem, counter, ext);
        counter += 1;
    }

    let dest = parent.join(&copy_name);
    let dest_str = dest.to_string_lossy().to_string();

    if src.is_dir() {
        copy_dir_recursive(src, &dest)?;
    } else {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    }

    Ok(dest_str)
}

pub fn empty_directory(path: &str) -> Result<(), String> {
    let dir = std::path::Path::new(path);
    if !dir.is_dir() {
        return Err("Not a directory".to_string());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
        } else {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
