use std::collections::HashSet;

use git2::{BranchType, Repository};

use super::{Stack, StackBranch};
use crate::git::repo::open_repo;

/// Max depth when walking parent pointers. Protects against config-edit
/// accidents that introduce a cycle.
const MAX_DEPTH: usize = 50;

/// Default trunk candidates. Customized via `voidlink.stack.trunks` (comma
/// separated). The actual `origin/HEAD` target is also auto-detected and
/// merged in at discovery time.
const DEFAULT_TRUNKS: &[&str] = &["main", "master", "develop", "trunk"];

// ─── Public entrypoints ──────────────────────────────────────────────────────

pub(crate) fn current_impl(repo_path: String) -> Result<Option<Stack>, String> {
    let repo = open_repo(&repo_path)?;
    let head_name = match current_branch_name(&repo)? {
        Some(n) => n,
        None => return Ok(None), // detached HEAD
    };
    let trunks = trunks_for(&repo)?;
    if trunks.contains(&head_name) {
        return Ok(None); // HEAD is on the trunk itself
    }
    build_stack_for_head(&repo, &head_name, &trunks)
}

pub(crate) fn list_impl(repo_path: String) -> Result<Vec<Stack>, String> {
    let repo = open_repo(&repo_path)?;
    let trunks = trunks_for(&repo)?;
    let head_name = current_branch_name(&repo)?;

    // Collect every branch that has a recorded parent.
    let mut tracked: Vec<String> = Vec::new();
    let iter = repo
        .branches(Some(BranchType::Local))
        .map_err(|e| e.message().to_string())?;
    for item in iter {
        let (branch, _) = item.map_err(|e| e.message().to_string())?;
        let Some(name) = branch.name().map_err(|e| e.message().to_string())? else {
            continue;
        };
        if read_parent(&repo, name)?.is_some() {
            tracked.push(name.to_string());
        }
    }

    // Walk each one to its trunk; key each stack by (trunk, topmost_branch).
    // The topmost branch is the leaf — among tracked branches sharing a
    // trunk, the one that is no other tracked branch's parent.
    let tracked_set: HashSet<&String> = tracked.iter().collect();
    let parents: Vec<(String, String)> = tracked
        .iter()
        .filter_map(|b| {
            read_parent(&repo, b)
                .ok()
                .flatten()
                .map(|p| (b.clone(), p))
        })
        .collect();
    let has_child: HashSet<String> = parents
        .iter()
        .map(|(_, parent)| parent.clone())
        .filter(|p| tracked_set.contains(p))
        .collect();

    let mut stacks: Vec<Stack> = Vec::new();
    let mut seen_tops: HashSet<String> = HashSet::new();
    for branch in &tracked {
        // Leaves are tracked branches that no other tracked branch points to.
        if has_child.contains(branch) {
            continue;
        }
        if seen_tops.contains(branch) {
            continue;
        }
        seen_tops.insert(branch.clone());
        if let Some(stack) = build_stack_for_head(&repo, branch, &trunks)? {
            stacks.push(stack);
        }
    }

    // If HEAD is itself the top of a stack and was discovered above, mark its
    // is_head correctly. `build_stack_for_head` already does this — nothing to
    // fix up.
    let _ = head_name;
    Ok(stacks)
}

// ─── Trunk detection ─────────────────────────────────────────────────────────

/// Public re-export for sibling modules that need to know which branches
/// count as trunks (e.g. `mutations.rs` refuses to record a trunk as a
/// stack child). Inside this module, callers use `trunks_for` directly.
pub(crate) fn trunks_for_pub(repo: &Repository) -> Result<HashSet<String>, String> {
    trunks_for(repo)
}

fn trunks_for(repo: &Repository) -> Result<HashSet<String>, String> {
    let mut out: HashSet<String> = DEFAULT_TRUNKS.iter().map(|s| (*s).to_string()).collect();

    if let Ok(cfg) = repo.config() {
        // User-configured trunks (comma separated).
        if let Ok(value) = cfg.get_string("voidlink.stack.trunks") {
            for piece in value.split(',') {
                let trimmed = piece.trim();
                if !trimmed.is_empty() {
                    out.insert(trimmed.to_string());
                }
            }
        }
    }

    // Whatever `origin/HEAD` symbolically points at, e.g.
    // "refs/remotes/origin/HEAD" → "refs/remotes/origin/main".
    if let Ok(reference) = repo.find_reference("refs/remotes/origin/HEAD") {
        if let Some(target) = reference.symbolic_target() {
            // Strip "refs/remotes/origin/" prefix.
            if let Some(name) = target.strip_prefix("refs/remotes/origin/") {
                out.insert(name.to_string());
            }
        }
    }

    Ok(out)
}

// ─── Walking ─────────────────────────────────────────────────────────────────

/// Build a `Stack` whose top branch is `top`. Walks parent pointers backward
/// until reaching a trunk (or a branch with no parent set). Returns None if
/// `top` itself has no parent (i.e. is unstacked).
fn build_stack_for_head(
    repo: &Repository,
    top: &str,
    trunks: &HashSet<String>,
) -> Result<Option<Stack>, String> {
    let head_branch_name = current_branch_name(repo)?;

    // Walk: top → parent → grandparent → … until we hit either a trunk or a
    // branch with no parent. Capture pairs of (branch_name, parent_name).
    let mut chain: Vec<(String, String)> = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut cursor = top.to_string();
    let mut trunk: Option<String> = None;

    for _ in 0..MAX_DEPTH {
        if !visited.insert(cursor.clone()) {
            return Err(format!(
                "stack contains a cycle at branch `{}` — fix `.git/config` manually",
                cursor
            ));
        }
        match read_parent(repo, &cursor)? {
            Some(parent) => {
                chain.push((cursor.clone(), parent.clone()));
                if trunks.contains(&parent) {
                    trunk = Some(parent);
                    break;
                }
                cursor = parent;
            }
            None => {
                // Top of chain has no parent recorded. If `cursor` is itself
                // a trunk, the chain might still be valid; otherwise there's
                // no trunk and this isn't a discoverable stack.
                if trunks.contains(&cursor) {
                    trunk = Some(cursor.clone());
                }
                break;
            }
        }
    }

    let Some(trunk) = trunk else {
        if chain.is_empty() {
            return Ok(None);
        }
        // Chain exists but doesn't terminate at a trunk — surface the bottom
        // branch as the synthetic trunk so the UI shows the chain rather than
        // pretending there's no stack.
        let last_parent = chain.last().map(|(_, p)| p.clone()).unwrap();
        return assemble_stack(repo, chain, last_parent, head_branch_name.as_deref());
    };

    assemble_stack(repo, chain, trunk, head_branch_name.as_deref())
}

fn assemble_stack(
    repo: &Repository,
    mut chain: Vec<(String, String)>,
    trunk: String,
    head_name: Option<&str>,
) -> Result<Option<Stack>, String> {
    if chain.is_empty() {
        return Ok(None);
    }
    // `chain` was built top-down; flip to trunk-up so branches[0] is closest
    // to trunk.
    chain.reverse();

    let mut branches: Vec<StackBranch> = Vec::with_capacity(chain.len());
    let mut any_drift = false;
    for (name, parent) in &chain {
        let (ahead, behind) = ahead_behind(repo, name, parent)?;
        let last_known = read_parentbase(repo, name)?;
        let parent_tip_now = match revparse_oid(repo, parent) {
            Ok(oid) => Some(oid),
            Err(_) => None,
        };
        if let (Some(stored), Some(current)) = (last_known.as_deref(), parent_tip_now.as_deref()) {
            if stored != current {
                any_drift = true;
            }
        }
        branches.push(StackBranch {
            name: name.clone(),
            parent: parent.clone(),
            is_head: head_name.map(|h| h == name.as_str()).unwrap_or(false),
            ahead_of_parent: ahead,
            behind_parent: behind,
            last_known_parent_tip: last_known,
            pr_number: read_pr_number(repo, name)?,
        });
    }

    Ok(Some(Stack {
        trunk,
        branches,
        needs_restack: any_drift,
    }))
}

// ─── Config helpers ──────────────────────────────────────────────────────────

fn read_parent(repo: &Repository, branch: &str) -> Result<Option<String>, String> {
    read_config_string(repo, &format!("branch.{}.parent", branch))
}

fn read_parentbase(repo: &Repository, branch: &str) -> Result<Option<String>, String> {
    read_config_string(repo, &format!("branch.{}.parentbase", branch))
}

fn read_pr_number(repo: &Repository, branch: &str) -> Result<Option<u32>, String> {
    match read_config_string(repo, &format!("branch.{}.prnumber", branch))? {
        Some(s) => Ok(s.parse::<u32>().ok()),
        None => Ok(None),
    }
}

/// Sibling-module accessor for `branch.*.parent` / `parentbase` config lookups.
/// Restack needs the same NotFound-as-None semantics as discovery.
pub(crate) fn read_config_string_pub(
    repo: &Repository,
    key: &str,
) -> Result<Option<String>, String> {
    read_config_string(repo, key)
}

fn read_config_string(repo: &Repository, key: &str) -> Result<Option<String>, String> {
    let cfg = repo.config().map_err(|e| e.message().to_string())?;
    match cfg.get_string(key) {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.message().to_string()),
    }
}

// ─── Git helpers ─────────────────────────────────────────────────────────────

fn current_branch_name(repo: &Repository) -> Result<Option<String>, String> {
    match repo.head() {
        Ok(head) if head.is_branch() => Ok(head.shorthand().map(|s| s.to_string())),
        Ok(_) => Ok(None),
        // Unborn HEAD (fresh repo) etc.
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.message().to_string()),
    }
}

fn ahead_behind(repo: &Repository, branch: &str, parent: &str) -> Result<(u32, u32), String> {
    let local = match revparse_oid(repo, branch) {
        Ok(o) => o,
        Err(_) => return Ok((0, 0)),
    };
    let parent_oid = match revparse_oid(repo, parent) {
        Ok(o) => o,
        Err(_) => return Ok((0, 0)),
    };
    let local_id = git2::Oid::from_str(&local).map_err(|e| e.message().to_string())?;
    let parent_id = git2::Oid::from_str(&parent_oid).map_err(|e| e.message().to_string())?;
    match repo.graph_ahead_behind(local_id, parent_id) {
        Ok((a, b)) => Ok((a as u32, b as u32)),
        Err(_) => Ok((0, 0)),
    }
}

fn revparse_oid(repo: &Repository, refish: &str) -> Result<String, String> {
    let object = repo
        .revparse_single(refish)
        .map_err(|e| e.message().to_string())?;
    Ok(object.id().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{IndexAddOption, Repository, Signature};
    use std::fs;
    use std::path::Path;

    fn init_repo(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "test").unwrap();
        cfg.set_str("user.email", "test@example.com").unwrap();
        repo
    }

    fn commit_file(repo: &Repository, path: &Path, name: &str, contents: &str, msg: &str) -> git2::Oid {
        fs::write(path.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = Signature::now("test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap()
    }

    fn checkout(repo: &Repository, branch: &str) {
        let obj = repo
            .revparse_single(&format!("refs/heads/{}", branch))
            .unwrap();
        let mut co = git2::build::CheckoutBuilder::new();
        co.safe();
        repo.checkout_tree(&obj, Some(&mut co)).unwrap();
        repo.set_head(&format!("refs/heads/{}", branch)).unwrap();
    }

    fn make_branch(repo: &Repository, name: &str, from_ref: &str) {
        let commit = repo.revparse_single(from_ref).unwrap().peel_to_commit().unwrap();
        repo.branch(name, &commit, false).unwrap();
    }

    fn set_parent(repo: &Repository, branch: &str, parent: &str) {
        let mut cfg = repo.config().unwrap();
        cfg.set_str(&format!("branch.{}.parent", branch), parent).unwrap();
    }

    /// Build a fixture: main → feat/step-1 → feat/step-2 → feat/step-3.
    /// Returns the temp dir handle (keeps the repo alive for the test).
    fn linear_stack_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let repo = init_repo(&root);
        commit_file(&repo, &root, "README.md", "init\n", "init on main");
        // We renamed master -> main: gitconfig may or may not start on main.
        // Force the branch name to be "main" so the trunk detection rule fires.
        let head_branch = repo.head().unwrap().shorthand().unwrap().to_string();
        if head_branch != "main" {
            repo.branch("main", &repo.head().unwrap().peel_to_commit().unwrap(), false).unwrap();
            checkout(&repo, "main");
        }

        for step in 1..=3 {
            let parent = if step == 1 {
                "main".to_string()
            } else {
                format!("feat/step-{}", step - 1)
            };
            let new = format!("feat/step-{}", step);
            make_branch(&repo, &new, &parent);
            checkout(&repo, &new);
            set_parent(&repo, &new, &parent);
            commit_file(&repo, &root, &format!("step{}.txt", step), "x\n", &format!("step {}", step));
        }
        (tmp, root)
    }

    #[test]
    fn current_on_top_of_stack_returns_full_chain() {
        let (_tmp, root) = linear_stack_fixture();
        let stack = current_impl(root.to_string_lossy().to_string())
            .unwrap()
            .expect("HEAD is on feat/step-3 — stack should be discovered");
        assert_eq!(stack.trunk, "main");
        assert_eq!(stack.branches.len(), 3);
        assert_eq!(stack.branches[0].name, "feat/step-1");
        assert_eq!(stack.branches[0].parent, "main");
        assert_eq!(stack.branches[1].name, "feat/step-2");
        assert_eq!(stack.branches[1].parent, "feat/step-1");
        assert_eq!(stack.branches[2].name, "feat/step-3");
        assert_eq!(stack.branches[2].parent, "feat/step-2");
        assert!(stack.branches[2].is_head);
        assert!(!stack.branches[0].is_head);
        // Each branch should be ahead of its parent by exactly 1 commit.
        for b in &stack.branches {
            assert_eq!(b.ahead_of_parent, 1, "branch {} ahead", b.name);
            assert_eq!(b.behind_parent, 0, "branch {} behind", b.name);
        }
    }

    #[test]
    fn current_on_trunk_returns_none() {
        let (_tmp, root) = linear_stack_fixture();
        let repo = Repository::open(&root).unwrap();
        checkout(&repo, "main");
        let stack = current_impl(root.to_string_lossy().to_string()).unwrap();
        assert!(stack.is_none(), "HEAD on trunk should not produce a stack");
    }

    #[test]
    fn list_returns_one_stack_for_linear_chain() {
        let (_tmp, root) = linear_stack_fixture();
        let stacks = list_impl(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(stacks.len(), 1, "linear chain should produce exactly one stack");
        assert_eq!(stacks[0].branches.len(), 3);
    }

    #[test]
    fn list_returns_two_stacks_when_branches_diverge() {
        // Build: main → step-1 (shared) → { step-2a, step-2b }
        let (_tmp, root) = linear_stack_fixture();
        let repo = Repository::open(&root).unwrap();
        checkout(&repo, "feat/step-1");
        make_branch(&repo, "feat/alt", "feat/step-1");
        checkout(&repo, "feat/alt");
        set_parent(&repo, "feat/alt", "feat/step-1");
        commit_file(&repo, &root, "alt.txt", "x\n", "alt");
        let stacks = list_impl(root.to_string_lossy().to_string()).unwrap();
        // Two leaves: feat/step-3 and feat/alt. Two stacks.
        assert_eq!(stacks.len(), 2, "got {:?}", stacks.iter().map(|s| s.branches.last().unwrap().name.clone()).collect::<Vec<_>>());
        let leaf_names: HashSet<String> = stacks
            .iter()
            .map(|s| s.branches.last().unwrap().name.clone())
            .collect();
        assert!(leaf_names.contains("feat/step-3"));
        assert!(leaf_names.contains("feat/alt"));
    }

    #[test]
    fn behind_parent_grows_when_parent_advances() {
        let (_tmp, root) = linear_stack_fixture();
        let repo = Repository::open(&root).unwrap();
        // Advance main by one commit while HEAD remains on feat/step-3.
        checkout(&repo, "main");
        commit_file(&repo, &root, "newmain.txt", "x\n", "main moves");
        checkout(&repo, "feat/step-3");
        let stack = current_impl(root.to_string_lossy().to_string())
            .unwrap()
            .unwrap();
        // step-1 is now behind main by 1 (main moved past), still ahead by 1.
        let s1 = &stack.branches[0];
        assert_eq!(s1.behind_parent, 1, "step-1 should be 1 behind main");
        assert_eq!(s1.ahead_of_parent, 1);
    }

    #[test]
    fn cycle_in_config_is_caught_not_hung() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        commit_file(&repo, root, "README.md", "init\n", "init");
        make_branch(&repo, "main", "HEAD");
        make_branch(&repo, "a", "HEAD");
        make_branch(&repo, "b", "HEAD");
        // Deliberate cycle: a→b, b→a.
        set_parent(&repo, "a", "b");
        set_parent(&repo, "b", "a");
        checkout(&repo, "a");
        let err = current_impl(root.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("cycle"), "got: {}", err);
    }

    #[test]
    fn trunk_list_includes_config_override() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let repo = init_repo(root);
        commit_file(&repo, root, "README.md", "init\n", "init");
        // Set an unusual trunk name and stack on it.
        make_branch(&repo, "release", "HEAD");
        {
            let mut cfg = repo.config().unwrap();
            cfg.set_str("voidlink.stack.trunks", "release,custom-main").unwrap();
        }
        make_branch(&repo, "feat", "release");
        checkout(&repo, "feat");
        set_parent(&repo, "feat", "release");
        commit_file(&repo, root, "x.txt", "x\n", "feat commit");
        let stack = current_impl(root.to_string_lossy().to_string())
            .unwrap()
            .expect("release should be recognized as trunk via config override");
        assert_eq!(stack.trunk, "release");
        assert_eq!(stack.branches.len(), 1);
        assert_eq!(stack.branches[0].name, "feat");
    }
}
