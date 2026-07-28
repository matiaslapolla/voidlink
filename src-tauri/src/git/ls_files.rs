use std::collections::BTreeSet;
use std::path::Path;

use ignore::WalkBuilder;

use super::repo::open_repo;

/// Directories never worth indexing for "open file by name", even when the
/// user asked to see ignored files. These are build/dependency artifacts:
/// including them turns a 2k-path index into a 300k-path one and buries the
/// `.env` the toggle was flipped for. Anything in here that is actually
/// *tracked* still shows up — the index paths are unioned in afterwards.
const HEAVY_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
    "vendor",
];

/// Hard ceiling on indexed paths, so a repo sitting on a huge ignored tree
/// can't hang the picker.
const MAX_PATHS: usize = 50_000;

/// Paths to feed the Cmd+P fuzzy file picker, sorted.
///
/// With `include_ignored` false this is exactly the git index: tracked files
/// only, which is the cheap default. With it true the index is unioned with a
/// filesystem walk that ignores `.gitignore` entirely, so gitignored files
/// (`.env` and friends) and untracked files become openable — minus
/// [`HEAVY_DIRS`], which are pure noise here.
pub(crate) fn git_ls_files_impl(
    repo_path: String,
    include_ignored: bool,
) -> Result<Vec<String>, String> {
    let repo = open_repo(&repo_path)?;
    let index = repo.index().map_err(|e| e.message().to_string())?;
    let mut paths: BTreeSet<String> = index
        .iter()
        .filter_map(|entry| String::from_utf8(entry.path).ok())
        .collect();

    if include_ignored {
        let root = Path::new(&repo_path);
        let mut walker = WalkBuilder::new(root);
        walker
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .ignore(false)
            .filter_entry(|entry| {
                // Depth 0 is the root itself, which must never be filtered out.
                entry.depth() == 0
                    || !entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| HEAVY_DIRS.contains(&name))
            });

        for result in walker.build() {
            if paths.len() >= MAX_PATHS {
                break;
            }
            let Ok(entry) = result else { continue };
            if entry.file_type().is_some_and(|t| t.is_dir()) {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(root) {
                paths.insert(rel.to_string_lossy().to_string());
            }
        }
    }

    Ok(paths.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `.env` is gitignored and untracked, so it only appears when the picker
    /// is asked to include ignored files — and `node_modules` never does.
    #[test]
    fn includes_ignored_paths_only_on_request() {
        let dir = std::env::temp_dir().join("voidlink-ls-files-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), ".env\nnode_modules/\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
        std::fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();
        std::fs::write(dir.join("node_modules/left-pad/index.js"), "").unwrap();

        let path = dir.to_string_lossy().to_string();

        let tracked = git_ls_files_impl(path.clone(), false).unwrap();
        assert!(!tracked.iter().any(|p| p == ".env"));

        let all = git_ls_files_impl(path, true).unwrap();
        assert!(all.iter().any(|p| p == ".env"));
        assert!(all.iter().any(|p| p == ".gitignore"));
        assert!(!all.iter().any(|p| p.starts_with("node_modules")));
        assert!(!all.iter().any(|p| p.starts_with(".git/")));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
