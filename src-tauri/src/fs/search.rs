//! Find-in-files.
//!
//! Traversal is the `ignore` crate's, the same one behind `fs_list_dir` and the
//! file tree — gitignore semantics are subtle enough (nested `.gitignore`,
//! negations, parent directories) that a second implementation would disagree
//! with the tree about which files exist, which is worse than not having
//! search.
//!
//! Matching is plain substring, optionally case-insensitive and optionally
//! whole-word. Deliberately not regex: that would mean a new dependency, and
//! `Cargo.toml` asks for a justification per dep that "the search box could
//! also take patterns" does not meet. If regex arrives later it belongs behind
//! an explicit toggle, not as the default interpretation of a typed query.
//!
//! Results stream. A traversal of a large repo takes seconds, and a panel that
//! renders nothing until it finishes reads as broken — so the walk emits
//! batches as it goes and the command returns only the summary. Cancellation is
//! a flag the walk polls: a new query supersedes the in-flight one and the
//! superseded walk stops touching the disk rather than racing to deliver
//! results nobody will render.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Files larger than this are skipped. Same order of magnitude as the 2 MB
/// guard on `fs_read_file`, a little more generous because searching a big
/// generated file is cheaper than opening it in an editor.
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

/// Bytes sniffed for a NUL before deciding a file is binary. Matches what most
/// grep implementations do; a UTF-8 text file has no NUL anywhere.
const BINARY_SNIFF_BYTES: usize = 8192;

/// A preview line is truncated to this many characters so one minified
/// bundle line cannot push megabytes through the event channel.
const MAX_PREVIEW_CHARS: usize = 240;

/// Matches per event. Small enough that the first results appear promptly,
/// large enough that a repo-wide hit count does not cost one IPC round trip
/// per match.
const BATCH_SIZE: usize = 64;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    /// Require the match to be delimited by non-word characters on both sides.
    pub whole_word: bool,
    /// Search files gitignore would hide. Same escape hatch as the file tree's
    /// `showIgnoredFiles`, and off for the same reason.
    pub include_ignored: bool,
    /// Stop after this many matches. `None` uses the default cap; the cap is
    /// always reported so truncation is never silent.
    pub max_results: Option<usize>,
}

impl SearchOptions {
    fn cap(&self) -> usize {
        self.max_results.unwrap_or(2000).clamp(1, 20_000)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    /// 1-based, to match Monaco's positions with no arithmetic at the boundary.
    pub line: u32,
    /// 1-based, in **characters** rather than bytes — Monaco columns are UTF-16
    /// code units and a byte offset would land mid-glyph on any non-ASCII line.
    pub column: u32,
    /// The whole line, truncated. `preview_column` is the match's offset within
    /// it, which differs from `column` when the head of a long line was cut.
    pub preview: String,
    pub preview_column: u32,
    /// Match length in characters, so the panel can tint exactly the hit span.
    pub length: u32,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub files_scanned: usize,
    pub files_matched: usize,
    pub matches: usize,
    /// The cap was hit and the walk stopped early. The panel says so with the
    /// real number — silent truncation reads as "that's all there is".
    pub truncated: bool,
    /// The walk was superseded by a newer query. The caller discards whatever
    /// it received.
    pub cancelled: bool,
    /// Paths that could not be read, with the reason. Reported inline in the
    /// panel rather than swallowed.
    pub errors: Vec<SearchError>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchError {
    pub path: String,
    pub message: String,
}

/// One hit inside a single line of text. Byte offsets; the caller converts.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LineHit {
    byte_start: usize,
    byte_len: usize,
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b >= 0x80
}

/// Every occurrence of `needle` in `haystack`, honouring case folding and word
/// boundaries. Both strings are pre-lowercased by the caller when the search is
/// case-insensitive, so this stays a byte search.
///
/// ASCII-only case folding, on purpose: `to_lowercase` on the needle and a
/// per-line `to_lowercase` on the haystack would be correct for Turkish dotted
/// I and also allocate a copy of every line in the repository. Callers that
/// need Unicode folding should ask for a case-sensitive search.
fn find_hits(haystack: &str, needle: &str, whole_word: bool) -> Vec<LineHit> {
    if needle.is_empty() {
        return Vec::new();
    }
    let hay = haystack.as_bytes();
    let ned = needle.as_bytes();
    let mut out = Vec::new();
    let mut from = 0usize;
    while from + ned.len() <= hay.len() {
        let Some(rel) = haystack[from..].find(needle) else {
            break;
        };
        let at = from + rel;
        let end = at + ned.len();
        let ok = !whole_word
            || ((at == 0 || !is_word_byte(hay[at - 1])) && (end == hay.len() || !is_word_byte(hay[end])));
        if ok {
            out.push(LineHit {
                byte_start: at,
                byte_len: ned.len(),
            });
        }
        // Advance past this match's first byte rather than its whole length, so
        // overlapping occurrences of a self-similar needle ("aa" in "aaa") are
        // all found. Cheap, and the alternative silently loses matches.
        from = at + 1;
    }
    out
}

/// Characters (not bytes) before `byte_offset`. The +1 makes it a 1-based
/// column.
fn char_column(line: &str, byte_offset: usize) -> u32 {
    line[..byte_offset].chars().count() as u32 + 1
}

/// A line trimmed to `MAX_PREVIEW_CHARS` around the first hit, with the hit's
/// character offset inside the trimmed string.
fn preview_for(line: &str, hit_char_col: u32) -> (String, u32) {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_PREVIEW_CHARS {
        return (line.to_string(), hit_char_col);
    }
    // Keep the hit in view by windowing around it rather than always taking the
    // head — a match at column 4000 of a minified line is otherwise invisible.
    let hit = (hit_char_col as usize).saturating_sub(1);
    let start = hit.saturating_sub(MAX_PREVIEW_CHARS / 3);
    let end = (start + MAX_PREVIEW_CHARS).min(chars.len());
    let text: String = chars[start..end].iter().collect();
    (text, (hit - start) as u32 + 1)
}

/// Every match of `query` in `text`. Pure, and the piece with all the
/// interesting edge cases — this is what the unit tests exercise.
pub fn search_text(path: &str, text: &str, query: &str, opts: &SearchOptions) -> Vec<SearchMatch> {
    if query.is_empty() {
        return Vec::new();
    }
    let needle = if opts.case_sensitive {
        query.to_string()
    } else {
        query.to_ascii_lowercase()
    };

    let mut out = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        let hay = if opts.case_sensitive {
            std::borrow::Cow::Borrowed(line)
        } else {
            std::borrow::Cow::Owned(line.to_ascii_lowercase())
        };
        for hit in find_hits(&hay, &needle, opts.whole_word) {
            // The lowercased copy has the same byte layout as the original for
            // ASCII folding, so offsets carry over unchanged.
            let column = char_column(line, hit.byte_start);
            let (preview, preview_column) = preview_for(line, column);
            out.push(SearchMatch {
                path: path.to_string(),
                line: idx as u32 + 1,
                column,
                preview,
                preview_column,
                length: line[hit.byte_start..hit.byte_start + hit.byte_len]
                    .chars()
                    .count() as u32,
            });
        }
    }
    out
}

/// True when the bytes look like something no one wants rendered as a search
/// preview. A NUL in the first few KB is the standard tell.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes
        .iter()
        .take(BINARY_SNIFF_BYTES)
        .any(|&b| b == 0)
}

/// Walk `root`, calling `on_batch` with matches as they are found.
///
/// Returns once the walk finishes, the cap is hit, or `cancelled` flips. Runs
/// on a blocking thread — never call it from the async runtime.
pub fn search_tree(
    root: &Path,
    query: &str,
    opts: &SearchOptions,
    cancelled: &AtomicBool,
    mut on_batch: impl FnMut(Vec<SearchMatch>),
) -> SearchSummary {
    let mut summary = SearchSummary::default();
    if query.is_empty() {
        return summary;
    }
    let cap = opts.cap();

    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false)
        .ignore(!opts.include_ignored)
        .git_ignore(!opts.include_ignored)
        .git_global(false)
        .git_exclude(false);

    let mut batch: Vec<SearchMatch> = Vec::with_capacity(BATCH_SIZE);

    for result in builder.build() {
        if cancelled.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let entry = match result {
            Ok(e) => e,
            Err(e) => {
                summary.errors.push(SearchError {
                    path: root.to_string_lossy().to_string(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        // With ignores off the walker descends into `.git`; nothing in there is
        // a source file the user meant to search.
        if path.components().any(|c| c.as_os_str() == ".git") {
            continue;
        }
        let Ok(meta) = path.metadata() else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }

        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                summary.errors.push(SearchError {
                    path: path.to_string_lossy().to_string(),
                    message: e.to_string(),
                });
                continue;
            }
        };
        if looks_binary(&bytes) {
            continue;
        }
        // Non-UTF-8 is skipped rather than lossily decoded: a preview built out
        // of replacement characters is not something to click through to.
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };

        summary.files_scanned += 1;
        let path_str = path.to_string_lossy().to_string();
        let hits = search_text(&path_str, &text, query, opts);
        if hits.is_empty() {
            continue;
        }
        summary.files_matched += 1;

        for hit in hits {
            if summary.matches >= cap {
                summary.truncated = true;
                break;
            }
            summary.matches += 1;
            batch.push(hit);
            if batch.len() >= BATCH_SIZE {
                on_batch(std::mem::take(&mut batch));
                batch.reserve(BATCH_SIZE);
            }
        }
        if summary.truncated {
            break;
        }
    }

    if !batch.is_empty() {
        on_batch(batch);
    }
    summary
}

// ─── Tauri command surface ───────────────────────────────────────────────────

/// Cancel flags, keyed by the frontend-supplied search id.
///
/// A `OnceLock` rather than Tauri managed state so adding search touches
/// `lib.rs` only where the command list is appended — the registration order
/// there is shared with two other branches right now.
fn cancel_flags() -> &'static DashMap<String, Arc<AtomicBool>> {
    static FLAGS: OnceLock<DashMap<String, Arc<AtomicBool>>> = OnceLock::new();
    FLAGS.get_or_init(DashMap::new)
}

/// Monotonic sequence per emitted batch, so the frontend can drop an
/// out-of-order delivery instead of interleaving it into the results.
static BATCH_SEQ: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchBatchEvent {
    search_id: String,
    seq: usize,
    matches: Vec<SearchMatch>,
}

/// Search `root` for `query`, streaming matches to `fs-search-batch` and
/// returning the summary when the walk ends.
///
/// `search_id` is minted by the caller and is the handle for cancellation. The
/// caller is expected to discard any batch whose id is not the query it is
/// currently showing, because a walk already inside `std::fs::read` when the
/// flag flips will still deliver that one batch.
#[tauri::command]
pub async fn fs_search_files(
    app: AppHandle,
    search_id: String,
    root: String,
    query: String,
    options: Option<SearchOptions>,
) -> Result<SearchSummary, String> {
    let dir = std::path::PathBuf::from(&root);
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", root));
    }
    let opts = options.unwrap_or_default();
    let flag = Arc::new(AtomicBool::new(false));
    cancel_flags().insert(search_id.clone(), flag.clone());

    let id = search_id.clone();
    let handle = app.clone();
    let summary = tauri::async_runtime::spawn_blocking(move || {
        search_tree(&dir, &query, &opts, &flag, |matches| {
            let _ = handle.emit(
                "fs-search-batch",
                SearchBatchEvent {
                    search_id: id.clone(),
                    seq: BATCH_SEQ.fetch_add(1, Ordering::Relaxed),
                    matches,
                },
            );
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    cancel_flags().remove(&search_id);
    Ok(summary)
}

/// Supersede an in-flight search. Unknown ids are a no-op — the walk may have
/// finished between the user's keystroke and this call.
#[tauri::command]
pub fn fs_search_cancel(search_id: String) {
    if let Some(flag) = cancel_flags().get(&search_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn opts() -> SearchOptions {
        SearchOptions::default()
    }

    #[test]
    fn reports_one_based_line_and_column() {
        let text = "let x = 1;\nlet needle = 2;\n";
        let hits = search_text("/a.rs", text, "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].column, 5);
        assert_eq!(hits[0].length, 6);
        assert_eq!(hits[0].preview, "let needle = 2;");
    }

    #[test]
    fn columns_are_characters_not_bytes() {
        // A byte offset here would be 8 and would land Monaco mid-glyph.
        let text = "// héllo needle";
        let hits = search_text("/a.rs", text, "needle", &opts());
        assert_eq!(hits[0].column, 10);
    }

    #[test]
    fn folds_case_by_default_and_not_when_asked() {
        let text = "Needle NEEDLE needle";
        assert_eq!(search_text("/a", text, "needle", &opts()).len(), 3);

        let exact = SearchOptions {
            case_sensitive: true,
            ..Default::default()
        };
        let hits = search_text("/a", text, "needle", &exact);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].column, 15);
    }

    #[test]
    fn whole_word_rejects_substrings() {
        let text = "needle needles _needle";
        let word = SearchOptions {
            whole_word: true,
            ..Default::default()
        };
        let hits = search_text("/a", text, "needle", &word);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].column, 1);
    }

    #[test]
    fn finds_overlapping_occurrences() {
        let hits = search_text("/a", "aaa", "aa", &opts());
        assert_eq!(hits.iter().map(|h| h.column).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn windows_a_long_line_around_the_hit() {
        let mut line = "x".repeat(4000);
        line.push_str("needle");
        let hits = search_text("/a", &line, "needle", &opts());
        assert_eq!(hits.len(), 1);
        assert!(hits[0].preview.chars().count() <= MAX_PREVIEW_CHARS);
        // The hit has to be inside the preview or the row is useless.
        let pc = hits[0].preview_column as usize - 1;
        assert!(hits[0].preview[pc..].starts_with("needle"));
        // The real column is still the real column.
        assert_eq!(hits[0].column, 4001);
    }

    #[test]
    fn empty_query_matches_nothing() {
        assert!(search_text("/a", "anything", "", &opts()).is_empty());
    }

    // ── Tree traversal ──────────────────────────────────────────────────────

    struct Fixture {
        dir: std::path::PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A repo with one tracked hit, one gitignored hit, and one binary file
    /// that also contains the query.
    fn fixture(name: &str) -> Fixture {
        let dir = std::env::temp_dir().join(format!("voidlink-search-{}", name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("target")).unwrap();
        // `ignore` only honours `.gitignore` inside a repository.
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".gitignore"), "target/\n").unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() { needle(); }\n").unwrap();
        std::fs::write(dir.join("target/build.rs"), "// needle\n").unwrap();
        std::fs::write(dir.join("src/blob.bin"), b"\x00\x01needle\x00").unwrap();
        // The repository's own internals must never be searched.
        std::fs::write(dir.join(".git/COMMIT_EDITMSG"), "needle\n").unwrap();
        Fixture { dir }
    }

    fn run(root: &Path, query: &str, opts: &SearchOptions) -> (Vec<SearchMatch>, SearchSummary) {
        let flag = AtomicBool::new(false);
        let mut got = Vec::new();
        let summary = search_tree(root, query, opts, &flag, |b| got.extend(b));
        (got, summary)
    }

    #[test]
    fn excludes_gitignored_files_by_default() {
        let f = fixture("ignored-default");
        let (hits, summary) = run(&f.dir, "needle", &opts());
        let paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.ends_with("src/main.rs")));
        assert!(!paths.iter().any(|p| p.contains("target")));
        assert_eq!(summary.files_matched, 1);
        assert!(!summary.truncated);
    }

    #[test]
    fn includes_gitignored_files_when_asked() {
        let f = fixture("ignored-optin");
        let all = SearchOptions {
            include_ignored: true,
            ..Default::default()
        };
        let (hits, _) = run(&f.dir, "needle", &all);
        let paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.iter().any(|p| p.contains("target")));
        // …but still never the repository's internals.
        assert!(!paths.iter().any(|p| p.contains(".git/")));
    }

    #[test]
    fn skips_binary_files() {
        let f = fixture("binary");
        let all = SearchOptions {
            include_ignored: true,
            ..Default::default()
        };
        let (hits, _) = run(&f.dir, "needle", &all);
        assert!(!hits.iter().any(|h| h.path.ends_with("blob.bin")));
    }

    #[test]
    fn reports_truncation_rather_than_stopping_silently() {
        let f = fixture("truncate");
        std::fs::write(f.dir.join("src/many.rs"), "needle\n".repeat(50)).unwrap();
        let capped = SearchOptions {
            max_results: Some(10),
            ..Default::default()
        };
        let (hits, summary) = run(&f.dir, "needle", &capped);
        assert_eq!(hits.len(), 10);
        assert_eq!(summary.matches, 10);
        assert!(summary.truncated);
    }

    #[test]
    fn stops_and_reports_when_cancelled() {
        let f = fixture("cancel");
        let flag = AtomicBool::new(true);
        let mut got = Vec::new();
        let summary = search_tree(&f.dir, "needle", &opts(), &flag, |b| got.extend(b));
        assert!(summary.cancelled);
        assert!(got.is_empty());
    }

    #[test]
    fn streams_in_batches_rather_than_one_final_delivery() {
        let f = fixture("stream");
        std::fs::write(
            f.dir.join("src/many.rs"),
            "needle\n".repeat(BATCH_SIZE * 2 + 5),
        )
        .unwrap();
        let flag = AtomicBool::new(false);
        let mut batches = 0usize;
        let summary = search_tree(&f.dir, "needle", &opts(), &flag, |_| batches += 1);
        assert!(batches >= 3, "expected several batches, got {}", batches);
        assert!(summary.matches > BATCH_SIZE);
    }
}
