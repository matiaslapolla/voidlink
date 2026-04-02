use rusqlite::params;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use uuid::Uuid;

use super::path_utils::{join_relative, normalize_relative_path, parent_rel_path, split_relative_path};

#[derive(Clone, Debug)]
pub(crate) struct FileRecord {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) language: String,
}

pub(crate) fn rebuild_repo_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    repo_root: &Path,
) -> Result<(), String> {
    tx.execute("DELETE FROM edges WHERE repo_id = ?1", params![repo_id])
        .map_err(|e| e.to_string())?;

    let files = load_repo_files_for_edges(tx, repo_id)?;
    let file_by_path = files
        .iter()
        .map(|file| (normalize_relative_path(&file.path), file.id.clone()))
        .collect::<HashMap<_, _>>();

    let mut seen_directories = HashSet::<String>::new();
    for file in &files {
        let parent = parent_rel_path(&file.path);
        let parent_node = format!("dir:{parent}");
        insert_edge(
            tx,
            repo_id,
            "path_parent",
            &file.id,
            &parent_node,
            json!({
                "kind": "file_parent",
                "filePath": file.path,
                "parentPath": parent
            }),
        )?;
        insert_directory_parent_edges(tx, repo_id, &parent, &mut seen_directories)?;
    }

    {
        let mut stmt = tx
            .prepare(
                "SELECT c.id, c.file_id, c.chunk_index, c.start_line, c.end_line
                 FROM chunks c
                 INNER JOIN files f ON f.id = c.file_id
                 WHERE f.repo_id = ?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let chunk_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
            let file_id = row.get::<_, String>(1).map_err(|e| e.to_string())?;
            let chunk_index = row.get::<_, i64>(2).map_err(|e| e.to_string())?;
            let start_line = row.get::<_, i64>(3).map_err(|e| e.to_string())?;
            let end_line = row.get::<_, i64>(4).map_err(|e| e.to_string())?;

            insert_edge(
                tx,
                repo_id,
                "contains",
                &file_id,
                &chunk_id,
                json!({
                    "chunkIndex": chunk_index,
                    "startLine": start_line,
                    "endLine": end_line
                }),
            )?;
        }
    }

    for file in &files {
        let full_path = repo_root.join(&file.path);
        let content = match fs::read_to_string(&full_path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let imports = extract_import_specs(&file.language, &content);
        let mut dedup = HashSet::<String>::new();
        for import_spec in imports {
            if !dedup.insert(import_spec.clone()) {
                continue;
            }
            let resolved = resolve_import_target(
                &file.path,
                &file.language,
                &import_spec,
                &file_by_path,
            );
            let (target_id, resolved_path, resolved_flag) = match resolved {
                Some((target_file_id, path)) => (target_file_id, Some(path), true),
                None => (format!("external:{import_spec}"), None, false),
            };

            insert_edge(
                tx,
                repo_id,
                "import",
                &file.id,
                &target_id,
                json!({
                    "import": import_spec,
                    "resolved": resolved_flag,
                    "resolvedPath": resolved_path
                }),
            )?;
        }
    }

    Ok(())
}

fn load_repo_files_for_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
) -> Result<Vec<FileRecord>, String> {
    let mut files = Vec::new();
    let mut stmt = tx
        .prepare("SELECT id, path, language FROM files WHERE repo_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        files.push(FileRecord {
            id: row.get(0).map_err(|e| e.to_string())?,
            path: row.get(1).map_err(|e| e.to_string())?,
            language: row.get(2).map_err(|e| e.to_string())?,
        });
    }
    Ok(files)
}

fn insert_directory_parent_edges(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    directory_path: &str,
    seen_directories: &mut HashSet<String>,
) -> Result<(), String> {
    let mut current = normalize_relative_path(directory_path);
    if current == "." {
        return Ok(());
    }

    loop {
        if !seen_directories.insert(current.clone()) {
            break;
        }
        let parent = parent_rel_path(&current);
        insert_edge(
            tx,
            repo_id,
            "path_parent",
            &format!("dir:{current}"),
            &format!("dir:{parent}"),
            json!({
                "kind": "dir_parent",
                "path": current,
                "parentPath": parent
            }),
        )?;
        if parent == "." {
            break;
        }
        current = parent;
    }
    Ok(())
}

fn insert_edge(
    tx: &rusqlite::Transaction<'_>,
    repo_id: &str,
    edge_type: &str,
    source_id: &str,
    target_id: &str,
    metadata: Value,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO edges (id, repo_id, edge_type, source_id, target_id, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            Uuid::new_v4().to_string(),
            repo_id,
            edge_type,
            source_id,
            target_id,
            serde_json::to_string(&metadata).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn extract_import_specs(language: &str, content: &str) -> Vec<String> {
    let mut imports = Vec::new();

    for line in content.lines().take(400) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match language {
            "typescript" | "javascript" => {
                if (trimmed.starts_with("import ") || trimmed.starts_with("export "))
                    && trimmed.contains(" from ")
                {
                    if let Some(spec) = extract_quoted_after_keyword(trimmed, " from ") {
                        imports.push(spec);
                    }
                }

                if let Some(spec) = extract_quoted_call_arg(trimmed, "require(") {
                    imports.push(spec);
                }
                if let Some(spec) = extract_quoted_call_arg(trimmed, "import(") {
                    imports.push(spec);
                }
            }
            "python" => {
                if let Some(rest) = trimmed.strip_prefix("from ") {
                    if let Some((module, _)) = rest.split_once(" import ") {
                        let module = module.trim();
                        if !module.is_empty() {
                            imports.push(module.to_string());
                        }
                    }
                } else if let Some(rest) = trimmed.strip_prefix("import ") {
                    for item in rest.split(',') {
                        let module = item.trim().split_whitespace().next().unwrap_or_default();
                        if !module.is_empty() {
                            imports.push(module.to_string());
                        }
                    }
                }
            }
            "rust" => {
                if let Some(rest) = trimmed.strip_prefix("use ") {
                    let use_path = rest.trim_end_matches(';').trim();
                    if !use_path.is_empty() {
                        imports.push(use_path.to_string());
                    }
                } else if let Some(rest) = trimmed.strip_prefix("mod ") {
                    let module = rest
                        .trim_end_matches(';')
                        .split_whitespace()
                        .next()
                        .unwrap_or_default();
                    if !module.is_empty() {
                        imports.push(module.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    imports
}

fn extract_quoted_after_keyword(input: &str, keyword: &str) -> Option<String> {
    let (_, suffix) = input.split_once(keyword)?;
    extract_first_quoted(suffix)
}

fn extract_quoted_call_arg(input: &str, call_prefix: &str) -> Option<String> {
    let idx = input.find(call_prefix)?;
    extract_first_quoted(&input[(idx + call_prefix.len())..])
}

fn extract_first_quoted(input: &str) -> Option<String> {
    let mut start_index = None::<(usize, char)>;
    for (idx, ch) in input.char_indices() {
        if start_index.is_none() && (ch == '"' || ch == '\'' || ch == '`') {
            start_index = Some((idx, ch));
            continue;
        }

        if let Some((start, quote)) = start_index {
            if ch == quote {
                let value = input[(start + 1)..idx].trim();
                if !value.is_empty() {
                    return Some(value.to_string());
                }
                return None;
            }
        }
    }
    None
}

fn resolve_import_target(
    source_path: &str,
    language: &str,
    import_spec: &str,
    file_by_path: &HashMap<String, String>,
) -> Option<(String, String)> {
    let candidates = import_path_candidates(source_path, language, import_spec);
    for candidate in candidates {
        if let Some(target_id) = file_by_path.get(&candidate) {
            return Some((target_id.clone(), candidate));
        }
    }
    None
}

fn import_path_candidates(source_path: &str, language: &str, import_spec: &str) -> Vec<String> {
    let spec = import_spec.trim();
    if spec.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    let source_dir = parent_rel_path(source_path);

    match language {
        "typescript" | "javascript" => {
            let base = if spec.starts_with('.') {
                join_relative(&source_dir, spec)
            } else if spec.starts_with('/') {
                normalize_relative_path(spec)
            } else {
                String::new()
            };

            if !base.is_empty() {
                append_module_candidates(
                    &base,
                    &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
                    &mut candidates,
                );
            }
        }
        "python" => {
            let base = if spec.starts_with('.') {
                let leading_dots = spec.chars().take_while(|ch| *ch == '.').count();
                let remainder = spec.trim_start_matches('.');
                let mut package_parts = split_relative_path(&source_dir);
                let pops = leading_dots.saturating_sub(1);
                for _ in 0..pops {
                    if package_parts.pop().is_none() {
                        break;
                    }
                }
                let prefix = if package_parts.is_empty() {
                    ".".to_string()
                } else {
                    package_parts.join("/")
                };
                if remainder.is_empty() {
                    prefix
                } else {
                    join_relative(&prefix, &remainder.replace('.', "/"))
                }
            } else {
                normalize_relative_path(&spec.replace('.', "/"))
            };

            if base != "." {
                candidates.push(format!("{base}.py"));
                candidates.push(format!("{base}/__init__.py"));
            }
        }
        "rust" => {
            if let Some(path) = spec.strip_prefix("crate::") {
                let base = normalize_relative_path(&format!("src/{}", path.replace("::", "/")));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if let Some(path) = spec.strip_prefix("self::") {
                let base = join_relative(&source_dir, &path.replace("::", "/"));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if let Some(path) = spec.strip_prefix("super::") {
                let parent = parent_rel_path(&source_dir);
                let base = join_relative(&parent, &path.replace("::", "/"));
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            } else if !spec.contains("::") {
                let base = join_relative(&source_dir, spec);
                candidates.push(format!("{base}.rs"));
                candidates.push(format!("{base}/mod.rs"));
            }
        }
        _ => {
            if spec.starts_with('.') {
                candidates.push(join_relative(&source_dir, spec));
            }
        }
    }

    dedupe_paths(candidates)
}

fn append_module_candidates(base: &str, extensions: &[&str], out: &mut Vec<String>) {
    let normalized = normalize_relative_path(base);
    if normalized == "." {
        return;
    }
    out.push(normalized.clone());

    let has_extension = std::path::Path::new(&normalized).extension().is_some();
    if has_extension {
        return;
    }
    for ext in extensions {
        out.push(format!("{normalized}.{ext}"));
    }
    for ext in extensions {
        out.push(format!("{normalized}/index.{ext}"));
    }
}

fn dedupe_paths(paths: Vec<String>) -> Vec<String> {
    let mut unique = Vec::new();
    let mut seen = HashSet::<String>::new();
    for path in paths {
        let normalized = normalize_relative_path(&path);
        if normalized == "." {
            continue;
        }
        if seen.insert(normalized.clone()) {
            unique.push(normalized);
        }
    }
    unique
}
