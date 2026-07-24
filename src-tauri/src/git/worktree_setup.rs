//! Everything that stops a freshly-created `git worktree` from actually
//! booting: the gitignored `.env*` files that never get committed, and the
//! dependency directories that are equally absent.
//!
//! All of the real work lives in pure(ish) functions taking explicit paths, so
//! they can be exercised against a `tempfile::TempDir` without a Tauri runtime.
//! The `#[tauri::command]` wrappers in `git/mod.rs` are thin shells over these.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

/// Directories we never descend into while looking for `.env*` files. Scanning
/// a `node_modules` for env files is both slow and wrong — anything in there
/// belongs to a dependency, not to the user's app.
const SCAN_SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "dist",
    "build",
    ".next",
    ".turbo",
    "vendor",
];

/// How deep to look for `.env*` files. Deep enough for a monorepo's
/// `apps/web/.env.local`, shallow enough to stay instant.
const SCAN_MAX_DEPTH: usize = 4;

/// One `.env*`-shaped file found in the source worktree. `gitignored` is the
/// bit that matters: a committed `.env.example` is already in the new worktree
/// and copying it would be noise, while an ignored `.env.local` is exactly what
/// the user needs carried over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFileCandidate {
    /// Path relative to the worktree root, with `/` separators.
    pub rel_path: String,
    pub size: u64,
    pub gitignored: bool,
}

/// A dependency directory we know how to populate, inferred from a lockfile or
/// manifest sitting at the worktree root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepDirCandidate {
    /// Directory name relative to the worktree root, e.g. `node_modules`.
    pub dir: String,
    /// Which toolchain claimed it: npm / pnpm / yarn / bun / python / cargo.
    pub manager: String,
    /// The marker file that gave it away, e.g. `pnpm-lock.yaml`.
    pub detected_from: String,
    /// The command that would populate it from scratch.
    pub install_command: String,
    /// What we suggest doing, absent a saved per-repo default.
    pub default_action: DepAction,
    /// Whether the directory actually exists in the source worktree. Symlink
    /// and copy are meaningless when it doesn't.
    pub exists_in_source: bool,
}

/// What to do about one dependency directory in the new worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DepAction {
    /// Symlink the new worktree's directory at the source's. Instant, and the
    /// right default for `node_modules` in the overwhelmingly common case
    /// where both worktrees are on compatible dependency sets.
    Symlink,
    /// Recursive copy. Slower but isolated — the two worktrees can diverge.
    Copy,
    /// Leave it to the post-create command (which we prefill with the install
    /// command). We never shell out to a package manager ourselves.
    Install,
    /// Do nothing at all.
    Skip,
}

/// Per-repo answers, remembered at `<repoRoot>/.voidlink/worktree.json` so the
/// second worktree in a repo is one confirm click.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDefaults {
    /// Relative paths of env files to copy.
    #[serde(default)]
    pub env_files: Vec<String>,
    /// Directory name → action.
    #[serde(default)]
    pub dep_actions: BTreeMap<String, DepAction>,
    #[serde(default)]
    pub post_create_command: String,
    /// Set once we've told the user `.voidlink/` isn't gitignored, so the
    /// warning doesn't nag on every worktree.
    #[serde(default)]
    pub warned_not_gitignored: bool,
}

/// Everything the wizard needs to render its first screen.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupPlan {
    pub env_files: Vec<EnvFileCandidate>,
    pub dep_dirs: Vec<DepDirCandidate>,
    /// Prefill for the post-create command box.
    pub suggested_post_create: String,
    /// Saved answers for this repo, if any.
    pub defaults: Option<WorktreeDefaults>,
    /// Whether `.voidlink/` is covered by the repo's ignore rules. False means
    /// we should warn once before writing defaults into it.
    pub voidlink_gitignored: bool,
}

/// The outcome of one setup step. We report every step individually — a
/// half-applied setup that claims success is worse than one that says exactly
/// which part failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStep {
    /// What was attempted, e.g. `copy .env.local` or `symlink node_modules`.
    pub label: String,
    pub ok: bool,
    /// Present only when `ok` is false.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetupReport {
    pub steps: Vec<SetupStep>,
    /// Commands the caller should run in a terminal inside the new worktree
    /// (the `Install` action contributes here). We never execute them: the
    /// user watches the output stream in a real PTY.
    pub pending_commands: Vec<String>,
}

/// Test-only convenience. The frontend derives the same count from `steps`
/// directly, so shipping it in the binary would be dead weight.
#[cfg(test)]
impl WorktreeSetupReport {
    pub fn failures(&self) -> usize {
        self.steps.iter().filter(|s| !s.ok).count()
    }
}

// ─── Ignore rules ────────────────────────────────────────────────────────────

/// Build a matcher from the repo's own ignore sources: the root `.gitignore`,
/// `.git/info/exclude`, and the user's global excludesfile. Deliberately does
/// not shell out — this keeps every scan function testable and fast.
fn build_ignore(root: &Path) -> Gitignore {
    let mut builder = GitignoreBuilder::new(root);
    builder.add(root.join(".gitignore"));
    builder.add(root.join(".git/info/exclude"));
    if let Some(global) = ignore::gitignore::gitconfig_excludes_path() {
        builder.add(global);
    }
    builder.build().unwrap_or_else(|_| Gitignore::empty())
}

fn is_ignored(matcher: &Gitignore, root: &Path, path: &Path, is_dir: bool) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    matcher.matched_path_or_any_parents(rel, is_dir).is_ignore()
}

// ─── Env file scanning ───────────────────────────────────────────────────────

/// Find every `.env`-prefixed file under `root`, flagged by whether the repo's
/// ignore rules cover it. Returns them sorted by relative path so the wizard's
/// checklist is stable between runs.
///
/// Note that we walk with the standard filters *off* — the files we care about
/// are precisely the ignored ones, so letting the walker skip them would find
/// nothing.
pub(crate) fn scan_env_files(root: &Path) -> Result<Vec<EnvFileCandidate>, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let matcher = build_ignore(root);
    let mut out: Vec<EnvFileCandidate> = Vec::new();

    let walker = WalkBuilder::new(root)
        .standard_filters(false)
        .hidden(false)
        .max_depth(Some(SCAN_MAX_DEPTH))
        .filter_entry(|entry| {
            if entry.file_type().is_some_and(|t| t.is_dir()) {
                let name = entry.file_name().to_string_lossy();
                return !SCAN_SKIP_DIRS.contains(&name.as_ref());
            }
            true
        })
        .build();

    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(".env") {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(EnvFileCandidate {
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
            gitignored: is_ignored(&matcher, root, path, false),
            rel_path: rel,
        });
    }

    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

// ─── Dependency directory detection ──────────────────────────────────────────

/// Map lockfiles / manifests at the worktree root onto the directory each one
/// populates. Order matters: the first JS lockfile found wins, because a repo
/// with both `package-lock.json` and `pnpm-lock.yaml` still only has one
/// `node_modules` and offering it twice would be nonsense.
pub(crate) fn detect_dep_dirs(root: &Path) -> Vec<DepDirCandidate> {
    let mut out: Vec<DepDirCandidate> = Vec::new();

    const JS: &[(&str, &str, &str)] = &[
        ("pnpm-lock.yaml", "pnpm", "pnpm install"),
        ("bun.lockb", "bun", "bun install"),
        ("yarn.lock", "yarn", "yarn install"),
        ("package-lock.json", "npm", "npm install"),
    ];
    for (marker, manager, install) in JS {
        if !root.join(marker).exists() {
            continue;
        }
        out.push(DepDirCandidate {
            dir: "node_modules".into(),
            manager: (*manager).into(),
            detected_from: (*marker).into(),
            install_command: (*install).into(),
            // Symlinking node_modules is what makes a new worktree usable in a
            // second instead of a minute, and both worktrees almost always
            // share a dependency set.
            default_action: DepAction::Symlink,
            exists_in_source: root.join("node_modules").is_dir(),
        });
        break;
    }

    const PY: &[(&str, &str)] = &[
        ("uv.lock", "uv sync"),
        ("poetry.lock", "poetry install"),
        ("requirements.txt", "pip install -r requirements.txt"),
    ];
    for (marker, install) in PY {
        if !root.join(marker).exists() {
            continue;
        }
        out.push(DepDirCandidate {
            dir: ".venv".into(),
            manager: "python".into(),
            detected_from: (*marker).into(),
            install_command: (*install).into(),
            // A virtualenv bakes absolute paths into its scripts, so copying or
            // symlinking one into a new directory produces subtly broken tools.
            default_action: DepAction::Skip,
            exists_in_source: root.join(".venv").is_dir(),
        });
        break;
    }

    if root.join("Cargo.toml").exists() {
        out.push(DepDirCandidate {
            dir: "target".into(),
            manager: "cargo".into(),
            detected_from: "Cargo.toml".into(),
            install_command: "cargo build".into(),
            // `target` is huge and cargo is happy to rebuild; sharing it across
            // worktrees also invites lock contention.
            default_action: DepAction::Skip,
            exists_in_source: root.join("target").is_dir(),
        });
    }

    out
}

/// Prefill for the post-create command box: the install command of the first
/// detected dependency directory, or empty when we detected nothing.
pub(crate) fn suggested_post_create(dep_dirs: &[DepDirCandidate]) -> String {
    dep_dirs
        .first()
        .map(|d| d.install_command.clone())
        .unwrap_or_default()
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/// Copy one file from `source` to `dest`, creating parent directories. Returns
/// the step record rather than a bare Result so the caller can report partial
/// success without inventing labels.
pub(crate) fn copy_env_file(source_root: &Path, dest_root: &Path, rel: &str) -> SetupStep {
    let label = format!("copy {rel}");
    let from = source_root.join(rel);
    let to = dest_root.join(rel);
    if !from.is_file() {
        return SetupStep {
            label,
            ok: false,
            error: Some(format!("source file is gone: {}", from.display())),
        };
    }
    if let Some(parent) = to.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return SetupStep { label, ok: false, error: Some(e.to_string()) };
        }
    }
    match fs::copy(&from, &to) {
        Ok(_) => SetupStep { label, ok: true, error: None },
        Err(e) => SetupStep { label, ok: false, error: Some(e.to_string()) },
    }
}

/// Apply one dependency-directory decision. `Install` performs no filesystem
/// work — it hands the command back for the caller to run in a terminal.
pub(crate) fn apply_dep_dir(
    source_root: &Path,
    dest_root: &Path,
    candidate: &DepDirCandidate,
    action: DepAction,
) -> (SetupStep, Option<String>) {
    let dir = candidate.dir.as_str();
    let from = source_root.join(dir);
    let to = dest_root.join(dir);

    let step = |ok: bool, label: String, error: Option<String>| SetupStep { label, ok, error };

    match action {
        DepAction::Skip => (step(true, format!("skip {dir}"), None), None),
        DepAction::Install => (
            step(true, format!("install {dir} after create"), None),
            Some(candidate.install_command.clone()),
        ),
        DepAction::Symlink | DepAction::Copy => {
            let verb = if action == DepAction::Symlink { "symlink" } else { "copy" };
            let label = format!("{verb} {dir}");
            if !from.is_dir() {
                return (
                    step(
                        false,
                        label,
                        Some(format!("{dir} does not exist in the source worktree")),
                    ),
                    None,
                );
            }
            if to.exists() {
                return (
                    step(false, label, Some(format!("{} already exists", to.display()))),
                    None,
                );
            }
            let result = if action == DepAction::Symlink {
                symlink_dir(&from, &to)
            } else {
                copy_dir_recursive(&from, &to)
            };
            match result {
                Ok(()) => (step(true, label, None), None),
                Err(e) => (step(false, label, Some(e)), None),
            }
        }
    }
}

#[cfg(unix)]
fn symlink_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(from, to).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn symlink_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_dir(from, to).map_err(|e| e.to_string())
}

/// Depth-first recursive copy. Symlinks inside the tree are recreated as
/// symlinks rather than followed, so a `node_modules` full of workspace links
/// doesn't explode into duplicated trees (or loop forever).
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let entries = fs::read_dir(from).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if file_type.is_symlink() {
            let target = fs::read_link(&src).map_err(|e| e.to_string())?;
            symlink_dir(&target, &dst)?;
        } else if file_type.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ─── Per-repo defaults ───────────────────────────────────────────────────────

fn defaults_path(repo_root: &Path) -> PathBuf {
    repo_root.join(".voidlink").join("worktree.json")
}

pub(crate) fn read_defaults(repo_root: &Path) -> Option<WorktreeDefaults> {
    let raw = fs::read_to_string(defaults_path(repo_root)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(crate) fn write_defaults(
    repo_root: &Path,
    defaults: &WorktreeDefaults,
) -> Result<(), String> {
    let path = defaults_path(repo_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(defaults).map_err(|e| e.to_string())?;
    fs::write(&path, body).map_err(|e| e.to_string())
}

/// Whether the repo's ignore rules already cover `.voidlink/`. Used to warn
/// once before we start writing per-repo state the user might commit by
/// accident.
pub(crate) fn is_voidlink_gitignored(repo_root: &Path) -> bool {
    let matcher = build_ignore(repo_root);
    matcher.matched_path_or_any_parents(Path::new(".voidlink"), true).is_ignore()
}

// ─── Orchestration (still pure w.r.t. Tauri) ─────────────────────────────────

pub(crate) fn build_plan(repo_root: &Path, source_root: &Path) -> Result<WorktreeSetupPlan, String> {
    let env_files = scan_env_files(source_root)?;
    let dep_dirs = detect_dep_dirs(source_root);
    let suggested = suggested_post_create(&dep_dirs);
    Ok(WorktreeSetupPlan {
        env_files,
        dep_dirs,
        suggested_post_create: suggested,
        defaults: read_defaults(repo_root),
        voidlink_gitignored: is_voidlink_gitignored(repo_root),
    })
}

/// Run the chosen setup against a worktree that already exists on disk.
/// Every step is recorded; none of them abort the rest. The caller decides how
/// loudly to report `report.failures()`.
pub(crate) fn apply_setup(
    source_root: &Path,
    dest_root: &Path,
    env_files: &[String],
    dep_actions: &BTreeMap<String, DepAction>,
) -> Result<WorktreeSetupReport, String> {
    if !dest_root.is_dir() {
        return Err(format!(
            "worktree directory does not exist: {}",
            dest_root.display()
        ));
    }
    let mut steps = Vec::new();
    let mut pending = Vec::new();

    for rel in env_files {
        steps.push(copy_env_file(source_root, dest_root, rel));
    }

    let candidates = detect_dep_dirs(source_root);
    for (dir, action) in dep_actions {
        let candidate = candidates.iter().find(|c| &c.dir == dir).cloned().unwrap_or(
            // The wizard offered it, so honour it even if detection no longer
            // agrees (a lockfile could have been deleted mid-wizard).
            DepDirCandidate {
                dir: dir.clone(),
                manager: "unknown".into(),
                detected_from: String::new(),
                install_command: String::new(),
                default_action: DepAction::Skip,
                exists_in_source: source_root.join(dir).is_dir(),
            },
        );
        let (step, cmd) = apply_dep_dir(source_root, dest_root, &candidate, *action);
        steps.push(step);
        if let Some(cmd) = cmd {
            if !cmd.is_empty() {
                pending.push(cmd);
            }
        }
    }

    Ok(WorktreeSetupReport { steps, pending_commands: pending })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    fn write(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(path).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    // ── gitignored .env* detection ───────────────────────────────────────

    #[test]
    fn flags_env_files_by_gitignore_status() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        write(root, ".gitignore", ".env\n.env.*\n!.env.example\n");
        write(root, ".env", "SECRET=1\n");
        write(root, ".env.local", "SECRET=2\n");
        write(root, ".env.example", "SECRET=\n");

        let found = scan_env_files(root).unwrap();
        let by_path: BTreeMap<_, _> =
            found.iter().map(|c| (c.rel_path.as_str(), c.gitignored)).collect();

        assert_eq!(by_path.get(".env"), Some(&true));
        assert_eq!(by_path.get(".env.local"), Some(&true));
        // Negated by `!.env.example` — committed, so not worth copying.
        assert_eq!(by_path.get(".env.example"), Some(&false));
    }

    #[test]
    fn finds_nested_env_files_but_skips_dependency_dirs() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        write(root, ".gitignore", ".env*\nnode_modules/\n");
        write(root, "apps/web/.env.local", "A=1\n");
        write(root, "node_modules/pkg/.env", "NOPE=1\n");
        write(root, ".git/.env", "NOPE=2\n");

        let found = scan_env_files(root).unwrap();
        let paths: Vec<&str> = found.iter().map(|c| c.rel_path.as_str()).collect();

        assert_eq!(paths, vec!["apps/web/.env.local"]);
        assert!(found[0].gitignored);
    }

    #[test]
    fn env_scan_reports_size_and_is_sorted() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        write(root, ".env.production", "B=2\n");
        write(root, ".env.development", "A=1\n");

        let found = scan_env_files(root).unwrap();
        let paths: Vec<&str> = found.iter().map(|c| c.rel_path.as_str()).collect();
        assert_eq!(paths, vec![".env.development", ".env.production"]);
        assert_eq!(found[0].size, 4);
        // No .gitignore at all → nothing is ignored.
        assert!(found.iter().all(|c| !c.gitignored));
    }

    #[test]
    fn env_scan_rejects_a_non_directory() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "file.txt", "x");
        assert!(scan_env_files(&dir.path().join("file.txt")).is_err());
    }

    // ── package-manager detection per lockfile ───────────────────────────

    #[test]
    fn detects_each_javascript_lockfile() {
        for (marker, manager, install) in [
            ("package-lock.json", "npm", "npm install"),
            ("pnpm-lock.yaml", "pnpm", "pnpm install"),
            ("yarn.lock", "yarn", "yarn install"),
            ("bun.lockb", "bun", "bun install"),
        ] {
            let dir = TempDir::new().unwrap();
            write(dir.path(), marker, "");
            let dirs = detect_dep_dirs(dir.path());
            assert_eq!(dirs.len(), 1, "{marker}");
            assert_eq!(dirs[0].dir, "node_modules");
            assert_eq!(dirs[0].manager, manager);
            assert_eq!(dirs[0].install_command, install);
            assert_eq!(dirs[0].default_action, DepAction::Symlink);
            assert!(!dirs[0].exists_in_source);
        }
    }

    #[test]
    fn detects_python_and_cargo_and_defaults_them_to_skip() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "uv.lock", "");
        write(dir.path(), "Cargo.toml", "[package]\n");

        let dirs = detect_dep_dirs(dir.path());
        let venv = dirs.iter().find(|d| d.dir == ".venv").expect("venv");
        let target = dirs.iter().find(|d| d.dir == "target").expect("target");

        assert_eq!(venv.manager, "python");
        assert_eq!(venv.install_command, "uv sync");
        assert_eq!(venv.default_action, DepAction::Skip);
        assert_eq!(target.manager, "cargo");
        assert_eq!(target.default_action, DepAction::Skip);
    }

    #[test]
    fn offers_node_modules_only_once_when_several_lockfiles_exist() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "package-lock.json", "");
        write(dir.path(), "pnpm-lock.yaml", "");

        let dirs = detect_dep_dirs(dir.path());
        assert_eq!(dirs.len(), 1);
        // pnpm is checked first, so it wins.
        assert_eq!(dirs[0].manager, "pnpm");
    }

    #[test]
    fn detects_nothing_in_a_bare_directory() {
        let dir = TempDir::new().unwrap();
        assert!(detect_dep_dirs(dir.path()).is_empty());
        assert_eq!(suggested_post_create(&[]), "");
    }

    #[test]
    fn suggests_the_first_detected_install_command() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "pnpm-lock.yaml", "");
        let dirs = detect_dep_dirs(dir.path());
        assert_eq!(suggested_post_create(&dirs), "pnpm install");
    }

    #[test]
    fn marks_an_existing_dependency_directory() {
        let dir = TempDir::new().unwrap();
        write(dir.path(), "package-lock.json", "");
        fs::create_dir_all(dir.path().join("node_modules")).unwrap();
        assert!(detect_dep_dirs(dir.path())[0].exists_in_source);
    }

    // ── copy / symlink apply step ────────────────────────────────────────

    fn source_and_dest() -> (TempDir, PathBuf, PathBuf) {
        let dir = TempDir::new().unwrap();
        let source = dir.path().join("source");
        let dest = dir.path().join("dest");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&dest).unwrap();
        (dir, source, dest)
    }

    #[test]
    fn copies_env_files_including_nested_ones() {
        let (_g, source, dest) = source_and_dest();
        write(&source, ".env.local", "TOKEN=abc\n");
        write(&source, "apps/web/.env", "PORT=3000\n");

        let mut actions = BTreeMap::new();
        actions.insert("node_modules".to_string(), DepAction::Skip);
        let report = apply_setup(
            &source,
            &dest,
            &[".env.local".into(), "apps/web/.env".into()],
            &actions,
        )
        .unwrap();

        assert_eq!(report.failures(), 0, "{:?}", report.steps);
        assert_eq!(fs::read_to_string(dest.join(".env.local")).unwrap(), "TOKEN=abc\n");
        assert_eq!(fs::read_to_string(dest.join("apps/web/.env")).unwrap(), "PORT=3000\n");
    }

    #[test]
    fn reports_a_missing_env_file_instead_of_silently_continuing() {
        let (_g, source, dest) = source_and_dest();
        let report =
            apply_setup(&source, &dest, &[".env.gone".into()], &BTreeMap::new()).unwrap();

        assert_eq!(report.failures(), 1);
        assert!(report.steps[0].error.as_deref().unwrap().contains("source file is gone"));
    }

    #[test]
    fn symlinks_a_dependency_directory() {
        let (_g, source, dest) = source_and_dest();
        write(&source, "package-lock.json", "");
        write(&source, "node_modules/pkg/index.js", "module.exports = 1\n");

        let mut actions = BTreeMap::new();
        actions.insert("node_modules".to_string(), DepAction::Symlink);
        let report = apply_setup(&source, &dest, &[], &actions).unwrap();

        assert_eq!(report.failures(), 0, "{:?}", report.steps);
        let link = dest.join("node_modules");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(link.join("pkg/index.js")).unwrap(),
            "module.exports = 1\n"
        );
    }

    #[test]
    fn copies_a_dependency_directory_as_an_independent_tree() {
        let (_g, source, dest) = source_and_dest();
        write(&source, "package-lock.json", "");
        write(&source, "node_modules/pkg/index.js", "one\n");

        let mut actions = BTreeMap::new();
        actions.insert("node_modules".to_string(), DepAction::Copy);
        let report = apply_setup(&source, &dest, &[], &actions).unwrap();
        assert_eq!(report.failures(), 0, "{:?}", report.steps);

        let copied = dest.join("node_modules/pkg/index.js");
        assert!(!fs::symlink_metadata(dest.join("node_modules"))
            .unwrap()
            .file_type()
            .is_symlink());
        // Mutating the copy must not touch the source.
        write(&dest, "node_modules/pkg/index.js", "two\n");
        assert_eq!(fs::read_to_string(&copied).unwrap(), "two\n");
        assert_eq!(
            fs::read_to_string(source.join("node_modules/pkg/index.js")).unwrap(),
            "one\n"
        );
    }

    #[test]
    fn refuses_to_clobber_an_existing_destination_directory() {
        let (_g, source, dest) = source_and_dest();
        write(&source, "package-lock.json", "");
        fs::create_dir_all(source.join("node_modules")).unwrap();
        fs::create_dir_all(dest.join("node_modules")).unwrap();

        let mut actions = BTreeMap::new();
        actions.insert("node_modules".to_string(), DepAction::Symlink);
        let report = apply_setup(&source, &dest, &[], &actions).unwrap();

        assert_eq!(report.failures(), 1);
        assert!(report.steps[0].error.as_deref().unwrap().contains("already exists"));
    }

    #[test]
    fn install_action_defers_to_a_command_instead_of_touching_disk() {
        let (_g, source, dest) = source_and_dest();
        write(&source, "pnpm-lock.yaml", "");
        fs::create_dir_all(source.join("node_modules")).unwrap();

        let mut actions = BTreeMap::new();
        actions.insert("node_modules".to_string(), DepAction::Install);
        let report = apply_setup(&source, &dest, &[], &actions).unwrap();

        assert_eq!(report.failures(), 0);
        assert_eq!(report.pending_commands, vec!["pnpm install".to_string()]);
        assert!(!dest.join("node_modules").exists());
    }

    #[test]
    fn skip_action_does_nothing_and_still_succeeds() {
        let (_g, source, dest) = source_and_dest();
        write(&source, "Cargo.toml", "[package]\n");
        fs::create_dir_all(source.join("target")).unwrap();

        let mut actions = BTreeMap::new();
        actions.insert("target".to_string(), DepAction::Skip);
        let report = apply_setup(&source, &dest, &[], &actions).unwrap();

        assert_eq!(report.failures(), 0);
        assert!(report.pending_commands.is_empty());
        assert!(!dest.join("target").exists());
    }

    #[test]
    fn apply_fails_loudly_when_the_worktree_directory_is_missing() {
        let (_g, source, dest) = source_and_dest();
        let missing = dest.join("nope");
        let err = apply_setup(&source, &missing, &[], &BTreeMap::new()).unwrap_err();
        assert!(err.contains("does not exist"));
    }

    // ── per-repo defaults ────────────────────────────────────────────────

    #[test]
    fn round_trips_per_repo_defaults() {
        let dir = TempDir::new().unwrap();
        let mut dep_actions = BTreeMap::new();
        dep_actions.insert("node_modules".to_string(), DepAction::Copy);
        let defaults = WorktreeDefaults {
            env_files: vec![".env.local".into()],
            dep_actions,
            post_create_command: "pnpm install".into(),
            warned_not_gitignored: true,
        };

        assert!(read_defaults(dir.path()).is_none());
        write_defaults(dir.path(), &defaults).unwrap();
        assert_eq!(read_defaults(dir.path()).unwrap(), defaults);
    }

    #[test]
    fn detects_whether_voidlink_is_gitignored() {
        let dir = TempDir::new().unwrap();
        assert!(!is_voidlink_gitignored(dir.path()));
        write(dir.path(), ".gitignore", ".voidlink/\n");
        assert!(is_voidlink_gitignored(dir.path()));
    }

    #[test]
    fn plan_combines_env_scan_dep_detection_and_defaults() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        write(root, ".gitignore", ".env*\n.voidlink/\n");
        write(root, ".env.local", "A=1\n");
        write(root, "pnpm-lock.yaml", "");

        let plan = build_plan(root, root).unwrap();
        assert_eq!(plan.env_files.len(), 1);
        assert!(plan.env_files[0].gitignored);
        assert_eq!(plan.dep_dirs.len(), 1);
        assert_eq!(plan.suggested_post_create, "pnpm install");
        assert!(plan.voidlink_gitignored);
        assert!(plan.defaults.is_none());
    }
}
