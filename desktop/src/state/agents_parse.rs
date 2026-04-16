//! Best-effort parser that turns an `AgentEvent.text` (or `ChatMessage.content`)
//! string into a structured `ToolCall` (polish plan §4.5).
//!
//! Until Phase 8 emits tool calls as first-class events on the pipeline, the
//! UI reconstructs them from free-text event lines. The parser is deliberately
//! conservative — it returns `None` for anything it can't recognise, and the
//! chat falls back to rendering the message as regular prose in that case.
//!
//! Supported patterns (case-insensitive on the verb):
//!
//! - `Write <path>`                                → `Write`, path, no delta
//! - `Write <path> +<N>`                           → with add
//! - `Write <path> +<N> -<M>`                      → with both
//! - `Edit <path>`, `Delete <path>`, `ReadFile <path>` — same shape
//! - `Lint`, `Typecheck`, `Build`, `Test`          → no path, status from trailing marker
//! - `Run <cmd>`                                   → path=None, kind=Run
//! - `Search "<query>"`                            → path=None, kind=Search
//! - `Updated todos <N> items`                     → kind=Todo
//!
//! A trailing `(ok)` / `(failed)` / `(skipped)` token maps to status.

use std::path::PathBuf;

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ToolCallKind {
    Write,
    Edit,
    Delete,
    Lint,
    Typecheck,
    Build,
    Test,
    Run,
    ReadFile,
    Search,
    Todo,
    Other,
}

impl ToolCallKind {
    pub fn label(&self) -> &'static str {
        match self {
            ToolCallKind::Write => "Write",
            ToolCallKind::Edit => "Edit",
            ToolCallKind::Delete => "Delete",
            ToolCallKind::Lint => "Lint",
            ToolCallKind::Typecheck => "Typecheck",
            ToolCallKind::Build => "Build",
            ToolCallKind::Test => "Test",
            ToolCallKind::Run => "Run",
            ToolCallKind::ReadFile => "Read",
            ToolCallKind::Search => "Search",
            ToolCallKind::Todo => "Todos",
            ToolCallKind::Other => "Tool",
        }
    }
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum ToolCallStatus {
    Running,
    Success,
    Error,
    Skipped,
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub kind: ToolCallKind,
    pub path: Option<PathBuf>,
    pub add: Option<u32>,
    pub del: Option<u32>,
    pub status: ToolCallStatus,
    pub extra: Option<String>,
}

fn trailing_status(tail: &str) -> (ToolCallStatus, String) {
    let t = tail.trim();
    if t.ends_with("(ok)") || t.ends_with("(done)") {
        (
            ToolCallStatus::Success,
            t.rsplit_once('(')
                .map(|(a, _)| a.trim().to_string())
                .unwrap_or_default(),
        )
    } else if t.ends_with("(failed)") || t.ends_with("(error)") {
        (
            ToolCallStatus::Error,
            t.rsplit_once('(')
                .map(|(a, _)| a.trim().to_string())
                .unwrap_or_default(),
        )
    } else if t.ends_with("(skipped)") {
        (
            ToolCallStatus::Skipped,
            t.rsplit_once('(')
                .map(|(a, _)| a.trim().to_string())
                .unwrap_or_default(),
        )
    } else {
        (ToolCallStatus::Running, t.to_string())
    }
}

fn parse_deltas(tokens: &mut Vec<&str>) -> (Option<u32>, Option<u32>) {
    let mut add = None;
    let mut del = None;
    let mut keep: Vec<&str> = Vec::new();
    for tok in tokens.drain(..) {
        if let Some(n) = tok.strip_prefix('+') {
            if let Ok(v) = n.parse::<u32>() {
                add = Some(v);
                continue;
            }
        }
        if let Some(n) = tok.strip_prefix('-') {
            if let Ok(v) = n.parse::<u32>() {
                del = Some(v);
                continue;
            }
        }
        keep.push(tok);
    }
    *tokens = keep;
    (add, del)
}

/// Attempt to parse a single event/message line into a structured `ToolCall`.
pub fn parse_event(text: &str) -> Option<ToolCall> {
    let (status, body) = trailing_status(text);
    let mut tokens: Vec<&str> = body.split_whitespace().collect();
    if tokens.is_empty() {
        return None;
    }

    let verb = tokens.remove(0);
    let kind = match verb.to_lowercase().as_str() {
        "write" | "wrote" => ToolCallKind::Write,
        "edit" | "edited" => ToolCallKind::Edit,
        "delete" | "deleted" | "remove" | "removed" => ToolCallKind::Delete,
        "lint" => ToolCallKind::Lint,
        "typecheck" | "tsc" => ToolCallKind::Typecheck,
        "build" => ToolCallKind::Build,
        "test" => ToolCallKind::Test,
        "run" => ToolCallKind::Run,
        "read" | "readfile" => ToolCallKind::ReadFile,
        "search" => ToolCallKind::Search,
        "updated" if tokens.first() == Some(&"todos") => {
            tokens.remove(0);
            ToolCallKind::Todo
        }
        _ => return None,
    };

    // Pull any delta tokens out of the remainder.
    let (add, del) = parse_deltas(&mut tokens);

    // For path-bearing kinds, the first remaining token is the path.
    let needs_path = matches!(
        kind,
        ToolCallKind::Write | ToolCallKind::Edit | ToolCallKind::Delete | ToolCallKind::ReadFile
    );

    let (path, extra) = if needs_path && !tokens.is_empty() {
        let p = tokens.remove(0).to_string();
        let rest = if tokens.is_empty() {
            None
        } else {
            Some(tokens.join(" "))
        };
        (Some(PathBuf::from(p)), rest)
    } else {
        let rest = if tokens.is_empty() {
            None
        } else {
            Some(tokens.join(" "))
        };
        (None, rest)
    };

    Some(ToolCall {
        kind,
        path,
        add,
        del,
        status,
        extra,
    })
}

/// Extract inline `@path/to/file` tokens from a free-text message. Returns
/// (segments_of_text_and_badges). Each `Segment::Text` is literal text;
/// `Segment::FileBadge(path)` renders as a clickable badge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageSegment {
    Text(String),
    FileBadge(String),
}

/// Split `text` on `@token` patterns where token is a plausible file path.
/// Returns an ordered list of text + badge segments.
pub fn split_file_badges(text: &str) -> Vec<MessageSegment> {
    let mut out: Vec<MessageSegment> = Vec::new();
    let mut cursor = 0usize;
    let bytes = text.as_bytes();

    while cursor < bytes.len() {
        // Find next '@'.
        let at = match text[cursor..].find('@') {
            Some(pos) => cursor + pos,
            None => {
                out.push(MessageSegment::Text(text[cursor..].to_string()));
                break;
            }
        };

        // Push any text before the '@'.
        if at > cursor {
            out.push(MessageSegment::Text(text[cursor..at].to_string()));
        }

        // Extract the token after '@' — alphanumeric, `/`, `.`, `_`, `-`.
        let token_start = at + 1;
        let mut token_end = token_start;
        for (i, ch) in text[token_start..].char_indices() {
            let is_ok = ch.is_alphanumeric()
                || matches!(ch, '/' | '.' | '_' | '-');
            if is_ok {
                token_end = token_start + i + ch.len_utf8();
            } else {
                break;
            }
        }

        if token_end == token_start {
            // Bare '@' with no following token — keep as literal.
            out.push(MessageSegment::Text("@".to_string()));
            cursor = at + 1;
            continue;
        }

        let token = &text[token_start..token_end];
        // Only treat as file badge if it looks like a path: contains a `/` or
        // ends in a typical extension.
        let looks_like_path = token.contains('/')
            || token
                .rsplit_once('.')
                .map(|(_, ext)| {
                    matches!(
                        ext,
                        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "toml" | "md" | "json" | "yaml" | "yml" | "sh" | "rb" | "sql"
                    )
                })
                .unwrap_or(false);

        if looks_like_path {
            out.push(MessageSegment::FileBadge(token.to_string()));
        } else {
            out.push(MessageSegment::Text(format!("@{}", token)));
        }
        cursor = token_end;
    }

    // Collapse adjacent text segments.
    let mut collapsed: Vec<MessageSegment> = Vec::new();
    for seg in out {
        if let (Some(MessageSegment::Text(prev)), MessageSegment::Text(ref new_text)) =
            (collapsed.last_mut(), &seg)
        {
            prev.push_str(new_text);
        } else {
            collapsed.push(seg);
        }
    }
    collapsed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_write_with_deltas() {
        let c = parse_event("Write src/ui/widgets/badge.rs +62").unwrap();
        assert_eq!(c.kind, ToolCallKind::Write);
        assert_eq!(c.path.as_deref().unwrap().to_string_lossy(), "src/ui/widgets/badge.rs");
        assert_eq!(c.add, Some(62));
        assert_eq!(c.del, None);
    }

    #[test]
    fn parses_edit_with_both_deltas() {
        let c = parse_event("Edit src/foo.rs +10 -4 (ok)").unwrap();
        assert_eq!(c.kind, ToolCallKind::Edit);
        assert_eq!(c.add, Some(10));
        assert_eq!(c.del, Some(4));
        assert_eq!(c.status, ToolCallStatus::Success);
    }

    #[test]
    fn parses_lint_failed() {
        let c = parse_event("Lint (failed)").unwrap();
        assert_eq!(c.kind, ToolCallKind::Lint);
        assert_eq!(c.status, ToolCallStatus::Error);
    }

    #[test]
    fn rejects_plain_prose() {
        assert!(parse_event("I will start by reading the file.").is_none());
    }

    #[test]
    fn file_badges_simple() {
        let segs = split_file_badges("Wrote @src/foo.rs and @bar/baz.ts successfully.");
        assert_eq!(
            segs,
            vec![
                MessageSegment::Text("Wrote ".into()),
                MessageSegment::FileBadge("src/foo.rs".into()),
                MessageSegment::Text(" and ".into()),
                MessageSegment::FileBadge("bar/baz.ts".into()),
                MessageSegment::Text(" successfully.".into()),
            ]
        );
    }

    #[test]
    fn bare_at_is_literal() {
        let segs = split_file_badges("email me @alice");
        assert_eq!(segs, vec![MessageSegment::Text("email me @alice".into())]);
    }
}
