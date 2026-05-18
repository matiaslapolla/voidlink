# Branch Compare — Design

**Status:** Draft, awaiting review
**Date:** 2026-05-05
**Scope:** New "Compare" tab in voidlink for side-by-side diff between any two git refs, with a git-tree-compare-style file tree.

---

## Summary

Add a new tab type, **Compare**, that diffs any two refs (branches, tags, commit SHAs, `HEAD~N`) and presents:

- A **ref picker** (base ↔ head) at the top
- A **file tree panel** of changed files (left)
- A **side-by-side diff** of the selected file (right) — reuses the existing JetBrains-style split renderer in `GitDiffView.tsx`

Multiple Compare tabs can be open at once (e.g. `main..feature-x` and `main..feature-y`), each persisted with the workspace.

---

## Decisions Locked

| #   | Decision              | Choice                                                                 |
| --- | --------------------- | ---------------------------------------------------------------------- |
| Q1  | What can be compared? | **Any-ref ↔ any-ref** (branch, tag, commit SHA, `HEAD~N`)              |
| Q2  | Where it lives        | **New tab type** (`compare`), parallel to `terminal` / `diff` / `file` |
| Q3  | Tree panel features   | **Pending — see "Open Question" below**                                |

---

## Open Question (resolve before implementing)

**Q3 — file tree panel features.** Recommended v1 set is **1, 2, 3, 4, 6** (rest deferred to v2). Confirm the set before we start.

| #   | Feature                        | v1 (rec) | Notes                                          |
| --- | ------------------------------ | -------- | ---------------------------------------------- |
| 1   | Tree vs flat list toggle       | ✅       | Toggle button in tree header                   |
| 2   | Compact folders                | ✅       | Single-child chains collapsed: `pkg/foo/bar/`  |
| 3   | Status icons (A/M/D/R)         | ✅       | Color-coded leading char                       |
| 4   | Per-folder rollup counts       | ✅       | `+12 −3` and `5 files` per folder              |
| 5   | Filter chips by status         | ⏳ v2    | Hide added-only / deleted-only / etc.          |
| 6   | Search / fuzzy filter box      | ✅       | Filters paths in tree                          |
| 7   | Per-file actions menu          | ⏳ v2    | "Open at base", "Open at head", "Copy path"    |
| 8   | Sticky breadcrumb in diff pane | ⏳ v2    | Current file path stuck to top while scrolling |

---

## Architecture

```
┌──────────────────────────── Compare Tab ────────────────────────────┐
│  [base ▼ main]   ↔   [head ▼ feature/x]   ⟳ refresh   ⚙ options    │
├─────────────────────┬───────────────────────────────────────────────┤
│   File Tree (left)  │       Side-by-Side Diff (right)               │
│                     │                                               │
│   📁 src/  +5 −2    │   ┌─ src/foo.rs (base) ──┬─ src/foo.rs (head)─┐
│     📁 git/ +5 −2   │   │ 12  fn old() {       │ 12  fn new() {     │
│       M diff.rs     │   │ 13      …            │ 13      …          │
│       A worktree.rs │   │ ...                  │ ...                │
│   📁 frontend/ +3 0 │   └──────────────────────┴────────────────────┘
│     M App.tsx       │                                               │
│                     │                                               │
└─────────────────────┴───────────────────────────────────────────────┘
```

---

## Backend (Rust / `src-tauri/src/git/`)

### New file: `src-tauri/src/git/compare.rs`

Single new function that handles any-ref ↔ any-ref diff via libgit2.

```rust
pub(crate) fn git_diff_refs_impl(
    repo_path: String,
    base_ref: String,   // e.g. "main", "v1.2.0", "abc123", "HEAD~3"
    head_ref: String,
    use_merge_base: bool,  // true = "..", false = "..." (direct diff vs three-dot)
) -> Result<DiffResult, String>
```

**Implementation:**

1. Open repo via `git2::Repository::open(repo_path)`.
2. Resolve both refs with `repo.revparse_single(ref_str)?.peel_to_commit()?` — accepts branches, tags, SHAs, `HEAD~N`, anything `revparse` supports.
3. If `use_merge_base`: compute `repo.merge_base(base.id(), head.id())` and use that commit's tree as left side. If false: use `base`'s tree directly.
4. `repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut DiffOptions::new()))`.
5. Pipe through existing `collect_diff(diff)` in `diff.rs` — output type `DiffResult` is unchanged, so the frontend renderer just works.

### New file: `src-tauri/src/git/refs.rs`

Helper to feed the ref picker autocomplete.

```rust
pub(crate) fn git_list_refs_impl(repo_path: String) -> Result<RefList, String>

pub struct RefList {
    pub branches: Vec<String>,    // local + remote
    pub tags: Vec<String>,
    pub recent_commits: Vec<RecentCommit>,  // last ~50, oid + summary + time
}
```

Used by the ref-picker UI for autocomplete. Free-text input still flows through `git_diff_refs_impl` (so `HEAD~3` works without being in the list).

### Modify `src-tauri/src/git/mod.rs`

- Add `pub(crate) mod compare;` and `pub(crate) mod refs;`
- Add Tauri command wrappers using the existing `blocking_git!` macro:
  - `git_diff_refs(repo_path, base_ref, head_ref, use_merge_base) -> DiffResult`
  - `git_list_refs(repo_path) -> RefList`
- New struct `RecentCommit` (with serde camelCase) added to types section
- Register both in `lib.rs` `invoke_handler!` block (mirroring existing pattern)

---

## Frontend (SolidJS / `frontend/src/`)

### Type / store changes (`store/layout.ts`)

```ts
// 1. New tab type
export interface CompareTab {
  id: string;
  baseRef: string;
  headRef: string;
  useMergeBase: boolean; // default true
  selectedFilePath: string | null;
  // tree-panel UI state (persisted per tab):
  treeMode: "tree" | "flat";
  treeFilter: string; // search box value
}

// 2. Extend ActiveItem union
export type ActiveItem =
  | { type: "terminal"; id: string }
  | { type: "diff"; id: string }
  | { type: "file"; id: string; path: string }
  | { type: "compare"; id: string }; // ← new

// 3. New per-workspace store slice
compareTabsByWorkspace: Record<string, CompareTab[]>;

// 4. New actions: openCompareTab, closeCompareTab, selectCompareTab,
//    setCompareRefs, setCompareSelectedFile, setCompareTreeMode, setCompareTreeFilter
```

Persistence: piggyback on the existing workspace persistence pattern (same as `diffTabsByWorkspace`).

### API wrapper (`api/git.ts`)

Add two thin wrappers that `invoke()` the new Tauri commands:

```ts
export async function gitDiffRefs(
  repoPath,
  baseRef,
  headRef,
  useMergeBase,
): Promise<DiffResult>;
export async function gitListRefs(repoPath): Promise<RefList>;
```

### New components (`frontend/src/components/git/compare/`)

| File                  | Responsibility                                                                                                                                                                                                           | Approx. LOC |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `CompareTab.tsx`      | Top-level layout: ref picker bar + tree + diff pane. Holds split-pane resizable divider.                                                                                                                                 | ~150        |
| `RefPicker.tsx`       | Combobox: autocomplete from `git_list_refs`, accepts free text. Renders branches/tags/recent-commits sections. Two instances (base, head) + a swap button.                                                               | ~180        |
| `ChangedFileTree.tsx` | The git-tree-compare-style panel. Builds folder tree from `DiffResult.files`, renders with `<For>`, supports tree/flat toggle, compact folders, search filter, per-folder rollups, status icons. Emits `onSelect(path)`. | ~250        |
| `CompareDiffPane.tsx` | Receives selected `FileDiff` and renders it via the existing split renderer extracted from `GitDiffView.tsx` (see refactor below). Empty state when no file selected.                                                    | ~80         |

### Refactor (small): extract split renderer from `GitDiffView.tsx`

Currently `GitDiffView.tsx` has the JetBrains split renderer inline. Extract it to:

`frontend/src/components/git/shared/SplitDiffRenderer.tsx`

…taking `FileDiff` as a prop. Both `GitDiffView` (working tree) and `CompareDiffPane` (branch compare) consume it. No behavior change for working tree.

This is a focused improvement that serves the new feature — not a drive-by refactor.

### Tab strip / opening flow

- Add a "Compare branches…" entry to the new-tab picker (wherever `terminal` / `editor` are added today).
- Opening creates a `CompareTab` with sensible defaults: `baseRef = repo.defaultBranch`, `headRef = repo.currentBranch`, `useMergeBase = true`.
- Tab title format: `Compare: base..head` (truncated middle if long).

---

## Visual / UX Notes

- **Ref picker:** combobox with sectioned dropdown (Branches / Tags / Recent commits), keyboard-first. Selected ref shown as a pill with a colored dot indicating ref kind (branch/tag/sha). Free-text accepted on Enter.
- **Tree panel:** ~280–360px default width, user-resizable with persisted size.
  - Status leading char: `M` neutral, `A` success-green, `D` destructive-red, `R` accent. Same theme tokens used in `DiffLine` rendering.
  - Per-folder rollup: small muted counts on the right of the folder row.
  - Compact-folder mode renders `pkg/foo/bar/` as a single clickable segment chain (each segment expandable independently).
- **Diff pane:** identical visual language to existing working-tree split diff (consistency wins). File header shows old → new path on rename.
- **Empty/error states:**
  - No refs picked yet → centered "Pick two refs to compare" with a Cmd/Ctrl+K hint to focus the first picker.
  - Refs identical → "No differences between `base` and `head`."
  - Invalid ref → inline error under the offending picker; rest of UI not destroyed.
- **Loading:** skeleton tree while diff is computing; existing diff renderer handles its own loading state.
- **Keyboard:** `↑/↓` move selection in tree, `Enter` opens, `/` focuses search, `Tab` jumps from picker → tree → diff.

---

## Error Handling

- Backend: ref-resolve failure returns a structured error string identifying which ref was bad. Frontend surfaces it on the right picker (not a global toast).
- Empty diff is **not** an error — render the "no differences" state.
- Binary files: `FileDiff.is_binary = true` is already in the type. Tree shows them; diff pane renders an "Binary file changed" placeholder (same as working-tree behavior).
- Renames: `old_path` and `new_path` already on `FileDiff`; tree groups under `new_path` with `R` icon and tooltip showing `old_path`.

---

## Testing

- **Rust unit:** `compare.rs` — three cases: branch↔branch, tag↔branch, SHA↔SHA. Use a temp repo fixture (commit two trees, assert file count + additions/deletions).
- **Rust unit:** merge-base mode vs direct mode produce different results on a diverged history (assert known-good values from a hand-built fixture).
- **Rust unit:** invalid ref returns a clear error containing the ref string.
- **Frontend (Vitest):** `ChangedFileTree` — given a fixed `DiffResult`, assert tree structure, compact-folder collapsing, filter behavior, and rollup math.
- **Frontend (Vitest):** store slice — open/close/select compare tabs, persistence round-trip.
- **Manual:** the smoke list gets a new section (added to README later, not in this spec).

---

## Out of Scope (for v1)

- Inline (one-pane) diff mode for branch compare — ship split only; inline can come later if asked.
- Conflict simulation ("would this merge cleanly?").
- Editing files in the diff pane.
- Per-line discussion / comment threads.
- Three-way diff (base / theirs / ours).
- AI explanation of branch diff (Phase-3-style "Explain"). The backend type returned is `DiffResult`, identical to working-tree diff, so plugging this in later is a frontend-only addition.
- Q3 features 5, 7, 8 (filter chips, per-file actions, sticky breadcrumb) — deferred to v2.

---

## File Change Summary

**New files:**

```
src-tauri/src/git/compare.rs                                    +~80 LOC
src-tauri/src/git/refs.rs                                       +~70 LOC
frontend/src/components/git/compare/CompareTab.tsx              +~150 LOC
frontend/src/components/git/compare/RefPicker.tsx               +~180 LOC
frontend/src/components/git/compare/ChangedFileTree.tsx         +~250 LOC
frontend/src/components/git/compare/CompareDiffPane.tsx         +~80 LOC
frontend/src/components/git/shared/SplitDiffRenderer.tsx        (extracted, ~existing LOC)
```

**Modified files:**

```
src-tauri/src/git/mod.rs           — add module decls, types, command wrappers
src-tauri/src/lib.rs               — register new Tauri commands
frontend/src/api/git.ts            — gitDiffRefs, gitListRefs wrappers
frontend/src/types/git.ts          — RefList, RecentCommit, CompareTab types
frontend/src/store/layout.ts       — CompareTab slice, ActiveItem variant, actions
frontend/src/components/git/GitDiffView.tsx
                                   — consume extracted SplitDiffRenderer (no behavior change)
frontend/src/App.tsx               — render CompareTab when activeItem.type === "compare"
[wherever the new-tab picker lives] — add "Compare branches…" entry
```

**No deletions.**

---

## Review Checklist for Daisy

- [x] Q3 set: confirm `1, 2, 3, 4, 6` for v1 (or specify a different subset)
- [x] Default to **merge-base mode** (`use_merge_base = true`) for new tabs — confirm
- [x] Compare tab title format `Compare: base..head` — OK or prefer something else?
- [x] Tab persistence across app restarts — confirm yes (matches `diffTabsByWorkspace` behavior)
- [x] Spec location `docs/specs/` — keep, or prefer elsewhere?

---

Answer: confirmed review checklist
