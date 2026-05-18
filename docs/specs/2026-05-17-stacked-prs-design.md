# Stacked PRs — Design

**Status:** Locked, implementation in waves
**Date:** 2026-05-17
**Scope:** First-class stack-aware workflow: create branches on top of branches, visualize the chain, restack on parent updates, submit/update stacked PRs on GitHub.

---

## Summary

Add a **Stack** primitive to voidlink: an ordered chain of git branches in which each branch carries a recorded *parent* pointer, rooted at a trunk (e.g. `main`). Surface it in two places:

- A **STACK** section in the git sidebar showing the current branch's chain at a glance.
- A dedicated **Stack tab** (new tab type, parallel to `compare`/`diff`/`file`/`terminal`) for full-graph + per-branch actions.

Plus the four operations that make stacks useful: **create on top**, **status**, **restack**, **submit to GitHub**.

---

## Decisions Locked

| #   | Decision                          | Choice                                                                                            |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q1  | v0 scope                          | **Full Graphite parity**: viz + create + restack + GitHub PR sync                                 |
| Q2  | Stack persistence                 | **Git config** — `branch.<name>.parent` per branch                                                |
| Q3  | UI placement                      | **Both** — sidebar STACK section (overview) + dedicated Stack tab (full workspace)                |
| Q4  | Trunk identification              | Configurable list (`main`, `master`, `develop`, `trunk`) + branch whose `.remote` is `origin/HEAD` |
| Q5  | GitHub auth                       | Reuse `GITHUB_TOKEN` env var convention from existing `push.rs`                                   |
| Q6  | Conflict UX on restack            | Stop, report state, let user resolve in terminal; "Continue restack" button picks up where left off |

---

## Architecture

### Data model (Rust types)

```rust
pub struct Stack {
    /// The trunk branch, e.g. "main". Never has a parent.
    pub trunk: String,
    /// Branches in order from trunk's first child up to the topmost branch.
    /// Excludes trunk. Each branch's parent is the previous entry (or trunk
    /// if first).
    pub branches: Vec<StackBranch>,
    /// True if any branch in the chain has a parent that no longer matches
    /// the recorded parent (e.g. trunk advanced) — UI shows "needs restack".
    pub needs_restack: bool,
}

pub struct StackBranch {
    pub name: String,
    pub parent: String,
    pub is_head: bool,
    /// Commits on this branch not on parent.
    pub ahead_of_parent: u32,
    /// Commits on parent not on this branch (i.e. parent moved past us).
    pub behind_parent: u32,
    /// Last commit SHA of the parent at the time of the last restack.
    /// Stored in `branch.<name>.parentbase` config. Used to detect drift.
    pub last_known_parent_tip: Option<String>,
    /// PR number if we've previously submitted this branch via voidlink.
    /// Stored in `branch.<name>.prnumber` config.
    pub pr_number: Option<u32>,
}

pub struct RestackResult {
    pub branch: String,
    pub outcome: RestackOutcome,
}
pub enum RestackOutcome {
    Skipped,            // already up-to-date
    Restacked,          // clean rebase, branch moved
    Conflict { paths: Vec<String> },
}

pub struct SubmitResult {
    pub branch: String,
    pub action: SubmitAction,
    pub url: Option<String>,
}
pub enum SubmitAction {
    Created(u32),       // new PR number
    Updated(u32),       // existing PR's base updated
    NoChange(u32),      // PR exists and base already correct
    Failed(String),
}
```

### Git config schema

For each tracked branch:

```ini
[branch "feat/auth-step-2"]
    remote = origin
    merge = refs/heads/feat/auth-step-2
    parent = feat/auth-step-1          ; ← voidlink-managed
    parentbase = abc1234               ; ← last parent tip at restack time
    prnumber = 42                      ; ← set after first successful submit
```

The three voidlink-managed keys are namespaced under the branch section. Reads use `git2::Config::get_string("branch.<name>.parent")`. Writes use `set_str`. Removal uses `remove`.

### Trunk detection

A branch is a **trunk candidate** if:
1. Its name matches one of the configured trunks (default: `main`, `master`, `develop`, `trunk`), OR
2. It is what `origin/HEAD` points to (the GitHub-default branch).

Trunks **never** have `branch.<name>.parent` set — setting one on a trunk is rejected.

### Stack discovery

Two entry points:

1. **From current HEAD**: walk `branch.<HEAD>.parent` repeatedly until we hit a trunk or a branch with no parent set. The resulting chain (reversed) is the current stack.
2. **All stacks**: enumerate every local branch with `branch.<name>.parent` set; group by walking each one back to its trunk; deduplicate by trunk + top-most branch.

### Rust commands

| Command                                                   | Purpose                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `git_stack_current(repo_path)` → `Option<Stack>`          | Walk parent chain from HEAD; None if HEAD is on a trunk or unstacked branch.     |
| `git_stack_list(repo_path)` → `Vec<Stack>`                | Discover every stack in the repo.                                                |
| `git_stack_create_branch(repo_path, name, parent)` → `()` | `git branch <name> <parent>` + record parent in config + checkout.               |
| `git_stack_set_parent(repo, branch, parent)` → `()`       | Record/update parent without checking out. Used for retroactive tracking.        |
| `git_stack_untrack(repo, branch)` → `()`                  | Remove parent/parentbase/prnumber from config — branch leaves stack.             |
| `git_stack_restack(repo, branch)` → `RestackResult`       | Rebase one branch onto its current parent tip.                                   |
| `git_stack_restack_all(repo, stack)` → `Vec<RestackResult>` | Restack from bottom to top; stop at first conflict.                            |
| `git_stack_submit(repo, stack, token)` → `Vec<SubmitResult>` | Create/update one PR per branch on GitHub with correct base.                  |
| `git_stack_set_trunks(repo, trunks: Vec<String>)` → `()`  | Override default trunk list, stored in `voidlink.stack.trunks`.                  |

### Restack algorithm

Single-branch restack (`git_stack_restack`):

```
let stored_base = config "branch.<B>.parentbase"   // SHA at last restack
let current_base = revparse(parent)                 // parent's tip right now
if stored_base == current_base: return Skipped
let merge_base = merge_base(B, parent)              // bridge point
if merge_base == current_base: return Skipped       // parent didn't move past
// rebase: take commits unique to B (B..merge_base), replay onto current_base
let commits = walk(merge_base..B)
checkout(B)
reset_hard(current_base)
for c in commits: cherry_pick(c)
on success: config set "branch.<B>.parentbase" = current_base
on conflict: abort cherry-pick, return Conflict { paths }
```

Stack-wide restack (`git_stack_restack_all`): apply the above bottom-up. On Conflict, stop — don't try later branches because their parent just moved underneath them too.

The current branch is restored to whatever was checked out before the call.

### GitHub submit

For each branch in the stack (top-down):

1. `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}` — find existing.
2. If PR exists:
   - If `base.ref != parent`: `PATCH /pulls/{n}` with `base = parent`.
   - Else: NoChange.
3. If no PR:
   - `POST /pulls` with `{ title, head: branch, base: parent, body, draft: true }`.
   - Record `branch.<name>.prnumber = <new_num>` in config.
4. Append stack footer to body — a markdown block listing all branches in the stack, marking the current one with `← this PR`. This is the social signal Graphite uses for navigability.

Owner/repo come from parsing the `origin` remote URL. Token from `GITHUB_TOKEN` env. Failures per branch are non-fatal — return per-branch results.

**Reuses existing infra**: `reqwest = { version = "0.12", features = ["json", "blocking", "rustls-tls"], default-features = false }` (new dep). HTTP error handling mirrors `push.rs` patterns.

---

## UI

### Sidebar STACK section

Slotted between `Branches` and `History` in `GitSidebar.tsx`. Reuses the existing `Section` collapsible primitive.

```
▼ STACK
  ◉ feat/step-3        ←HEAD
  │ feat/step-2  ↑5  ⚠ needs restack
  │ feat/step-1  ↑3
  └ main
  [+ Branch on top]   [Open stack tab]
```

- HEAD branch marked with `◉` + `←HEAD`.
- `↑N` = commits ahead of parent.
- `⚠ needs restack` when `last_known_parent_tip != parent.tip()`.
- "Branch on top" prompts for a name, creates child of current, records parent, checks out.
- "Open stack tab" creates/focuses a Stack tab for this stack.

When HEAD is not on a stack:

```
▼ STACK
  Not on a stack.
  [Start stack on top of <current>]
```

The button creates a new child branch (prompts for name) and starts the stack.

### Stack tab

New tab type `stack` in `store/layout.ts`:

```ts
export interface StackTab {
  id: string;
  trunk: string;
  topBranch: string;   // identifies which stack across reloads
}
```

Renderer at `components/git/stack/StackTab.tsx`:

```
┌─ Stack: feat/auth ─────────────────────────────────────────┐
│ [Restack all]  [Submit stack to GitHub]    ⓘ 3 branches    │
├────────────────────────────────────────────────────────────┤
│  main                                                       │
│   │                                                         │
│   ◉ feat/step-1   ↑3 commits   PR #42 (open)               │
│   │                                            [Restack][▸]│
│   ◉ feat/step-2   ↑5 commits   ⚠ needs restack             │
│   │                                            [Restack][▸]│
│   ◉ feat/step-3   ↑2 commits   ←HEAD  (no PR yet)          │
│                                                [Restack][▸]│
└────────────────────────────────────────────────────────────┘
```

Per-branch row:
- Click branch name → opens compare tab `parent..branch` (reuses existing compare primitive — the user's stated reason this design works).
- `[Restack]` button → calls `git_stack_restack` for that branch.
- `[▸]` → reveals secondary actions: "Untrack from stack", "Copy branch name".

Top bar:
- **Restack all** — runs `git_stack_restack_all`; on conflict shows a banner with the conflicting paths + "Continue once resolved" button.
- **Submit stack to GitHub** — runs `git_stack_submit`; modal shows per-branch results (created/updated/no-change/failed) with links.

### Palette actions

Add to `commands/registry.ts`:

- `stack.branch-on-top` — "Stack: Branch on top of current" (prompts for name)
- `stack.restack-all` — "Stack: Restack all"
- `stack.submit` — "Stack: Submit to GitHub"
- `stack.open-tab` — "Stack: Open stack workspace"

---

## Implementation waves

Each wave is independently shippable. After each, the app boots, tests pass, and the prior wave's UI keeps working.

### Wave A — Read-only viz (½ day)
- Rust: `git_stack_current`, `git_stack_list`, trunk detection, status fields (ahead/behind/last-known-parent).
- Frontend: types, api wrappers, STACK sidebar section (read-only — shows "Not on a stack" when applicable).
- Tests: discovery from temp repos with various topologies.

### Wave B — Create flow + Stack tab (½ day)
- Rust: `git_stack_create_branch`, `git_stack_set_parent`, `git_stack_untrack`.
- Frontend: "Branch on top" prompt, Stack tab type in `store/layout.ts`, `StackTab.tsx` with the graph layout, palette actions.
- Tests: create-on-top correctly records parent + checks out.

### Wave C — Restack (1 day)
- Rust: `git_stack_restack`, `git_stack_restack_all`, conflict reporting, `parentbase` config tracking.
- Frontend: [Restack] buttons + conflict banner + "Continue" UI.
- Tests: clean restack, restack with no-op detection, conflict path.

### Wave D — GitHub submit (1-2 days)
- Cargo: add `reqwest` blocking + rustls features.
- Rust: `git_stack_submit`, GitHub REST client (find-PR, create-PR, update-PR), stack-footer rendering, owner/repo URL parser.
- Frontend: Submit modal with per-branch results.
- Tests: URL parsing, footer rendering, payload shape (mock the HTTP client).

### Wave E — Polish (½ day)
- "Start stack on top of <current>" empty-state action.
- PR-number badge in sidebar.
- Settings entry for trunk list.

**Total: ~3-5 working days.** This session I'll commit to Wave A end-to-end, then check in. If you want to keep going beyond that, I'll continue; otherwise we stop at a clean shippable boundary.

---

## Reused primitives (per CLAUDE.md "reuse before invent")

- **Compare tab** — each restack/review of a branch in the stack opens an existing compare tab (`base = parent`, `head = branch`). No new diff renderer needed.
- **`git_diff_refs_impl`** — already provides the diff payload for the compare tab when looking at any branch.
- **`Section` component in `GitSidebar.tsx`** — STACK section uses the existing collapsible/resizable wrapper.
- **`pushToast`** — restack progress + submit results route through the existing toast viewport.
- **`useKeybindings` + action registry** — palette entries register through the existing surface.
- **`push.rs` auth pattern** — `GITHUB_TOKEN` resolution mirrors what `git_push_impl` already does.
- **Git config plumbing** — `git2::Config` is already in scope via `git2`; no new dep.

---

## Out of scope (deliberate, for later)

- **Auto-restack on `git pull` / fetch** — manual button only in v0; auto is a polish wave once trust is established.
- **Stack reordering** (drag a branch up/down) — semantically requires a multi-rebase choreography; defer until we see whether anyone asks.
- **Cross-repo stacks** — single repo per stack. Multi-repo stacks would tie into the Massive #4 ("Multi-repo workspaces") bet from session-1.md, not this arc.
- **Inline PR comments** — covered by Massive #6 (PR review and run) later.
- **Continue-after-conflict** beyond a simple "resume" button — full in-app conflict resolver is the separate Do-Next item.

---

## Open question (resolve during Wave A)

**Trunk-list default behavior on first run.** Should we:
- (a) Hard-code `[main, master, develop, trunk]` and let users override in settings.
- (b) Read `origin/HEAD` once on first repo open and seed from there.
- (c) Both — start with hard-coded list, augment with `origin/HEAD` when available.

Recommend (c). Confirm during Wave A when wiring trunk detection.
