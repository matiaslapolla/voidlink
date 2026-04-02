use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

use super::chunks::{cosine_similarity, jaccard_similarity, tokenize, truncate_to_tokens};
use super::path_utils::canonicalize_repo_path;
use super::{MigrationState, SearchOptions, SearchQuery, SearchResult, SearchWhy};

#[derive(Clone, Debug)]
pub(crate) struct SearchCandidate {
    pub(crate) file_id: String,
    pub(crate) result: SearchResult,
    pub(crate) raw_content: String,
}

pub(crate) fn perform_search(
    state: &MigrationState,
    query: &SearchQuery,
    options: Option<&SearchOptions>,
) -> Result<Vec<SearchResult>, String> {
    let repo_path = canonicalize_repo_path(&query.repo_path)?;
    let repo_id = state
        .db
        .repo_id_for_path(&repo_path)?
        .ok_or_else(|| "Repository has not been scanned yet".to_string())?;

    let conn = state.db.open()?;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, f.id, f.path, f.language, c.start_line, c.end_line, c.content
             FROM chunks c
             INNER JOIN files f ON f.id = c.file_id
             WHERE f.repo_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;

    let query_tokens = tokenize(&query.text);
    let (embedding_model_id, query_embedding) = state.get_provider().embed(&query.text);
    let max_tokens = query.max_tokens.unwrap_or(140);
    let limit = options.and_then(|opts| opts.limit).unwrap_or(25);
    let path_filter = query.path.as_ref().map(|value| value.to_lowercase());
    let language_filter = query.language.as_ref().map(|value| value.to_lowercase());

    let mut candidates = Vec::<SearchCandidate>::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        let file_id = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        let path = row.get::<_, String>(2).map_err(|e| e.to_string())?;
        let language = row.get::<_, String>(3).map_err(|e| e.to_string())?;
        let start_line = row.get::<_, i64>(4).map_err(|e| e.to_string())?;
        let end_line = row.get::<_, i64>(5).map_err(|e| e.to_string())?;
        let content = row.get::<_, String>(6).map_err(|e| e.to_string())?;

        if let Some(filter) = &path_filter {
            if !path.to_lowercase().contains(filter) {
                continue;
            }
        }
        if let Some(filter) = &language_filter {
            if language.to_lowercase() != *filter {
                continue;
            }
        }

        let path_lc = path.to_lowercase();
        let content_lc = content.to_lowercase();

        let mut matched_terms = Vec::new();
        let mut lexical_hits = 0f32;
        for token in &query_tokens {
            let in_path = path_lc.contains(token);
            let count_in_content = content_lc.matches(token).count() as f32;
            if in_path || count_in_content > 0.0 {
                matched_terms.push(token.clone());
                lexical_hits += count_in_content + if in_path { 2.0 } else { 0.0 };
            }
        }

        let lexical_score = if query_tokens.is_empty() {
            0.0
        } else {
            (lexical_hits / ((query_tokens.len() as f32) * 4.0)).min(1.0)
        };

        let score = lexical_score * 0.65;
        candidates.push(SearchCandidate {
            file_id,
            result: SearchResult {
                id,
                file_path: path.clone(),
                anchor: format!("{path}:{}-{}", start_line, end_line),
                snippet: truncate_to_tokens(&content, max_tokens),
                language,
                score,
                lexical_score,
                semantic_score: 0.0,
                why: SearchWhy {
                    matched_terms,
                    semantic_score: 0.0,
                    graph_proximity: None,
                },
            },
            raw_content: content,
        });
    }

    let chunk_ids = candidates
        .iter()
        .map(|candidate| candidate.result.id.clone())
        .collect::<Vec<_>>();
    let embeddings_by_chunk =
        load_chunk_embeddings(&conn, &chunk_ids, &embedding_model_id).unwrap_or_default();

    for candidate in &mut candidates {
        let embedding_semantic = embeddings_by_chunk
            .get(&candidate.result.id)
            .map(|vector| cosine_similarity(&query_embedding, vector))
            .unwrap_or(0.0);
        let lexical_semantic =
            jaccard_similarity(&query_tokens, &tokenize(&candidate.raw_content));
        let semantic_score = embedding_semantic.max(lexical_semantic);

        candidate.result.semantic_score = semantic_score;
        candidate.result.why.semantic_score = semantic_score;
        candidate.result.score =
            ((candidate.result.lexical_score * 0.65) + (semantic_score * 0.35)).clamp(0.0, 1.0);
    }

    candidates.retain(|candidate| {
        if query_tokens.is_empty() {
            true
        } else {
            candidate.result.lexical_score > 0.0 || candidate.result.semantic_score >= 0.08
        }
    });

    let seed_file_ids = collect_seed_file_ids(&candidates, 6);
    let graph_neighbors = load_graph_neighbors(&conn, &repo_id).unwrap_or_default();
    for candidate in &mut candidates {
        let graph_proximity =
            compute_graph_proximity(&candidate.file_id, &seed_file_ids, &graph_neighbors);
        let proximity_boost = graph_proximity.unwrap_or(0.0) * 0.15;
        candidate.result.why.graph_proximity = graph_proximity;
        candidate.result.score = (candidate.result.score + proximity_boost).clamp(0.0, 1.0);
    }

    candidates.sort_by(|a, b| {
        b.result
            .score
            .partial_cmp(&a.result.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if candidates.len() > limit {
        candidates.truncate(limit);
    }
    Ok(candidates.into_iter().map(|candidate| candidate.result).collect())
}

pub(crate) fn load_chunk_embeddings(
    conn: &Connection,
    chunk_ids: &[String],
    model_id: &str,
) -> Result<HashMap<String, Vec<f32>>, String> {
    if chunk_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let wanted = chunk_ids.iter().cloned().collect::<HashSet<_>>();
    let mut out = HashMap::<String, Vec<f32>>::new();

    let mut stmt = conn
        .prepare(
            "SELECT owner_id, vector_json
             FROM embeddings
             WHERE owner_type = 'chunk' AND model = ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![model_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let owner_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        if !wanted.contains(&owner_id) {
            continue;
        }
        let vector_json = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        if let Ok(vector) = serde_json::from_str::<Vec<f32>>(&vector_json) {
            out.insert(owner_id, vector);
        }
    }
    Ok(out)
}

fn load_graph_neighbors(
    conn: &Connection,
    repo_id: &str,
) -> Result<HashMap<String, HashSet<String>>, String> {
    let mut neighbors = HashMap::<String, HashSet<String>>::new();
    let mut stmt = conn
        .prepare(
            "SELECT source_id, target_id
             FROM edges
             WHERE repo_id = ?1
               AND edge_type IN ('import', 'path_parent')",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![repo_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let source = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        let target = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        neighbors
            .entry(source.clone())
            .or_default()
            .insert(target.clone());
        neighbors.entry(target).or_default().insert(source);
    }
    Ok(neighbors)
}

fn collect_seed_file_ids(candidates: &[SearchCandidate], max_seeds: usize) -> HashSet<String> {
    let mut sorted = candidates.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        right
            .result
            .lexical_score
            .partial_cmp(&left.result.lexical_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .result
                    .score
                    .partial_cmp(&left.result.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let mut seeds = HashSet::<String>::new();
    for candidate in sorted {
        if seeds.len() >= max_seeds {
            break;
        }
        if candidate.result.lexical_score > 0.0 || seeds.is_empty() {
            seeds.insert(candidate.file_id.clone());
        }
    }
    seeds
}

pub(crate) fn compute_graph_proximity(
    file_id: &str,
    seed_file_ids: &HashSet<String>,
    neighbors: &HashMap<String, HashSet<String>>,
) -> Option<f32> {
    if seed_file_ids.is_empty() {
        return None;
    }

    if seed_file_ids.contains(file_id) {
        return Some(1.0);
    }

    if let Some(first_hop) = neighbors.get(file_id) {
        if first_hop.iter().any(|node| seed_file_ids.contains(node)) {
            return Some(0.66);
        }

        for node in first_hop {
            if let Some(second_hop) = neighbors.get(node) {
                if second_hop.iter().any(|next| seed_file_ids.contains(next)) {
                    return Some(0.33);
                }
            }
        }
    }

    Some(0.0)
}
