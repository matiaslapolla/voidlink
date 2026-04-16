use ignore::WalkBuilder;
use rusqlite::params;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;
use uuid::Uuid;

use super::chunks::{chunk_content, deterministic_embedding, truncate_plain};
use super::db::SqliteStore;
use super::graph::rebuild_repo_edges;
use super::path_utils::{detect_language, now_ms, should_ignore_app_path};
use super::provider::ProviderAdapter;
use super::MigrationState;

#[derive(Clone, Debug)]
pub struct ExistingFileMeta {
    pub id: String,
    pub mtime_ms: i64,
    pub content_hash: String,
}

pub fn execute_scan_job(
    state: &MigrationState,
    job_id: &str,
    repo_path: &str,
    options: &super::ScanOptions,
) -> Result<(), String> {
    super::update_scan(state, job_id, |job| {
        job.status = "running".to_string();
    })?;

    let repo_id = state.db.upsert_repo(repo_path)?;
    let max_file_size = options.max_file_size_bytes.unwrap_or(768 * 1024);
    let conn = state.db.open()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let mut existing = HashMap::<String, ExistingFileMeta>::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, path, mtime_ms, content_hash FROM files WHERE repo_id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            existing.insert(
                row.get::<_, String>(1).map_err(|e| e.to_string())?,
                ExistingFileMeta {
                    id: row.get(0).map_err(|e| e.to_string())?,
                    mtime_ms: row.get(2).map_err(|e| e.to_string())?,
                    content_hash: row.get(3).map_err(|e| e.to_string())?,
                },
            );
        }
    }

    let mut seen_paths = HashSet::<String>::new();
    let mut scanned_files: u64 = 0;
    let mut indexed_files: u64 = 0;
    let mut indexed_chunks: u64 = 0;
    let mut pending_chunk_embeddings = Vec::<(String, String)>::new();

    let mut walker = WalkBuilder::new(repo_path);
    walker.hidden(false);
    walker.git_ignore(true);
    walker.git_global(true);
    walker.git_exclude(true);
    walker.parents(true);

    for entry in walker.build() {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }

        let path = entry.path();
        if should_ignore_app_path(path, Path::new(repo_path)) {
            continue;
        }

        let metadata = match fs::metadata(path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.len() > max_file_size {
            continue;
        }

        let relative = match path.strip_prefix(repo_path) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        seen_paths.insert(relative.clone());
        scanned_files += 1;

        let bytes = match fs::read(path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if bytes.contains(&0) {
            continue;
        }

        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| {
                time.duration_since(UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_millis() as i64)
            })
            .unwrap_or(0);
        let content_hash = blake3::hash(&bytes).to_hex().to_string();

        if !options.force_full_rescan {
            if let Some(meta) = existing.get(&relative) {
                if meta.mtime_ms == mtime_ms && meta.content_hash == content_hash {
                    continue;
                }
            }
        }

        let file_id = existing
            .get(&relative)
            .map(|meta| meta.id.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let language = detect_language(path);
        let content = String::from_utf8_lossy(&bytes).to_string();
        let chunks = chunk_content(&content, 120, 20);
        let indexed_at = now_ms();

        tx.execute(
            "INSERT INTO files (id, repo_id, path, language, size_bytes, mtime_ms, content_hash, indexed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(repo_id, path) DO UPDATE SET
               language = excluded.language,
               size_bytes = excluded.size_bytes,
               mtime_ms = excluded.mtime_ms,
               content_hash = excluded.content_hash,
               indexed_at = excluded.indexed_at",
            params![
                file_id,
                repo_id,
                relative,
                language,
                metadata.len() as i64,
                mtime_ms,
                content_hash,
                indexed_at
            ],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM embeddings
             WHERE owner_type = 'chunk'
               AND owner_id IN (SELECT id FROM chunks WHERE file_id = ?1)",
            params![file_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM chunks WHERE file_id = ?1", params![file_id])
            .map_err(|e| e.to_string())?;

        for (idx, chunk) in chunks.iter().enumerate() {
            let chunk_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO chunks (id, file_id, chunk_index, start_line, end_line, content, token_estimate)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    chunk_id,
                    file_id,
                    idx as i64,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.text,
                    chunk.token_estimate as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            pending_chunk_embeddings.push((chunk_id, chunk.text.clone()));
        }

        indexed_files += 1;
        indexed_chunks += chunks.len() as u64;

        if scanned_files % 25 == 0 {
            let _ = super::update_scan(state, job_id, |job| {
                job.scanned_files = scanned_files;
                job.indexed_files = indexed_files;
                job.indexed_chunks = indexed_chunks;
            });
        }
    }

    for path in existing.keys() {
        if !seen_paths.contains(path) {
            tx.execute(
                "DELETE FROM files WHERE repo_id = ?1 AND path = ?2",
                params![repo_id, path],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    rebuild_repo_edges(&tx, &repo_id, Path::new(repo_path))?;

    tx.commit().map_err(|e| e.to_string())?;
    let provider = state.get_provider();
    persist_chunk_embeddings(&state.db, &provider, &pending_chunk_embeddings)?;
    cleanup_orphan_chunk_embeddings(&state.db)?;

    super::update_scan(state, job_id, |job| {
        job.status = "success".to_string();
        job.scanned_files = scanned_files;
        job.indexed_files = indexed_files;
        job.indexed_chunks = indexed_chunks;
        job.finished_at = Some(now_ms());
    })?;

    Ok(())
}

pub fn persist_chunk_embeddings(
    store: &SqliteStore,
    provider: &ProviderAdapter,
    chunk_entries: &[(String, String)],
) -> Result<(), String> {
    if chunk_entries.is_empty() {
        return Ok(());
    }

    let conn = store.open()?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    const BATCH_SIZE: usize = 24;

    for chunk_batch in chunk_entries.chunks(BATCH_SIZE) {
        let texts = chunk_batch
            .iter()
            .map(|(_, text)| truncate_plain(text, 12_000))
            .collect::<Vec<_>>();
        let embeddings = provider.embed_many(&texts);

        for (index, (chunk_id, text)) in chunk_batch.iter().enumerate() {
            let vector = embeddings
                .vectors
                .get(index)
                .cloned()
                .unwrap_or_else(|| deterministic_embedding(text, 16));
            tx.execute(
                "DELETE FROM embeddings WHERE owner_type = 'chunk' AND owner_id = ?1",
                params![chunk_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO embeddings (id, owner_type, owner_id, model, vector_json, created_at)
                 VALUES (?1, 'chunk', ?2, ?3, ?4, ?5)",
                params![
                    Uuid::new_v4().to_string(),
                    chunk_id,
                    embeddings.model_id.as_str(),
                    serde_json::to_string(&vector).map_err(|e| e.to_string())?,
                    now_ms()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.commit().map_err(|e| e.to_string())
}

pub fn cleanup_orphan_chunk_embeddings(store: &SqliteStore) -> Result<(), String> {
    let conn = store.open()?;
    conn.execute(
        "DELETE FROM embeddings
         WHERE owner_type = 'chunk'
           AND owner_id NOT IN (SELECT id FROM chunks)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
