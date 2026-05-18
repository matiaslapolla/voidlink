use git2::{ApplyLocation, ApplyOptions, Diff};

use super::repo::open_repo;
use super::{DiffHunk, FileDiff};

/// Stage (or unstage) a single hunk of a file change. The frontend already
/// owns the parsed `FileDiff` shape, so we accept exactly that — no need to
/// re-derive line ranges on the Rust side.
///
/// `reverse = false` stages a hunk that's currently unstaged (workdir → index).
/// `reverse = true` unstages a hunk that's currently staged (index → workdir).
///
/// Implementation: serialize the file header + the one hunk back to a unified
/// patch text and let libgit2's `apply` reconcile it. This is the same trick
/// `git add -p` uses internally.
pub(crate) fn git_apply_hunk_impl(
    repo_path: String,
    file: FileDiff,
    hunk_index: usize,
    reverse: bool,
) -> Result<(), String> {
    let repo = open_repo(&repo_path)?;
    let hunk = file
        .hunks
        .get(hunk_index)
        .ok_or_else(|| format!("hunk index {} out of range", hunk_index))?;

    let patch_text = build_unified_patch(&file, hunk);
    let diff =
        Diff::from_buffer(patch_text.as_bytes()).map_err(|e| e.message().to_string())?;

    let mut opts = ApplyOptions::new();
    opts.check(false);
    if reverse {
        // libgit2's reverse flag is via diff options before apply isn't a thing;
        // for unstaging we instead apply the inverse patch to the index.
        let inverted = build_unified_patch_inverted(&file, hunk);
        let diff_inv = Diff::from_buffer(inverted.as_bytes())
            .map_err(|e| e.message().to_string())?;
        repo.apply(&diff_inv, ApplyLocation::Index, Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
    } else {
        repo.apply(&diff, ApplyLocation::Index, Some(&mut opts))
            .map_err(|e| e.message().to_string())?;
    }
    Ok(())
}

fn build_unified_patch(file: &FileDiff, hunk: &DiffHunk) -> String {
    let old_path = file
        .old_path
        .clone()
        .or_else(|| file.new_path.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let new_path = file
        .new_path
        .clone()
        .or_else(|| file.old_path.clone())
        .unwrap_or_else(|| "unknown".to_string());

    // For renames + copies we'd need proper `rename from`/`rename to` (or
    // `copy from`/`copy to`) headers plus a similarity index, and libgit2's
    // apply is picky about all of it. Hunk-level staging of a rename is also
    // semantically weird (you can't stage half a rename). Treat both as if
    // the file lives at the new path only — the hunk gets applied, the
    // rename itself stays unstaged for the user to handle as a whole file.
    let treat_as = if matches!(file.status.as_str(), "renamed" | "copied") {
        "modified"
    } else {
        file.status.as_str()
    };
    let effective_old = if treat_as == "modified" && file.status != "modified" {
        new_path.clone()
    } else {
        old_path
    };

    let mut out = String::new();
    out.push_str(&format!("diff --git a/{} b/{}\n", effective_old, new_path));
    match treat_as {
        "added" => {
            out.push_str("new file mode 100644\n");
            out.push_str("--- /dev/null\n");
            out.push_str(&format!("+++ b/{}\n", new_path));
        }
        "deleted" => {
            out.push_str("deleted file mode 100644\n");
            out.push_str(&format!("--- a/{}\n", effective_old));
            out.push_str("+++ /dev/null\n");
        }
        _ => {
            out.push_str(&format!("--- a/{}\n", effective_old));
            out.push_str(&format!("+++ b/{}\n", new_path));
        }
    }

    // Recompute hunk counts from the lines we're actually shipping. The
    // `~` origin covers both regular context lines AND libgit2's
    // "no newline at end of file" pseudo-lines (content starts with "\ ");
    // only the former contribute to hunk line counts.
    let mut old_lines = 0u32;
    let mut new_lines = 0u32;
    for line in &hunk.lines {
        if is_eof_marker(line) {
            continue;
        }
        match line.origin.as_str() {
            "+" => new_lines += 1,
            "-" => old_lines += 1,
            _ => {
                new_lines += 1;
                old_lines += 1;
            }
        }
    }
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk.old_start, old_lines, hunk.new_start, new_lines
    ));
    for line in &hunk.lines {
        if is_eof_marker(line) {
            // Emit as-is; the leading "\ " is part of the marker itself.
            out.push_str(&line.content);
            out.push('\n');
            continue;
        }
        let prefix = match line.origin.as_str() {
            "+" => '+',
            "-" => '-',
            _ => ' ',
        };
        out.push(prefix);
        out.push_str(&line.content);
        out.push('\n');
    }
    out
}

fn is_eof_marker(line: &super::DiffLine) -> bool {
    line.content.starts_with("\\ ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::DiffLine;
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use std::path::Path;

    fn line(origin: &str, content: &str, old: Option<u32>, new: Option<u32>) -> DiffLine {
        DiffLine {
            origin: origin.to_string(),
            content: content.to_string(),
            old_lineno: old,
            new_lineno: new,
        }
    }

    fn init_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("user.name", "test").unwrap();
            cfg.set_str("user.email", "test@example.com").unwrap();
        }
        repo
    }

    fn commit_all(repo: &Repository, msg: &str) {
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap();
    }

    #[test]
    fn unified_patch_counts_match_lines_shipped() {
        let file = FileDiff {
            old_path: Some("a.txt".to_string()),
            new_path: Some("a.txt".to_string()),
            status: "modified".to_string(),
            hunks: vec![],
            is_binary: false,
            additions: 0,
            deletions: 0,
        };
        let hunk = DiffHunk {
            old_start: 1,
            old_lines: 3,
            new_start: 1,
            new_lines: 3,
            header: "@@ -1,3 +1,3 @@".to_string(),
            lines: vec![
                line(" ", "before context", Some(1), Some(1)),
                line("-", "old middle", Some(2), None),
                line("+", "new middle", None, Some(2)),
                line(" ", "after context", Some(3), Some(3)),
            ],
        };
        let patch = build_unified_patch(&file, &hunk);
        // Three old lines (context + del + context), three new lines (context + add + context).
        assert!(patch.contains("@@ -1,3 +1,3 @@"), "got: {}", patch);
        assert!(patch.contains("-old middle"));
        assert!(patch.contains("+new middle"));
    }

    #[test]
    fn eof_marker_does_not_count_toward_line_totals() {
        let file = FileDiff {
            old_path: Some("a.txt".to_string()),
            new_path: Some("a.txt".to_string()),
            status: "modified".to_string(),
            hunks: vec![],
            is_binary: false,
            additions: 0,
            deletions: 0,
        };
        let hunk = DiffHunk {
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: "@@ -1 +1 @@".to_string(),
            lines: vec![
                line("-", "old", Some(1), None),
                line("+", "new", None, Some(1)),
                line("~", "\\ No newline at end of file", None, None),
            ],
        };
        let patch = build_unified_patch(&file, &hunk);
        // 1 old + 1 new. The marker line is emitted as-is, no leading space.
        assert!(patch.contains("@@ -1,1 +1,1 @@"), "got: {}", patch);
        assert!(patch.contains("\n\\ No newline at end of file\n"), "got: {}", patch);
        assert!(!patch.contains(" \\ No newline"), "marker leaked a leading space: {}", patch);
    }

    #[test]
    fn rename_is_treated_as_modification_against_new_path() {
        let file = FileDiff {
            old_path: Some("old.txt".to_string()),
            new_path: Some("new.txt".to_string()),
            status: "renamed".to_string(),
            hunks: vec![],
            is_binary: false,
            additions: 0,
            deletions: 0,
        };
        let hunk = DiffHunk {
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: "@@ -1 +1 @@".to_string(),
            lines: vec![
                line("-", "old", Some(1), None),
                line("+", "new", None, Some(1)),
            ],
        };
        let patch = build_unified_patch(&file, &hunk);
        // Both sides should be the new path; no "rename from/to" headers
        // (which we'd need to fabricate and libgit2 would reject anyway).
        assert!(patch.starts_with("diff --git a/new.txt b/new.txt"), "got: {}", patch);
        assert!(!patch.contains("old.txt"), "old path leaked: {}", patch);
    }

    #[test]
    fn full_round_trip_stages_a_hunk() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = init_repo(tmp.path());
        let file_path = tmp.path().join("hello.txt");
        fs::write(&file_path, "line1\nline2\nline3\n").unwrap();
        commit_all(&repo, "init");
        // Now modify line 2.
        fs::write(&file_path, "line1\nLINE2\nline3\n").unwrap();

        let file = FileDiff {
            old_path: Some("hello.txt".to_string()),
            new_path: Some("hello.txt".to_string()),
            status: "modified".to_string(),
            hunks: vec![DiffHunk {
                old_start: 1,
                old_lines: 3,
                new_start: 1,
                new_lines: 3,
                header: "@@ -1,3 +1,3 @@".to_string(),
                lines: vec![
                    line(" ", "line1", Some(1), Some(1)),
                    line("-", "line2", Some(2), None),
                    line("+", "LINE2", None, Some(2)),
                    line(" ", "line3", Some(3), Some(3)),
                ],
            }],
            is_binary: false,
            additions: 1,
            deletions: 1,
        };

        git_apply_hunk_impl(
            tmp.path().to_string_lossy().to_string(),
            file,
            0,
            false,
        )
        .expect("apply should succeed");

        // The index should now reflect the modification (staged).
        let staged = git_diff_tree_to_index(&repo);
        assert!(staged.contains("LINE2"), "index did not pick up change: {}", staged);
    }

    fn git_diff_tree_to_index(repo: &Repository) -> String {
        let head_tree = repo.head().unwrap().peel_to_tree().unwrap();
        let diff = repo.diff_tree_to_index(Some(&head_tree), None, None).unwrap();
        let mut out = String::new();
        diff.print(git2::DiffFormat::Patch, |_d, _h, line| {
            if let Ok(s) = std::str::from_utf8(line.content()) {
                out.push_str(s);
            }
            true
        })
        .unwrap();
        out
    }
}

fn build_unified_patch_inverted(file: &FileDiff, hunk: &DiffHunk) -> String {
    // Swap +/- to invert. We also swap old/new line numbers so the hunk header
    // is still valid in the inverted patch.
    let old_path = file
        .old_path
        .clone()
        .or_else(|| file.new_path.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let new_path = file
        .new_path
        .clone()
        .or_else(|| file.old_path.clone())
        .unwrap_or_else(|| "unknown".to_string());

    let mut out = String::new();
    out.push_str(&format!("diff --git a/{} b/{}\n", new_path, old_path));
    out.push_str(&format!("--- a/{}\n", new_path));
    out.push_str(&format!("+++ b/{}\n", old_path));

    let mut old_lines = 0u32;
    let mut new_lines = 0u32;
    for line in &hunk.lines {
        if is_eof_marker(line) {
            continue;
        }
        match line.origin.as_str() {
            "+" => old_lines += 1,
            "-" => new_lines += 1,
            _ => {
                new_lines += 1;
                old_lines += 1;
            }
        }
    }
    out.push_str(&format!(
        "@@ -{},{} +{},{} @@\n",
        hunk.new_start, old_lines, hunk.old_start, new_lines
    ));
    for line in &hunk.lines {
        if is_eof_marker(line) {
            out.push_str(&line.content);
            out.push('\n');
            continue;
        }
        let prefix = match line.origin.as_str() {
            "+" => '-',
            "-" => '+',
            _ => ' ',
        };
        out.push(prefix);
        out.push_str(&line.content);
        out.push('\n');
    }
    out
}
