use std::collections::HashSet;

pub(crate) const DETERMINISTIC_EMBED_MODEL: &str = "deterministic-v1";

#[derive(Clone)]
pub(crate) struct ChunkRecord {
    pub(crate) start_line: usize,
    pub(crate) end_line: usize,
    pub(crate) text: String,
    pub(crate) token_estimate: usize,
}

pub(crate) fn chunk_content(content: &str, max_lines: usize, overlap: usize) -> Vec<ChunkRecord> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return vec![ChunkRecord {
            start_line: 1,
            end_line: 1,
            text: String::new(),
            token_estimate: 0,
        }];
    }

    let mut records = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + max_lines).min(lines.len());
        let text = lines[start..end].join("\n");
        records.push(ChunkRecord {
            start_line: start + 1,
            end_line: end,
            token_estimate: text.split_whitespace().count(),
            text,
        });
        if end == lines.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    records
}

pub(crate) fn tokenize(input: &str) -> Vec<String> {
    input
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter_map(|part| {
            let token = part.trim().to_ascii_lowercase();
            if token.len() > 1 {
                Some(token)
            } else {
                None
            }
        })
        .collect()
}

pub(crate) fn truncate_to_tokens(content: &str, max_tokens: usize) -> String {
    if max_tokens == 0 {
        return String::new();
    }
    let mut tokens = content.split_whitespace();
    let mut output = Vec::new();
    for _ in 0..max_tokens {
        if let Some(token) = tokens.next() {
            output.push(token);
        } else {
            break;
        }
    }
    output.join(" ")
}

pub(crate) fn truncate_plain(content: &str, max_chars: usize) -> String {
    if content.len() <= max_chars {
        return content.to_string();
    }
    let mut truncated = content.chars().take(max_chars).collect::<String>();
    truncated.push_str("...");
    truncated
}

pub(crate) fn deterministic_embedding(content: &str, size: usize) -> Vec<f32> {
    let mut out = vec![0f32; size];
    for token in tokenize(content) {
        let mut hash = 0u64;
        for b in token.as_bytes() {
            hash = hash.wrapping_mul(31).wrapping_add(*b as u64);
        }
        let idx = (hash % size as u64) as usize;
        out[idx] += 1.0;
    }
    normalize(&mut out);
    out
}

pub(crate) fn normalize(values: &mut [f32]) {
    let magnitude = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if magnitude > 0.0 {
        for value in values.iter_mut() {
            *value /= magnitude;
        }
    }
}

pub(crate) fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.is_empty() || right.is_empty() || left.len() != right.len() {
        return 0.0;
    }
    left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>().clamp(0.0, 1.0)
}

pub(crate) fn jaccard_similarity(left: &[String], right: &[String]) -> f32 {
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let left_set: HashSet<&String> = left.iter().collect();
    let right_set: HashSet<&String> = right.iter().collect();
    let intersect = left_set.intersection(&right_set).count() as f32;
    let union = left_set.union(&right_set).count() as f32;
    if union <= 0.0 {
        0.0
    } else {
        (intersect / union).clamp(0.0, 1.0)
    }
}
