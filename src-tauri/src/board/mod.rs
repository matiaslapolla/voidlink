//! The project board: a kanban surface whose entire storage is a directory of
//! markdown files.
//!
//! This is `crate::brain` applied to a second kind of per-project state, and
//! deliberately so — the properties that made a brain worth keeping as files
//! are exactly the ones a board wants:
//!
//!   * the data outlives the app, and is legible without it;
//!   * it diffs in git, if you choose to track it;
//!   * an editor or an agent can write a card by writing a file, with no API
//!     and no schema migration.
//!
//! ## The layout
//!
//! ```text
//! <repoRoot>/.voidlink/board/
//!   board.md            ← the column declaration, frontmatter only
//!   <card-id>.md        ← one card per file
//! ```
//!
//! **Column membership and ordering live in each card's frontmatter, not in an
//! index.** An index file would be a second source of truth about where a card
//! sits, and it would be wrong the first time anything wrote a card without
//! going through this module — which is the whole point of storing cards as
//! files. `board.md` is not that index: it declares which columns *exist* (so
//! an empty column can), and says nothing about what is in them.
//!
//! ## No commit, ever
//!
//! Same choice as `brain_save_entry`, for the same reason: this writes inside
//! the repository you are working in, and a commit made behind your back lands
//! on your branch in the middle of your change. The write is the whole
//! operation. See `brain/mod.rs`'s note on `brain_save_entry`.
//!
//! ## Concurrent writers
//!
//! A card can be moved by the UI, edited in the editor, and rewritten by an
//! agent at the same time. Every read hands back a `rev` for the file it read,
//! and `board_save_card` refuses a write whose `expected_rev` no longer matches
//! what is on disk. A move is a file write like any other, so it is covered by
//! the same check — dragging a card that someone else just retitled fails
//! loudly instead of silently discarding the retitle.

use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::brain::{parse_flow_array, split_frontmatter, unquote_scalar};

/// Where a project's board lives, relative to its repository root. Sibling of
/// `.voidlink/brain`, under the same per-repo directory the worktree wizard
/// already owns.
const BOARD_DIR: [&str; 2] = [".voidlink", "board"];

/// The column declaration. A file rather than a `board.json` so the whole
/// directory is one format: every `.md` in here opens in the editor and reads
/// as frontmatter, and there is no second parser for the odd one out.
const BOARD_FILE: &str = "board.md";

/// What a board with no `board.md` has. Written out by the first save so the
/// format is discoverable on disk rather than only in this file.
pub const DEFAULT_COLUMNS: [&str; 3] = ["Todo", "Doing", "Done"];

/// Marks a refused write in the error string, so the frontend can tell "someone
/// else changed this card" from "the disk is full" without a typed error
/// channel across the IPC boundary.
pub const CONFLICT_PREFIX: &str = "board-conflict:";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardCard {
    /// The file stem. Also the card's identity everywhere else.
    pub id: String,
    pub title: String,
    /// The declared column this card claims. A card naming a column that
    /// `board.md` does not declare is *not* dropped here — see
    /// `boardModel.ts`, which places it in the first column rather than
    /// letting a typo delete work.
    pub column: String,
    /// Position within its column. A float so inserting between two cards is
    /// their midpoint and rewrites exactly one file.
    pub order: f64,
    pub labels: Vec<String>,
    pub created: Option<String>,
    /// When the card is due, as an ISO `YYYY-MM-DD` date, or `None`.
    ///
    /// Optional in both directions on purpose. Every card written before this
    /// field existed has no `due:` line, and must load rather than fail — a
    /// board is a directory of hand-editable files, so "the field is missing"
    /// is the ordinary state, not a corrupt one. An older build reading a card
    /// this one wrote ignores the line for the same reason.
    pub due: Option<String>,
    /// Board-relative path, e.g. "2026-08-04-wire-the-watcher.md".
    pub path: String,
    /// What was on disk when this was read. Hand it back to
    /// `board_save_card` as `expected_rev`.
    pub rev: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardCardDetail {
    #[serde(flatten)]
    pub meta: BoardCard,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    /// Declared columns, in board order.
    pub columns: Vec<String>,
    pub cards: Vec<BoardCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardWrite {
    /// Repo-relative path written, for the caller to report.
    pub path: String,
    /// The revision the write produced. The caller keeps this as the
    /// `expected_rev` of its next write, so a burst of moves does not have to
    /// round-trip through a list between each one.
    pub rev: String,
}

/// `<repo_root>/.voidlink/board`. Not required to exist: a repo with no board
/// is the common case, and the directory is created by the first write.
fn board_root(repo_root: &str) -> PathBuf {
    let mut p = PathBuf::from(repo_root);
    for segment in BOARD_DIR {
        p.push(segment);
    }
    p
}

/// Reject a card id that is not a single, ordinary file name.
///
/// Stricter than the brain's `reject_unsafe_rel_path` because the board is flat:
/// there are no subdirectories to allow, so anything with a separator, a `..`,
/// a root, or a drive prefix is refused outright rather than component-checked.
/// This is a Tauri IPC boundary and the id reaches the filesystem, so it is
/// validated defensively even though every current caller mints it from a slug.
fn reject_unsafe_card_id(card_id: &str) -> Result<(), String> {
    let invalid = || Err(format!("Invalid card id: {card_id}"));

    if card_id.is_empty() || card_id.contains('/') || card_id.contains('\\') {
        return invalid();
    }
    // Exactly one ordinary component. `..`, `.`, `/etc/passwd` and `C:\x` all
    // fail this, each for its own reason, and none of them needs its own arm.
    let mut components = Path::new(card_id).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => {}
        _ => return invalid(),
    }
    // `board` would write `board.md` — the column declaration, not a card.
    if card_id == board_file_stem() {
        return invalid();
    }
    Ok(())
}

fn board_file_stem() -> &'static str {
    BOARD_FILE.trim_end_matches(".md")
}

/// An opaque "what was on disk when you read it" token.
///
/// mtime alone would not do: two writes inside one filesystem timestamp tick
/// are indistinguishable by it, and on a coarse-grained filesystem that tick is
/// not small. The length goes in as a cheap second dimension. This is a change
/// *detector* rather than a hash — the only question `board_save_card` asks is
/// "is this still the byte sequence the caller read", and any difference is a
/// good enough "no".
fn revision_of(meta: &fs::Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{}", meta.len())
}

/// The current revision of a card file, or `None` when it does not exist.
/// `None` is a meaningful value on both sides of the comparison: it is what a
/// caller creating a new card passes, and what the disk answers for a card
/// somebody deleted underneath them.
fn current_revision(full_path: &Path) -> Option<String> {
    fs::metadata(full_path).ok().map(|m| revision_of(&m))
}

/// Parse a card's flat frontmatter. `id`/`path`/`rev` come from the file's
/// location and metadata, not from the frontmatter — the same split the brain
/// makes, so a hand-edited `id:` line can never disagree with the file name.
fn parse_card(fm: &str, id: String, path: String, rev: String) -> BoardCard {
    let mut title = String::new();
    let mut column = String::new();
    let mut order = 0.0_f64;
    let mut labels = Vec::new();
    let mut created = None;
    let mut due = None;

    for line in fm.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("title:") {
            title = unquote_scalar(rest);
        } else if let Some(rest) = line.strip_prefix("column:") {
            column = unquote_scalar(rest);
        } else if let Some(rest) = line.strip_prefix("order:") {
            // A non-numeric `order:` sorts to the top rather than failing the
            // card. A card is work someone wrote down; a typo in one field of
            // it must not be able to hide it.
            order = unquote_scalar(rest).parse::<f64>().unwrap_or(0.0);
        } else if let Some(rest) = line.strip_prefix("created:") {
            created = Some(unquote_scalar(rest));
        } else if let Some(rest) = line.strip_prefix("due:") {
            // A bare `due:` with nothing after it is a field somebody cleared
            // by hand. Absent and empty mean the same thing — no due date —
            // and collapsing them here is what stops an empty string from
            // reaching the UI's overdue comparison as a date in the year 0.
            let value = unquote_scalar(rest);
            due = if value.is_empty() { None } else { Some(value) };
        } else if let Some(rest) = line.strip_prefix("labels:") {
            labels = parse_flow_array(rest);
        }
    }

    // A card with no `title:` shows as its own id rather than as a blank row.
    if title.is_empty() {
        title = id.clone();
    }

    BoardCard { id, title, column, order, labels, created, due, path, rev }
}

/// The declared columns, or the defaults when `board.md` is absent or says
/// nothing. Absent is the ordinary state of a board nobody has written to yet.
fn read_columns(root: &Path) -> Vec<String> {
    let default = || DEFAULT_COLUMNS.iter().map(|c| c.to_string()).collect();
    let Ok(raw) = fs::read_to_string(root.join(BOARD_FILE)) else {
        return default();
    };
    let (Some(fm), _) = split_frontmatter(&raw) else {
        return default();
    };
    let columns: Vec<String> = fm
        .lines()
        .find_map(|line| line.trim_end().strip_prefix("columns:").map(parse_flow_array))
        .unwrap_or_default();
    if columns.is_empty() {
        default()
    } else {
        columns
    }
}

/// The `board.md` a fresh board gets. Written on the first save rather than
/// shipped as a template: until there is a card there is nothing to declare
/// columns *for*, and a directory created by opening a surface is noise in
/// `git status` for a feature the user only looked at.
fn ensure_board_file(root: &Path) -> Result<(), String> {
    let path = root.join(BOARD_FILE);
    if path.exists() {
        return Ok(());
    }
    let columns = DEFAULT_COLUMNS.join(", ");
    let body = format!(
        "---\ncolumns: [{columns}]\n---\nColumns for this project's board. Rename, reorder or add \
         one here; each card names its column in its own frontmatter.\n"
    );
    fs::write(&path, body).map_err(|e| e.to_string())
}

/// Every card on the board, metadata only, plus the declared columns.
///
/// An absent board directory is an empty board, not an error: every repo starts
/// without one, so "no cards yet" is the ordinary state rather than a
/// misconfiguration to report. The columns still come back, so the surface can
/// render the board it is about to have.
#[tauri::command]
pub fn board_list_cards(repo_root: String) -> Result<BoardSnapshot, String> {
    let root = board_root(&repo_root);
    let columns = read_columns(&root);

    let mut cards = Vec::new();
    if let Ok(read_dir) = fs::read_dir(&root) {
        for entry in read_dir {
            // One unreadable file must not blank the whole board.
            let Ok(entry) = entry else { continue };
            let file_path = entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem == board_file_stem() {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&file_path) else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            let (Some(fm), _) = split_frontmatter(&raw) else { continue };
            cards.push(parse_card(
                fm,
                stem.to_string(),
                format!("{stem}.md"),
                revision_of(&meta),
            ));
        }
    }

    // Ordered here so every consumer sees one sequence. Ties break on id, which
    // is stable across reads — two cards that were handed the same `order` by
    // concurrent writers must not swap places on every refresh.
    cards.sort_by(|a, b| {
        a.order
            .partial_cmp(&b.order)
            .unwrap_or(Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });

    Ok(BoardSnapshot { columns, cards })
}

/// Read one card's frontmatter + body, with the revision it was read at.
#[tauri::command]
pub fn board_read_card(repo_root: String, card_id: String) -> Result<BoardCardDetail, String> {
    reject_unsafe_card_id(&card_id)?;
    let full_path = board_root(&repo_root).join(format!("{card_id}.md"));
    let raw = fs::read_to_string(&full_path).map_err(|e| e.to_string())?;
    let meta = fs::metadata(&full_path).map_err(|e| e.to_string())?;
    let (fm, body) = split_frontmatter(&raw);
    let fm = fm.ok_or_else(|| format!("No frontmatter found in {card_id}.md"))?;

    let meta = parse_card(fm, card_id.clone(), format!("{card_id}.md"), revision_of(&meta));
    Ok(BoardCardDetail { meta, body: body.to_string() })
}

/// Write one card, refusing to clobber a change made since the caller read it.
///
/// `expected_rev` is the `rev` the caller last saw, or `None` when it believes
/// the card does not exist yet. Both halves matter: `None` against an existing
/// file is a card someone else created under the same id, and `Some(_)` against
/// a missing file is a card someone else deleted. Neither is a write we can
/// perform without losing what the other writer did, so both are refused.
///
/// **Nothing is staged or committed.** See the module header.
#[tauri::command]
pub fn board_save_card(
    repo_root: String,
    card_id: String,
    content: String,
    expected_rev: Option<String>,
) -> Result<BoardWrite, String> {
    reject_unsafe_card_id(&card_id)?;

    let root = board_root(&repo_root);
    let full_path = root.join(format!("{card_id}.md"));

    let actual = current_revision(&full_path);
    if actual != expected_rev {
        return Err(match (expected_rev, actual) {
            (None, Some(_)) => format!("{CONFLICT_PREFIX} {card_id} already exists on disk"),
            (Some(_), None) => format!("{CONFLICT_PREFIX} {card_id} was deleted on disk"),
            _ => format!("{CONFLICT_PREFIX} {card_id} changed on disk since you read it"),
        });
    }

    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    ensure_board_file(&root)?;
    fs::write(&full_path, content.as_bytes()).map_err(|e| e.to_string())?;

    let rev = current_revision(&full_path)
        .ok_or_else(|| format!("{card_id}.md disappeared immediately after being written"))?;
    Ok(BoardWrite {
        path: format!("{}/{}/{card_id}.md", BOARD_DIR[0], BOARD_DIR[1]),
        rev,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card_markdown(title: &str, column: &str, order: f64) -> String {
        format!(
            "---\ntitle: \"{title}\"\ncolumn: {column}\norder: {order}\nlabels: [rust]\n\
             created: \"2026-08-04T10:00:00.000-03:00\"\n---\nWhat the card is about.\n"
        )
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
    fn parse_card_reads_column_order_and_labels() {
        let raw = card_markdown("Wire the watcher", "Doing", 1.5);
        let (fm, body) = split_frontmatter(&raw);
        let card = parse_card(
            fm.unwrap(),
            "wire-the-watcher".to_string(),
            "wire-the-watcher.md".to_string(),
            "rev".to_string(),
        );
        assert_eq!(card.title, "Wire the watcher");
        assert_eq!(card.column, "Doing");
        assert_eq!(card.order, 1.5);
        assert_eq!(card.labels, vec!["rust"]);
        assert_eq!(card.created.as_deref(), Some("2026-08-04T10:00:00.000-03:00"));
        assert_eq!(body, "What the card is about.\n");
    }

    /// The exact bytes `buildCardMarkdown` emits for a card with every field
    /// set, quoted from `boardModel.test.ts`'s `EVERY_FIELD_MARKDOWN`.
    ///
    /// The two constants are the round trip: the TypeScript test asserts the
    /// serialiser produces this string, and this one asserts the parser reads
    /// every field back out of it. Neither side can drift without the other
    /// failing, which is the only thing keeping a writer in one language and a
    /// reader in another honest.
    const EVERY_FIELD_MARKDOWN: &str = "---\n\
        id: 2026-08-04-wire-the-watcher\n\
        type: card\n\
        title: \"Wire the watcher\"\n\
        column: \"Doing\"\n\
        order: 1.5\n\
        labels: [\"rust\", \"watch\"]\n\
        created: \"2026-08-04T10:00:00.000-03:00\"\n\
        due: \"2026-08-31\"\n\
        ---\n\
        Why it matters.\n";

    #[test]
    fn parse_card_reads_back_every_field_the_frontend_serialises() {
        let (fm, body) = split_frontmatter(EVERY_FIELD_MARKDOWN);
        let card = parse_card(
            fm.unwrap(),
            "2026-08-04-wire-the-watcher".to_string(),
            "2026-08-04-wire-the-watcher.md".to_string(),
            "rev".to_string(),
        );
        assert_eq!(card.title, "Wire the watcher");
        assert_eq!(card.column, "Doing");
        assert_eq!(card.order, 1.5);
        assert_eq!(card.labels, vec!["rust", "watch"]);
        assert_eq!(card.created.as_deref(), Some("2026-08-04T10:00:00.000-03:00"));
        assert_eq!(card.due.as_deref(), Some("2026-08-31"));
        assert_eq!(body, "Why it matters.\n");
    }

    /// The compatibility claim, both directions.
    ///
    /// A card written before `due:` existed has no such line and must load with
    /// `due: None` rather than failing — otherwise shipping this field would
    /// blank every board that predates it.
    #[test]
    fn a_card_written_before_due_existed_loads_with_no_due_date() {
        let raw = card_markdown("Older card", "Todo", 1.0);
        assert!(!raw.contains("due:"), "the fixture must be a pre-`due` card");
        let (fm, _) = split_frontmatter(&raw);
        let card =
            parse_card(fm.unwrap(), "older".to_string(), "older.md".to_string(), "r".to_string());
        assert_eq!(card.due, None);
        assert_eq!(card.title, "Older card");
    }

    /// A `due:` somebody emptied by hand is no due date, not a date of "".
    #[test]
    fn an_empty_due_line_parses_as_absent() {
        let raw = "---\ntitle: X\ncolumn: Todo\norder: 1\ndue:\n---\nbody\n";
        let (fm, _) = split_frontmatter(raw);
        let card = parse_card(fm.unwrap(), "x".to_string(), "x.md".to_string(), "r".to_string());
        assert_eq!(card.due, None);
    }

    /// The other direction of the compatibility claim: a card carrying fields
    /// this parser has no arm for is still a card. `due:` was one of those
    /// lines until this change, and the next new field will be another.
    #[test]
    fn an_unknown_frontmatter_field_is_ignored_rather_than_failing_the_card() {
        let raw = "---\ntitle: X\ncolumn: Todo\norder: 1\nassignee: nobody\n---\nbody\n";
        let (fm, _) = split_frontmatter(raw);
        let card = parse_card(fm.unwrap(), "x".to_string(), "x.md".to_string(), "r".to_string());
        assert_eq!(card.title, "X");
        assert_eq!(card.column, "Todo");
    }

    /// A field nobody can read must not be able to hide the card.
    #[test]
    fn parse_card_survives_a_missing_title_and_a_junk_order() {
        let raw = "---\ncolumn: Todo\norder: soon\n---\nbody\n";
        let (fm, _) = split_frontmatter(raw);
        let card = parse_card(fm.unwrap(), "orphan".to_string(), "orphan.md".to_string(), "r".into());
        assert_eq!(card.title, "orphan");
        assert_eq!(card.order, 0.0);
    }

    #[test]
    fn reject_unsafe_card_id_blocks_traversal_separators_and_the_column_file() {
        assert!(reject_unsafe_card_id("2026-08-04-wire-the-watcher").is_ok());
        assert!(reject_unsafe_card_id("../../etc/passwd").is_err());
        assert!(reject_unsafe_card_id("/etc/passwd").is_err());
        assert!(reject_unsafe_card_id("..").is_err());
        assert!(reject_unsafe_card_id(".").is_err());
        assert!(reject_unsafe_card_id("a/b").is_err());
        assert!(reject_unsafe_card_id("a\\b").is_err());
        assert!(reject_unsafe_card_id("").is_err());
        // Writing `board.md` as a card would overwrite the column declaration.
        assert!(reject_unsafe_card_id("board").is_err());
    }

    #[test]
    fn save_card_writes_under_dot_voidlink_and_is_read_back_by_list_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        let repo_root = tmp.path().to_string_lossy().to_string();

        let written = board_save_card(
            repo_root.clone(),
            "wire-the-watcher".to_string(),
            card_markdown("Wire the watcher", "Doing", 1.0),
            None,
        )
        .expect("save should succeed");
        assert_eq!(written.path, ".voidlink/board/wire-the-watcher.md");

        // The path is the point: a card written to the repo root instead of
        // under `.voidlink/` would land in the user's tracked tree.
        assert!(tmp.path().join(".voidlink/board/wire-the-watcher.md").is_file());
        // The first save is what puts the format on disk.
        assert!(tmp.path().join(".voidlink/board/board.md").is_file());

        let snapshot = board_list_cards(repo_root.clone()).expect("list should succeed");
        assert_eq!(snapshot.columns, vec!["Todo", "Doing", "Done"]);
        assert_eq!(snapshot.cards.len(), 1, "board.md is not a card");
        assert_eq!(snapshot.cards[0].id, "wire-the-watcher");
        assert_eq!(snapshot.cards[0].column, "Doing");
        assert_eq!(snapshot.cards[0].path, "wire-the-watcher.md");
        assert_eq!(snapshot.cards[0].rev, written.rev);

        let detail = board_read_card(repo_root, "wire-the-watcher".to_string())
            .expect("read should succeed");
        assert_eq!(detail.body, "What the card is about.\n");
        assert_eq!(detail.meta.rev, written.rev);
    }

    #[test]
    fn list_cards_orders_by_order_then_id() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_root = tmp.path().to_string_lossy().to_string();
        for (id, order) in [("c", 3.0), ("a", 1.0), ("b", 2.0)] {
            board_save_card(
                repo_root.clone(),
                id.to_string(),
                card_markdown(id, "Todo", order),
                None,
            )
            .unwrap();
        }
        let ids: Vec<String> = board_list_cards(repo_root)
            .unwrap()
            .cards
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn columns_come_from_board_md_when_it_declares_them() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".voidlink/board");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("board.md"), "---\ncolumns: [Inbox, \"In review\", Shipped]\n---\n")
            .unwrap();

        let snapshot = board_list_cards(tmp.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(snapshot.columns, vec!["Inbox", "In review", "Shipped"]);
    }

    /// Every repo starts without a board, so an absent directory has to read as
    /// "no cards", not as an error — and still name the columns it would have.
    #[test]
    fn list_cards_returns_an_empty_default_board_for_a_repo_with_none() {
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = board_list_cards(tmp.path().to_string_lossy().to_string())
            .expect("an absent board is not an error");
        assert!(snapshot.cards.is_empty());
        assert_eq!(snapshot.columns, vec!["Todo", "Doing", "Done"]);
        assert!(!tmp.path().join(".voidlink").exists(), "listing must not create anything");
    }

    #[test]
    fn save_card_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());

        let result = board_save_card(
            tmp.path().to_string_lossy().to_string(),
            "../../etc/passwd".to_string(),
            "malicious".to_string(),
            None,
        );
        assert!(result.is_err());
        assert!(!tmp.path().parent().unwrap().join("../etc/passwd").exists());
    }

    /// The concurrency claim, exercised: a card edited on disk between the read
    /// and the write is not overwritten.
    #[test]
    fn save_card_refuses_to_clobber_a_change_made_since_the_read() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_root = tmp.path().to_string_lossy().to_string();
        let stale = board_save_card(
            repo_root.clone(),
            "card".to_string(),
            card_markdown("Card", "Todo", 1.0),
            None,
        )
        .unwrap();

        // Somebody else — an editor, an agent — rewrites the file.
        let path = tmp.path().join(".voidlink/board/card.md");
        fs::write(&path, card_markdown("Card, retitled by someone else", "Todo", 1.0)).unwrap();

        let refused = board_save_card(
            repo_root.clone(),
            "card".to_string(),
            card_markdown("Card", "Doing", 1.0),
            Some(stale.rev),
        );
        let message = refused.expect_err("a stale write must be refused");
        assert!(message.starts_with(CONFLICT_PREFIX), "got: {message}");
        assert!(
            fs::read_to_string(&path).unwrap().contains("retitled by someone else"),
            "the other writer's content must survive"
        );

        // Re-reading yields the current rev, and the write then lands.
        let fresh = board_read_card(repo_root.clone(), "card".to_string()).unwrap();
        board_save_card(
            repo_root,
            "card".to_string(),
            card_markdown("Card", "Doing", 1.0),
            Some(fresh.meta.rev),
        )
        .expect("a write from the current rev should land");
    }

    #[test]
    fn save_card_refuses_to_create_over_a_card_that_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let repo_root = tmp.path().to_string_lossy().to_string();
        board_save_card(repo_root.clone(), "dup".into(), card_markdown("A", "Todo", 1.0), None)
            .unwrap();

        let refused =
            board_save_card(repo_root, "dup".into(), card_markdown("B", "Todo", 1.0), None);
        assert!(refused.expect_err("creating twice must be refused").starts_with(CONFLICT_PREFIX));
    }

    /// Same guarantee the brain makes, and for the same reason: this writes
    /// into the repo you are mid-change in.
    #[test]
    fn save_card_neither_commits_nor_stages() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());

        board_save_card(
            tmp.path().to_string_lossy().to_string(),
            "quiet".to_string(),
            card_markdown("Quiet", "Todo", 1.0),
            None,
        )
        .expect("save should succeed");

        assert!(repo.head().is_err(), "no commit should have been created");
        assert_eq!(repo.index().unwrap().len(), 0, "nothing should be staged");
    }
}
