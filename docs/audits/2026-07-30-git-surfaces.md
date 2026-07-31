# Git surfaces audit — 2026-07-30

Read-only audit across every git-facing surface in VoidLink, triggered by three
complaints:

> the diff viewer never works correctly, nor the files listed on the git sidebar
> are all the ones should be there, and the sidebars sometimes do not get updated.

Five tracks: **working diff / status / refresh**, **hunk staging**, **worktrees
& stashes**, **commit graph**, **branches & remotes**, **branch compare**.

Every finding carries a severity and a confidence. Confidence levels:

- **proven** — reproduced with a probe repo, a `git2` binary built against the
  same version, or a headless `solid-js` harness replaying the real scheduler
- **reading** — traced through source (including vendored `libgit2` /
  `solid-js` source) but not executed
- **suspected** — inferred, with the reason it could not be proven stated

Nothing was omitted as too minor. Where a finding was considered and *not*
reported, the reason is stated inline.

---

## Contents

- [Fix order](#fix-order)
- [The cross-cutting defect](#the-cross-cutting-defect)
- [Track 1 — Working diff viewer](#track-1--working-diff-viewer)
- [Track 2 — Git sidebar file list](#track-2--git-sidebar-file-list)
- [Track 3 — Refresh architecture](#track-3--refresh-architecture)
- [Track 4 — Hunk staging](#track-4--hunk-staging)
- [Track 5 — Worktrees & stashes](#track-5--worktrees--stashes)
- [Track 6 — Commit graph](#track-6--commit-graph)
- [Track 7 — Branches & remotes](#track-7--branches--remotes)
- [Track 8 — Branch compare](#track-8--branch-compare)
- [Coverage boundary](#coverage-boundary)

---

## Fix order

Ranked across all tracks. Numbers in brackets are the finding ids.

| # | Change | Kills |
|---|---|---|
| ~~1~~ | ~~Stop the resource reads throwing; add `GitErrorBoundary` as a backstop~~ **done** | CMP-F24, GRAPH-F1, GRAPH-S1, BR-D1, WT-R5 |
| ~~2~~ | ~~`diff.rs:19` → `diff_index_to_workdir`; thread `staged` through the tab key~~ **done** | DIFF-A1, DIFF-A2, DIFF-A3, DIFF-A9 |
| ~~3~~ | ~~`lanes.ts:81-86` — split `dotOrigin` into `sprang`/`joined`; add the missing tests~~ **done** | GRAPH-L1, L2, L3, L4 |
| ~~4~~ | ~~`branch.rs` — `ensure_no_operation` on delete; fix the merged test; pass `operation` in the git window~~ **done** | BR-F1, BR-F3 |
| ~~5~~ | ~~Filesystem watcher over `.git` and the working tree~~ **done** | REFRESH-C1 |
| ~~6~~ | ~~Pulse cost, then the visible-wrongness cluster~~ **done** | WT-W8, CMP-F23, CMP-F14, CMP-F13, CMP-F4, CMP-F5, CMP-F7, CMP-F8, CMP-F17, CMP-F33, BR-C2, BR-A1, GRAPH-O2 |
| ~~7~~ | Two rows per file from `git_file_status_impl`; row identity is section+path | SIDEBAR-B1 |
| 8 | Everything else below, unranked | *two passes done — see the ledgers* |

### #8 ledger — first pass

Worked highest-severity-first through the unranked remainder. **Fixed:**

| id | what |
|---|---|
| DIFF-A4 | already covered by #2's status arms — verified, not re-fixed |
| DIFF-A5 | `detect_renames` shared by the working-tree and compare paths |
| — | `include_typechange` on working-tree diffs too (the compare-only half of #6) |
| SIDEBAR-B2 | rename detection in `StatusOptions`; rows now report the **new** path, since `entry.path()` is the old one |
| WT-S1 | stash diffs include the untracked third parent, narrowly (`stash show -u` semantics) |
| WT-W1 | `prunable` parsed, badged, and "open" disabled for it |
| WT-W2 | `bare` parsed, excluded from the count and from enrichment |
| WT-W5 | `git worktree unlock` command + an unlock button; the `remove -f` substring matches both wordings |
| WT-W10 | the empty state no longer claims "only the main worktree" during first load |
| WT-W7 | `statusUnknown` reaches the rail and the ⌘⇧P switcher |
| WT-R1 / R2 / D1 / D2 | one shared `removeWorktreeWithConfirm`; the palette's `…` now means something |
| WT-R3 | "open this worktree" forwards from the git window instead of no-op'ing |
| WT-R4 | "new worktree" targets the repo the pane is showing, from git's own listing |
| BR-A2 | unborn HEAD listed |
| BR-A3 | fetch prunes, and with no remote named fetches **every** remote |
| BR-A9 | loading / empty / error states |
| BR-B1 | a deleted upstream ref reads as unknown, not untracked |
| BR-B4 | detached-HEAD banner |
| BR-F2 | delete routed through the in-flight gate |
| BR-G1 / G2 | remote URL and name validation |
| BR-G3 | the removal confirm says what it destroys |
| BR-G7 | adding a remote fetches it |
| GRAPH-R1 | tags, stashes, notes, `ORIG_HEAD`/`MERGE_HEAD`/`REBASE_HEAD`, other worktrees' HEADs all seeded |
| GRAPH-R2 | the limit counts rows kept, not items visited |
| GRAPH-R3 | `origin/HEAD` is not a chip |
| GRAPH-R4 | decorations dedupe on (kind, name) |
| GRAPH-R5 | committer time emitted and displayed, matching the ordering |
| GRAPH-D1 | only the ref HEAD is on gets HEAD styling |
| GRAPH-D2 | `kind` comes from the backend |
| GRAPH-D3 | detached HEAD gets a chip |
| GRAPH-P2 | a refetch no longer unmounts the graph and resets scroll |
| GRAPH-P3 | "Load more" stops flickering |
| GRAPH-F2 | subscribes through `onGitRefsChanged` |
| GRAPH-F3 | selection reconciled after refetch |
| GRAPH-S2 / S3 | ticking clock; future timestamps and calendar drift handled |
| GRAPH-S4 | gutter capped |
| GRAPH-S5 | rows are real listbox options with keyboard activation |
| GRAPH-O1 | compare tabs dedupe |
| REFRESH-C2 | all 11 raw `dispatchEvent` emitters and all 4 raw listeners now go through the helper |
| REFRESH-C3 | `pagehide` flushes a pending pulse |
| SIDEBAR-B3 | the Conflicts gate uses the filtered rows, like its count |
| CMP-F3 | the ahead/behind pill opens a three-dot diff |

**Still open after this pass**, in rough priority order:

- **HUNK-H1 + H3** — hunk staging is still unreachable (`GitDiffView` has no
  import site). Reviving it needs the TOCTOU guard in the same change, or it is
  a data-loss risk rather than a feature.
- **DIFF-A6 / CMP-F11** — `ignoreWhitespace` is still a client-side transform,
  so counts and file lists disagree with what renders. The fix is a flag
  threaded through both diff commands and both resource keys.
- **GRAPH-L3 / L5 / L6** — remaining lane-router defects (trunk kink on a
  claimed first parent; last row emits no segments; truncated parents hold a
  lane).
- **GRAPH-P1 / P4** — "Load more" still refetches from scratch; no
  virtualization.
- **CMP-F25 / F26** — folder expand state resets on refetch, and fixing it
  turns `ChangedFileTree.tsx:397` into a stale-data bug.
- **CMP-F6, F10, F12, F15, F16, F18–F22, F28–F32** — tree key collisions, size
  caps, footer counts, ref-picker gaps.
- **WT-W3, W4, W6, W9, S2–S7, D3, D4, D5** — porcelain `-z`, spawn timeout,
  stash-by-index identity, collapsed-section counts, wizard classification.
- **BR-A4, A5, A7, A8, A11, B3, C3–C6, D2, D3, E2, F5, F6, F7, G8** — grouping,
  remote-only rows, the git window's missing sync controls, `<For>` keying.
- **DIFF-A7, A8** and the Track 1 "Lower" list, **SIDEBAR "Lower"**,
  **GRAPH-O3/O4**.
- **Docs drift** — `worktrees.md`, `branches-and-sync.md`, `commit-graph.md`,
  `branch-compare.md` all have stale Gotchas, several of which this pass just
  made staler.

### #8 ledger — second pass

| id | what |
|---|---|
| HUNK-H1 | reachable: a `Hunks` toolbar toggle in `DiffTabView` swaps Monaco for the hunk renderer, with per-hunk stage/unstage/discard. `GitDiffView` deleted. |
| HUNK-H3 | `FileDiff.oldBlobOid` round-trips; Rust compares it against the index (stage/discard) or HEAD (unstage) and refuses with `[stale-diff]` before writing, then dry-runs the patch. |
| DIFF-A6 / CMP-F11 | `ignoreWhitespace` is a `DiffOptions` flag on both diff commands and part of both resource keys. `applyIgnoreWhitespace` deleted. A whitespace-only file leaves the list entirely (as `git diff -w`); a mode-only change survives. |
| CMP-F30 | ...and the hunk-index remap it forced went with it — indices now match by construction. |
| GRAPH-L5 / L6 | `GraphLayout.truncatedLanes`; the last row draws its in-flight lanes to the bottom edge, faded and dashed, and the header says "more history below". |
| GRAPH-L3 | **documented, not changed** — see below. |
| CMP-F25 | folder collapse state keyed on path, owned by `ChangedFileTree`, so it survives the rebuild every pulse causes. |
| CMP-F26 | the `props.node.file!` read made reactive in the same change, since fixing F25 alone is what would have made it dangerous. |
| CMP-F12 | the tree footer counts the filtered set, and says "of N" when they differ. |
| WT-S7 | a collapsed Stashes section shows a count badge, fetched only while collapsed. |
| WT-D5 | a second "New worktree" click says the wizard is already open. |
| BR-D2 | `BranchesPane` embeds `TagsPane` only where there is no Tags section (`showTags`). |
| docs | `worktrees.md`, `branches-and-sync.md`, `commit-graph.md`, `branch-compare.md`, `git-staging.md` — Gotchas rewritten against the current behaviour. |

**GRAPH-L3, decided rather than fixed.** The finding is that the documented
"first parent keeps the mainline vertical" is false when an earlier child
already claimed the lane heading to that parent. Making it true would mean
moving a claimed lane sideways mid-flight — but the earlier child's segments
are already emitted in the old column, so the line would arrive at one column
and leave from another. That is a *broken edge*, which is strictly worse than a
kink. The invariant is wrong, not the code; the comment now says so.

**GRAPH-P1, partly.** "Load more" still refetches the whole window. The
user-visible harm was P2 (scroll reset on every pulse), which is fixed. What is
left is redundant serialization: a `skip` parameter would not help, because
libgit2 walks from the tips regardless, so the walk — the dominant cost — is
paid either way. Recorded rather than papered over.

**Still open after the second pass:** GRAPH-P4 (no virtualization),
CMP-F6/F10/F15/F16/F18–F22/F28–F32, WT-W3/W4/W6/W9, WT-S2–S6, WT-D3/D4,
BR-A4/A5/A7/A8/A11/B3/C3–C6/D3/E2/F5/F6/F7/G8, DIFF-A7/A8, the Track 1 and
Track 2 "Lower" lists, GRAPH-O4.

### #8 ledger — third pass (2026-07-31)

| id | what |
| --- | --- |
| GRAPH-P4 | **fixed.** The graph is windowed above 60 rows — rows *and* gutter. The SVG keeps its full height and absolute coordinates, so only which elements exist changes; `gutterRange` draws one row past the viewport on each side, because a segment runs from row `i` to row `i+1` and a gutter drawn to exactly the visible rows looks severed at both edges while scrolling. That arithmetic lives in `lanes.ts` with unit tests; the measurement half needs a browser. |

**Also closed from the coverage boundary rather than from a finding.** Two of
the surfaces that carried the most findings are now mounted in tests for the
first time:

- `ChangedFileTree` — 15 tests, covering CMP-F25 (collapse state surviving a
  rebuild, driven through a signal so the component genuinely re-renders against
  fresh objects), the compaction rule and where it stops, rename/deletion
  identity, rollups and filtering.
- `OperationBanner` — 14 tests through the new Tauri stub, so `@/api/git` runs
  for real. Includes the props-after-await bug its own header describes: a
  successful continue must name the operation rather than saying "undefined
  continued".

Writing the first of those corrected an assumption in this document's own
reading of the component: `a/b` and `a/c` do **not** compact into one row, since
`a` has two children and merging there would lose the sibling relationship.

**Still open, unchanged:** CMP-F6/F10/F15/F16/F18–F22/F28–F32, WT-W3/W4/W6/W9,
WT-S2–S6, WT-D3/D4, BR-A4/A5/A7/A8/A11/B3/C3–C6/D3/E2/F5/F6/F7/G8, DIFF-A7/A8,
the Track 1 and Track 2 "Lower" lists, GRAPH-O4. All MEDIUM or below; none is a
correctness defect that loses work or misreports the repository.

### Notes from #7

The Rust half was small; the frontend half was not, because emitting two rows
made a path stop being a unique row identity. Everything that keyed on a path
had to key on `section + path` instead: the keyboard cursor (`Space` on the
unstaged row of an `MM` file was unstaging the *other* row), the row DOM ids
(`aria-activedescendant` pointed at whichever duplicate came first), and the
"this diff is open" highlight (both rows lit at once).

Two things fixed on the way:

- `discardAllChanges` counted rows, so its destructive confirm would have said
  "2 tracked file(s)" for one file. It counts distinct paths now.
- `EditorApp` passed the active *file* tab's absolute path as the changes
  list's `selectedFile`, which the list compares against repo-relative paths —
  so no row was ever highlighted there. It now passes the active *diff* tab's
  relative path and its `staged` side.

### Known gaps left after #6

- `EditorApp.tsx:480` and `MainSurface.tsx:1003` still build a base ref as
  `` `${sha}^` ``. Both take a bare SHA from text (terminal output, a link) with
  no parent list to hand, and there is no single-commit lookup command to ask
  for one. A root commit clicked from those two paths still errors — but it now
  errors *visibly* rather than bricking the tab. Fixing it properly means a new
  Rust command, which was more than those two call sites justify.
- Working-tree diffs (`diff.rs`) still have no `find_similar` or
  `include_typechange`; only the compare path got them. DIFF-A4 and DIFF-A5
  remain open.

---

## The cross-cutting defect

Three independent tracks found the same hole, which makes it the
highest-confidence item in the audit.

**There is no `ErrorBoundary` anywhere except `GitSidebar.tsx:628`.**
`App.tsx`, `MainSurface.tsx`, `main.tsx` and `GitApp.tsx` have none.

SolidJS resources **rethrow on read** (`solid-js/dist/solid.cjs:320-324`; the
`latest` getter throws too). Any component that reads a resource inside a
reactive computation therefore throws into whatever is above it — and there is
nothing above it.

Consequences found separately:

- **Compare tab** — one bad ref permanently kills every downstream effect while
  the activity spinner keeps spinning (CMP-F24, proven).
- **Commit graph** — one rejected fetch white-screens the window, and its own
  error UI is unreachable dead code (GRAPH-F1).
- **Git window** — a failing `listBranches` or worktree list blanks the whole
  standalone window (BR-D1, WT-R5).

---

## Track 1 — Working diff viewer

### DIFF-A1 — CRITICAL / proven

`src-tauri/src/git/diff.rs:19` uses `diff_tree_to_workdir_with_index`, which is
`git diff HEAD` — **it includes staged changes** — where `git diff` was meant.

```rust
let diff = if staged_only {
    repo.diff_tree_to_index(head_tree.as_ref(), None, None)?      // git diff --cached  OK
} else {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true);
    repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?  // git diff HEAD  WRONG
};
```

Probe: staged edit at line 3 + unstaged edit at line 35 → `staged_only=false`
returned **2 hunks**; `staged_only=true` correctly returned 1.

**Staging a hunk does not remove it from the view.** This is the primary reason
staging appears to do nothing.

### DIFF-A2 — CRITICAL / reading

The frontend never passes `stagedOnly` at all (`DiffTabView.tsx:45` calls
`gitApi.diffWorking(repo)`), and `openDiffTab` (`store/layout/index.ts:940-951`)
dedupes on `filePath` alone. A staged row and an unstaged row therefore open
**the same tab**.

### DIFF-A3 — CRITICAL / reading

`DiffTabView` has **no `onGitRefsChanged` subscription**. It refetches only when
its source props change, on its own actions, or via the manual button.

### DIFF-A9 — HIGH / found while fixing A1, not by the audit

`DiffTabView` passed a **repo-relative** path to `fsApi.readFile`, which needs a
filesystem path.

The git sidebar opens diffs with `entry.path()` straight from git2, which is
relative to the repo root. `fs_read_file` therefore failed on every diff opened
from the sidebar, and the `.catch(() => "")` guard turned that failure into an
empty string — so `workingTreeSides` was handed a blank working document and
Monaco rendered the file as entirely deleted.

The `catch` itself is right and stays: a diff of a file deleted in the working
tree is a legitimate thing to open. It was masking a caller bug, not covering
for one.

**Fixed** alongside A1/A2: `DiffTabView` now derives `relPath()` for git calls
and `absPath()` for the filesystem read, and matches `FileDiff` entries on the
relative form.

### DIFF-A4 — HIGH / proven

Untracked files are labelled `"modified"`. `diff.rs:44`'s `_ => "modified"` arm
swallows `Delta::Untracked`, `Typechange` and `Conflicted`. Probe:
`brand-new.txt status="modified"`.

### DIFF-A5 — HIGH / proven

No `DiffFindOptions` / `find_similar` anywhere in `src-tauri/src`, so a rename
becomes two entries: `new-name.txt` as `"modified"` with `old_path == new_path`,
plus `old-name.txt` as `"deleted"`.

### DIFF-A6 — HIGH / reading

`ignoreWhitespace` never reaches `DiffOptions`. `SplitDiffRenderer.tsx:438-494`
`applyIgnoreWhitespace` is a pure client-side transform, so counts and file
lists disagree with what renders.

### DIFF-A7 — MEDIUM / reading

`from_utf8(...).unwrap_or("")` on both the hunk header and line content, so
non-UTF-8 line content silently renders as empty.

### DIFF-A8 — MEDIUM / reading

No diff size caps anywhere, combined with `include_untracked(true)`.

### Lower

- `\ No newline at end of file` markers render as literal rows.
- Zero-hunk files render a blank pane with no explanation.
- `GitDiffView.tsx` is dead code — `grep -rn "GitDiffView" src/` outside its own
  file returns nothing.
- `<For>` rebuilds all DOM per refetch.
- No diff virtualization.

### Verified correct

Split-view pairing convention is standard; line numbers are trusted from Rust
and are emitted correctly; `createResource` discards out-of-order resolutions
internally (`pr === p`); no prop-destructuring reactivity traps.

---

## Track 2 — Git sidebar file list

### SIDEBAR-B1 — HIGH / proven

**Dual-state collapse.** `git_file_status_impl` emits **one row per file** via a
single `if / else if` chain (conflicted → index-\* → wt-\* → else). A file that is
both staged and modified (`MM` in git) yields:

```
[GitFileStatus { path: "a.txt", status: "modified", staged: true }]
```

The unstaged half is invisible. This is the literal "files listed are not all
the ones that should be there".

### SIDEBAR-B2 — HIGH / proven

Renames surface as `untracked` + `deleted`, because no rename detection is
enabled. The `is_index_renamed()` / `is_wt_renamed()` branches are dead.

### SIDEBAR-B3 — MEDIUM / reading

The search filter is applied to rows (`GitSidebar.tsx:764-767`) but **not** to
section gates or counts (`:751-752`). The Conflicts section can render empty
under a "Conflicts (0)" header while a real conflict exists.

### Lower

- Typechange folded into "modified".
- Non-UTF-8 paths silently skipped (`entry.path()` `None => continue`).
- `discardAllChanges` ignores the active filter.
- `VirtualFileList` `<For>` keys by reference.
- `StatusBadge` has dead branches for statuses the backend never emits.

### Verified correct

`sectionOf()` (`changesNav.ts:41-44`) is total — the frontend grouping loses
nothing. `StatusOptions` correctly sets
`include_untracked(true).recurse_untracked_dirs(true).include_ignored(false)`.

---

## Track 3 — Refresh architecture

### REFRESH-C1 — CRITICAL / reading — **fixed**

Fixed by `src-tauri/src/watch/mod.rs`. Two cheaper options were tried first and
rejected on evidence, recorded here so they are not re-proposed:

- **Refresh on window focus** does not help. The terminal is *inside* the app,
  so running git there never changes window focus.
- **Hooking the terminal's process poll** does not help either.
  `terminalWatch.ts` samples at 1500ms and needs two consecutive busy samples,
  so a ~100ms `git commit` is usually never observed as busy at all. It catches
  a long rebase and misses every ordinary command.

### REFRESH-C1 — the original finding

**There is no filesystem watcher at all.** `src-tauri/src/fs/mod.rs:219-220`
carries a comment explicitly declining one. External changes — a `git` command
typed into the app's own terminal, an editor writing a file, a directory deleted
in Finder — are invisible until an unrelated in-app git action happens to fire a
pulse. This feels intermittent but is structural, and it is the root cause of
the third complaint.

### REFRESH-C2 — HIGH / reading

46 calls go through the `emitGitRefsChanged()` helper; **11 raw `dispatchEvent`
bypasses** exist:

```
App.tsx:385,424,496,535,570   SettingsDialog.tsx:2375
MainSurface.tsx:658,717        GitDiffView.tsx:69
ConflictTab.tsx:63             StackTab.tsx:91
```

Subscribers split 12 helper / 5 raw. Raw listeners skip the coalescing and the
`GitRefsPulse.remote` flag.

### REFRESH-C3 — MEDIUM / reading

`flushGitRefsChanged()` is never called in production (tests only), so a pulse
pending inside the 40ms coalescing window is lost at teardown.

### REFRESH-C4 — MEDIUM / reading

`freshness.ts`'s premise ("fires after every local operation") is false given
C1, and it is wired into only the StatusBar and the GitSidebar.

### Verified correct

The cross-window bridge (`api/windows.ts:329-357`) is sound; the
`GitRefsPulse.remote` flag correctly prevents ping-pong.

---

## Track 4 — Hunk staging

### HUNK-H1 — HIGH / reading

**Hunk-level stage and discard are unreachable in the shipped app.**

`onStageHunk` / `onDiscardHunk` are declared by `SplitDiffRenderer.tsx:11,16`
and supplied by exactly one caller — `GitDiffView.tsx:207,209` — which has **no
import site anywhere in the tree**. `gitApi.applyHunk` / `discardHunk` likewise
have no callers outside that dead file.

Therefore:

- `git_apply_hunk` and `git_discard_hunk` are registered Rust commands the app
  can never invoke.
- `SplitDiffRenderer`'s `<Show when={props.actions?.onStageHunk}>` gates are
  always false, so **no hunk header ever renders a stage/discard button**.
- Whole-file staging is the only granularity available.

Combined with DIFF-A1 and DIFF-A3, the diff pane is a surface where staging
appears to do nothing *and* offers no per-hunk control.

### HUNK-H2 — verified correct

The design is sound where a bug was expected. `git_apply_hunk_impl(repo_path,
file: FileDiff, hunk_index, reverse)` takes the frontend's `FileDiff`
**verbatim** and builds a patch from `file.hunks[hunk_index]`. It does **not**
re-derive the diff, so there is no basis-mismatch class of bug, and the
whitespace desync (DIFF-A6) cannot corrupt anything here.

Also correct:

- `build_unified_patch_inverted` (`apply_hunk.rs:164-220`) swaps paths, `+`/`-`
  prefixes, line counts **and** `old_start`/`new_start` in the header.
- `\ No newline at end of file` pseudo-lines are excluded from counts and
  re-emitted verbatim (`is_eof_marker`, `:161`).
- Line counts are recomputed from the lines actually shipped rather than
  trusting `hunk.old_lines`, which is correct since the frontend may have
  filtered.
- `GitDiffView`'s filtered→raw index remap via `(oldStart, newStart)`
  (`:43-76`) is correct, so a revival would inherit a working remap.
- `opts.check(false)` is **not** a bug — `check(true)` means "verify, don't
  apply".
- `apply_hunk.rs:224` has its own `mod tests`, which passes.

### HUNK-H3 — MEDIUM / reading, latent

No time-of-check/time-of-use guard: nothing validates that the file on disk
still matches the diff the patch was built from — no blob oid, no content hash,
no mtime. Given REFRESH-C1 a rendered diff can be arbitrarily stale. libgit2's
`apply` does context matching and will usually reject a misfitting patch, so
this degrades to a confusing error rather than silent corruption — but that is
libgit2 defending, not the app.

**This becomes a real data-loss risk the moment HUNK-H1 is fixed.** Pass the
blob oid the diff was generated against and verify in Rust before applying, in
the same change that makes `discardHunk` reachable.

---

## Track 5 — Worktrees & stashes

### Worktrees — enumeration

| id | sev | conf | finding |
|---|---|---|---|
| WT-W1 | med | proven | `worktree.rs:80-90` handles `HEAD`/`branch`/`detached`/`locked` and **drops `prunable`**. A worktree whose directory was deleted renders as a normal row with a `?` badge and nothing saying it is gone. "Open this worktree" then registers a workspace pointing at a deleted dir; every terminal spawned there fails. |
| WT-W2 | low | proven | `bare` also dropped. A bare repo yields `branch: None, isMain: true`, labels itself with the raw path, gets a spurious `?` (git status exits 128), and counts toward `length` — so the "Create a worktree" empty state is suppressed at 1 real worktree, while 0 worktrees claims "only the main worktree exists" when there is none. Gate at `GitSidebar.tsx:1955`. |
| WT-W3 | low | reading | Porcelain parsed without `-z` (`worktree.rs:59-91`). A path containing a newline splits into a phantom truncated row plus a silently discarded line. Git 2.36+ supports `--porcelain -z`. |
| WT-W4 | low | reading | `cmd.rs:167` uses `from_utf8_lossy` — non-UTF-8 paths are **kept corrupted** rather than dropped, so open/remove send a path that does not exist. Unreachable on APFS; real on ext4. |
| WT-W5 | med | proven | A locked worktree can never be removed and there is **no unlock command anywhere**. `isDirtyRefusal` tests for `use 'remove -f'` but git emits `use 'remove -f -f'` — no substring match (trailing apostrophe). It correctly declines to offer force, but leaves a dead end with a raw porcelain error. |
| WT-W6 | low | reading | `worktree.rs:103-106` — if `repo_canon` is `None`, the raw-`Path` fallback fails on `/tmp` vs `/private/tmp` or a trailing slash, and **no row is marked current**. |
| WT-W7 | med | reading | `statusUnknown` is dropped on the way into the store (`workspaces.ts:283-296`; absent from `types/workspace.ts:11-33`). The rail (`WorkspaceRail.tsx:355-362`) and the ⌘⇧P switcher render `isDirty` alone. Rust's own comment says "false must not be read as clean" — the sidebar honours it, the two surfaces the user actually looks at do not. Unmounted volume → looks clean → force-remove work that was never checked. |
| WT-W8 | **high** | reading | Each pulse triggers **two** full enumerations (pane at `GitSidebar.tsx:1867` and `hydrateAllWorktrees` at `WorkspaceRail.tsx:51`), each 2N+1 serialized subprocesses inside the per-repo mutex. 3 workspaces × 4 worktrees ≈ **27 git child processes per pulse**, queued behind everything else the pulse wakes. The sidebars do update — seconds later, after the queue drains. No cache, no skip-when-collapsed. |
| WT-W9 | med | suspected | `ENRICH_TIMEOUT` (15s) does not cover spawn: `cmd.rs:110-125` calls `Command::spawn()` before the deadline loop at `:137-155`. A hung NFS/SMB `current_dir` blocks in spawn and hangs the whole git sidebar via the mutex. The comment at `worktree.rs:7-10` believes this is covered. |
| WT-W10 | low | reading | Empty state and list render simultaneously (the `<For>` at `:1965` is not in the fallback), and `?? 0` makes the "only the main worktree" claim during first load, so a 6-worktree repo flashes the wrong message. |

**Correct:** all worktrees listed, main first (matches git's documented
guarantee); detached listed, flagged, labelled; branch fresh per refetch; locked
shown with an icon; `git_add_worktree_impl` matches by canonical path not
basename (the shared-basename bug is genuinely fixed); `isDirtyRefusal`
correctly withholds force for lock/permission/missing-dir failures.

### Stashes — enumeration

| id | sev | conf | finding |
|---|---|---|---|
| WT-S1 | **high** | proven | **The stash diff omits untracked files.** Both `stash.rs:136-140` and the UI path (`GitSidebar.tsx:2285-2291`) diff `stash@{N}^1..stash@{N}`. Untracked files live in the **third parent** (`^3`), never read. Probe: `git stash push -u` → `git diff --name-status stash@{0}^1 stash@{0}` gives `M f.txt`; `git stash show -u` gives `M f.txt` **and** `A untracked.txt`. The Stash dialog defaults "include untracked" to **true** (`:932`), so this is the default path. |
| WT-S2 | med | reading | `showDiff` addresses the stash **by index only**, with no oid guard — unlike every mutating action. Worse: the compare tab stores the literal strings `stash@{1}^1` / `stash@{1}` and re-resolves them on every refresh, so an open stash diff silently retargets when the stack shifts and never self-corrects. |
| WT-S3 | low | reading | `git_stash_show` / `gitApi.stashShow` are dead — no caller in either tree. Matters because fixing WT-S1 there alone would fix nothing visible. |
| WT-S4 | low | reading | `stash_drop` (`stash.rs:124-132`) is the only stash mutation not wrapped in `retry_on_lock` (apply and pop are). Fails safe, but unexplained. |
| WT-S5 | med | reading | Apply/pop have no conflict recovery. A conflicting apply leaves markers and a conflicted index; the pane shows a red toast with libgit2's raw message and no route to the conflict resolver, unlike `doPull` (`:390-395`). |
| WT-S6 | low | reading | `dialogConfirm` awaits **outside** the in-flight gate (`:2267-2272`, same shape at `:1907`), so `busy()` is false while the dialog is open. Mitigated by Tauri's native modal. |
| WT-S7 | med | reading | A collapsed Stashes section gives **no signal that stashes exist** — default collapsed (`prefs.ts:105`), `Section` renders no count badge for any section, and `<Show when={props.open}>` unmounts the pane so nothing is fetched. Twelve stashes looks identical to zero. |

**Correct — including the most important right thing in the audit:** no cap
(`stash_foreach` enumerates the whole stack); ordering and index correct;
**the classic stale-index data-loss bug is genuinely prevented** —
`verify_stash_oid` (`stash.rs:69-92`) refuses when the oid at that position is
not the one the UI saw, with distinct "shifted"/"gone" messages, both
test-covered (`stash.rs:150-189`). The tightest race (drop `{0}`, click `{1}`
before the pulse lands) errors out rather than dropping the wrong stash. Also:
stashes cannot have empty messages; drop is confirmed with an irreversibility
warning; there is no drop-all at all.

### Refresh — mutations that never emit

| id | sev | conf | finding |
|---|---|---|---|
| WT-R1 | **high** | reading | **The rail's "Remove worktree" never emits a pulse.** `WorkspaceRail.tsx:157-184` calls the API, updates the local store, toasts — no `emitGitRefsChanged()` (it does not even import emit). The rail row vanishes; the sidebar pane keeps showing the removed worktree until some unrelated git op fires. |
| WT-R2 | **high** | reading | **The palette's "Remove current worktree…" deletes a directory with no confirmation.** `App.tsx:1291-1307`: the `…` promises a prompt that does not exist; no refresh emit; no `isDirtyRefusal` and no force fallback; the prune warning is discarded. |
| WT-R3 | med | reading | "Open this worktree" is a **silent no-op in the standalone git window** — it calls `useAppStore()`, which there is a private non-persisted copy (`GitApp.tsx:83`) with no rail. `requestNewWorktree` handles this case explicitly (`commands/worktree.ts:38-44`); `openWorktree` never got the same treatment. |
| WT-R4 | **high** | reading | **"New worktree" in the git window can target the wrong repository.** `GitSidebar.tsx:1869-1880` reads `repoRoot` from the git window's *local* store (hydrated from localStorage at open, never updated by the context broadcast) but passes the live `props.repoPath` only as `sourcePath`. Open the git window on workspace A, switch the workbench to B: the panes follow B, but "New worktree" adds to **A** while copying env files from B. |
| WT-R5 | **high** | reading | **The git window has no ErrorBoundary at all** — `GitApp.tsx:347-358` renders both panes bare. See [the cross-cutting defect](#the-cross-cutting-defect). |
| WT-R6 | low | reading | `<For>` over freshly-deserialized objects rebuilds every row per pulse. Since row actions are `opacity-0 group-hover:opacity-100`, a pulse landing between mousedown and mouseup swallows the click. Cannot fire the *wrong* row's handler. |

**Correct:** both panes subscribe via `onGitRefsChanged` with cleanup;
sidebar-pane worktree remove emits on all three exits; the wizard emits right
after `worktree add` succeeds, before the slow setup; stash
apply/pop/drop/save all emit in `finally`; the auto-stash on branch switch
emits; `GitErrorBoundary`'s retry genuinely remounts and refetches;
`createResource` discards out-of-order responses.

### Filter/count — negative result

The Changes-section pattern does **not** repeat. Neither pane has a filter, and
`Section` carries no count badge for any section, so there is nothing to
desync. The analogous defect is WT-S7 (no count at all when collapsed).

### Destructive-action safety

- **WT-D1 (med)** — `WorkspaceRail.tsx:165-172` offers force-remove on **any**
  failure via a bare `catch`, with no `isDirtyRefusal`. `GitSidebar.tsx:1893-1896`
  documents why this is wrong and fixes it — in one of three call sites. A lock
  error routes the user to a button whose whole job is discarding changes, and
  the single `--force` then fails anyway (WT-W5).
- **WT-D2 (low)** — two of three removal paths discard the prune warning
  (`WorkspaceRail.tsx:166,180`; `App.tsx:1300`).
- **WT-D3 (low)** — `worktree_apply_setup` joins unvalidated relative paths
  (`worktree_setup.rs:316-336`); `../../../.ssh/id_rsa` would copy outside the
  worktree in both directions. No live exploit (values come from the backend's
  own plan, local app), but a free invariant to assert.
- **WT-D4 (med)** — `NewWorktreeWizard.tsx:171-173` classifies against **local**
  branches only, so a remote-only `origin/feature/x` is treated as new and
  branched off HEAD instead of tracking. Documented in Gotchas; no hint at the
  decision point.
- **WT-D5 (low)** — clicking "New worktree" with a wizard already open is a
  silent no-op (`commands/worktree.ts:45`).

**Correct:** sidebar-pane removal confirms → classifies → confirms force
separately → reports errors in the force branch; no success-toast-on-failure in
either pane; the wizard reports partial setup failure per step; post-removal
prune failure is a warning not a rejection.

### Noticed outside the brief

`copy_dir_recursive` (`worktree_setup.rs:411-413`) recreates every symlink with
`symlink_dir` regardless of target type — wrong for file symlinks on Windows.
Unix unaffected.

### Docs drift — `docs/features/worktrees.md`

Stale in five places: "force-remove offered on any failure" (fixed in the pane,
still true in the rail); "prune failure is discarded" (it returns a warning
now); the branch-name-prompt + "open as new workspace?" flow is gone, replaced
by the three-step wizard; "**no detached worktrees**" is wrong; the Removing
section never mentions that the palette command deletes without confirmation.

---

## Track 6 — Commit graph

**Zero tests exist.** No `lanes.test.ts`, no `#[cfg(test)]` in `graph.rs`. The
lane router — the most algorithmically dense code in the feature — has never
been executed against a fixture.

### GRAPH-L1 — CRITICAL / proven

`lanes.ts:81-86`. When a commit's parent already has a lane (i.e. the parent has
another child already emitted), the `existing !== -1` branch adds to `origin`
but writes no new column. The second pass at `lanes.ts:122` —
`top = dotOrigin[i].has(k) ? cols[i] : k` — then **overrides** that column's top
with the current dot. The earlier child's edge to the shared parent produces no
segment in that gap at all: **its line stops dead in mid-air.**

`dotOrigin` conflates "this lane sprang from my dot" with "my dot also joins
this lane". Such a column needs **two** segments (a pass-through *and* a dot
connector); only one is ever emitted.

Against this repo's own history, 155 real rows through the real `computeLanes`:

```
rows=155 maxCols=5 edges=180 brokenEdges=12 truncatedParents=0 visualBreaks=26
  broken edge 5f86724 row2  -> 6cea373 row12
  broken edge 4c02a5a row9  -> 6cea373 row12
  broken edge aaeb3af row17 -> dfc8073 row23
```

Minimal repro — `t1→b1`, `t2→b2`, `b1→base`, `b2→base`, `base`:

```
row2 b1   col=0 segs=[0->0 c0] [1->1 c1]
row3 b2   col=1 segs=[1->0 c0]        <-- one segment; b1's lane at col 0 vanished
```

**Every fork point in every repo hits this.**

### Lane router — remaining

- **GRAPH-L2 (high, proven)** — same root cause on octopus merges (p1 and p2
  edges both unconnected) and on a merge whose second parent is an ancestor of
  its first.
- **GRAPH-L3 (med, reading)** — `lanes.ts:88-90`: when the first parent already
  has a lane, `after[col]` is left null and the trunk kinks sideways. The
  documented "first parent keeps the mainline vertical" is false whenever the
  first parent was already claimed.
- **GRAPH-L4 (low, reading)** — `lanes.ts:12-13,126`: the `lane` colour index is
  the **bottom** column, contradicting its own doc comment, so a connector
  leaving a dot is frequently a different colour from the dot.
- **GRAPH-L5 (low, proven)** — `lanes.ts:111` (`if (i < n-1)`): the last row
  emits no segments, so in-flight lanes stop one row early. The truncation
  boundary is invisible — nothing distinguishes "history ends here" from "we
  fetched 200".
- **GRAPH-L6 (low, reading)** — a parent truncated out of the window keeps a
  lane occupied to the end of the list without being marked as truncated.

**Correct (proven):** root commits release their column; disconnected roots
reuse column 0 without a spurious connector; duplicate parent oids collapse;
octopus lane *allocation* is right; lane reuse after a branch ends works; **no
lane collisions in any fixture or in the 155-row real run**; `maxCols` computed
before the trim so the gutter is never too narrow.

### Revwalk — `graph.rs`

- **GRAPH-R1 (high, proven)** — `:89-97` seeds from HEAD + `refs/heads/*` +
  `refs/remotes/*` only. **Tags and stashes are never seeded**, yet `:50` still
  builds decorations for tags — so a tag chip can never render for a commit not
  also on a branch. Probe: a commit tagged `v1` whose branch was deleted is
  absent, along with both stash commits. Also missing: `refs/notes/*`,
  `refs/pull/*`, `ORIG_HEAD`/`MERGE_HEAD`/`REBASE_HEAD` (an in-flight rebase's
  original tip is invisible), and **other linked worktrees' HEADs**.
- **GRAPH-R2 (med, reading)** — `:103-107`: `revwalk.take(limit)` counts errored
  items against the budget and `Err(_) => continue` drops rows. One unreadable
  object → 199 rows for `limit=200` → `CommitGraph.tsx:93`'s `length === limit()`
  check hides "Load more" **permanently**.
- **GRAPH-R3 (med, proven)** — `:54`'s `name == "HEAD"` guard misses
  `refs/remotes/origin/HEAD` (shorthand `origin/HEAD`), so every cloned repo
  shows a redundant chip on the default-branch tip.
- **GRAPH-R4 (low, reading)** — `:65-67` `sort(); dedup();` collapses a tag and a
  branch sharing a name into one chip.
- **GRAPH-R5 (med, reading)** — `:118` reports **author** time; `Sort::TIME`
  orders by **committer** time. After a rebase or cherry-pick the rows are
  ordered one way and timestamped another, so relative times read out of order.
- **GRAPH-R6 (med, reading)** — `:82` + `mod.rs:254-266`: `Sort::TOPOLOGICAL`
  forces libgit2 to load and sort the **entire** reachable graph before yielding
  commit one, all inside `blocking_git!`'s per-repo mutex. `limit` does not bound
  the work.
- **GRAPH-R7 (low, reading)** — inherits non-UTF-8: `:53` drops the ref,
  `:116`/`:117` render `""`.

**Correct:** `Sort::TOPOLOGICAL` in git2 0.19 is documented as
children-before-parents (verified in the vendored source), so **the sort mode
cannot render a parent above its child**, and the ORDER invariant never fired
across 155 real rows. `push_head` + `push_glob` does not duplicate.
`push_glob("refs/remotes/*")` does match nested `origin/main`. Unborn HEAD
returns `Ok(vec![])` cleanly. Detached HEAD seeded correctly. Annotated tags
peeled correctly.

### Pagination

- **GRAPH-P1 (high, reading)** — `CommitGraph.tsx:54-59,95`: "Load more" mutates
  the resource *source*, so the whole window refetches from scratch
  (200→400→600), never appends.
- **GRAPH-P2 (high, verified against `solid.cjs`)** — `:115-116`'s
  `<Show when={!commits.loading}>` replaces the entire graph with a spinner on
  **every refetch**, not just the first load (Solid sets `"refreshing"`, and
  `loading` returns true for it — `solid.cjs:374,387-390`). Scroll to row 380,
  click Load more → content unmounts, height collapses, `scrollTop` clamps to 0.
  **Same on any `voidlink:refresh-git` pulse.** Scroll position is lost every
  time.
- **GRAPH-P3 (med, reading)** — `:93`: a repo whose total is an exact multiple of
  200 shows a button that loads nothing, and the button disappears mid-fetch,
  flickering out and back on every click.
- **GRAPH-P4 (low, reading)** — `:95` is unbounded with no virtualization. At
  limit 5000: ~5000 divs and 15–25k SVG paths, plus a full topo walk holding the
  repo lock.

**Correct (proven):** "Load more" does **not** reshuffle existing rows —
`computeLanes` is a pure forward pass and libgit2's topo order is a function of
the ref set, not the limit, so the first 200 oids are a stable prefix of the
first 400.

### Refresh

- **GRAPH-F1 (CRITICAL, reading)** — a rejected `git_commit_graph` throws out of
  the component and white-screens the window. The `<Show when={commits.error}>`
  error UI at `:250` is **unreachable dead code**. See
  [the cross-cutting defect](#the-cross-cutting-defect).
- **GRAPH-F2 (med, reading)** — `:63-67` uses raw `window.addEventListener`
  instead of `onGitRefsChanged` and ignores the pulse detail entirely. Because
  panes hide with `display:none` rather than unmounting
  (`MainSurface.tsx:494-500`), **an invisible graph tab keeps refetching on every
  pulse** — full topo walk, lock held.
- **GRAPH-F3 (med, reading)** — selection is never reconciled after refetch.
  After amend/rebase/reset the selected oid is gone from the list but the signal
  keeps it; nothing highlights and the state is silently dead.
- **GRAPH-F4 (med, reading)** — three `<For each={layout().rows}>` over an array
  rebuilt from scratch each fetch, so every row div, dot and path is destroyed
  and recreated on every git operation anywhere in the app.
- **GRAPH-F5 (low, latent)** — `:146-147,172-173`: `y1`/`y2`/`cy` computed once
  from `i()` outside any reactive scope. Harmless **only** because F4 guarantees
  no node is reused. **Fixing F4 without fixing this produces a garbled graph.**

**Correct:** the graph does subscribe and refetches after
commit/amend/rebase/reset/checkout/fetch; refetches on `repoPath` change; the
`<Show when={activeRepoPath()}>{(repo) => …}` accessor form updates the prop
rather than remounting; `selected` survives a refetch because it is keyed on
oid; limit and selection survive tab switching and reset on worktree switch as
documented.

### Ref decoration

- **GRAPH-D1 (med)** — `:225` passes `isHead={c.isHead}` to **every** chip on the
  HEAD commit, so `main`, `origin/main` and `v2.0` all render in HEAD style,
  erasing the local/remote/tag distinction exactly where it matters.
- **GRAPH-D2 (low)** — `:266` `isRemote = name.includes("/")`, so local
  `feature/x` gets the cloud icon and tags are indistinguishable from branches.
  Fix is a one-field backend change (emit a `kind` discriminant).
- **GRAPH-D3 (low)** — detached HEAD gets a ring but no chip.
- **GRAPH-D4 (low)** — `:280` chips truncate at 120px with no priority, and refs
  are sorted alphabetically, so the current branch can be pushed offscreen behind
  `aaa-old-branch`.

### Rendering

- **GRAPH-S1 (med)** — `:124-131`: the error state renders the empty state, so a
  failed fetch looks nearly like an empty repo.
- **GRAPH-S2 (low)** — `relTime` reads `Date.now()` at render, non-reactively. A
  graph left open an hour still says "just now".
- **GRAPH-S3 (low)** — fixed 30-day months / 360-day years, and a future
  timestamp renders "just now".
- **GRAPH-S4 (low)** — `:70` gutter width uncapped; 30 concurrent lanes = 500px
  of gutter squeezing the summary to nothing.
- **GRAPH-S5 (low)** — `:208-217` rows are `div`s with `onClick`, no
  `role`/`tabindex`/keyboard handler.

No virtualization is present — checked explicitly.

### Graph → diff handoff

- **GRAPH-O1 (med)** — `MainSurface.tsx:1098-1107`: clicking a row calls
  `openCompareTab`, which **unconditionally creates a new tab** — no dedupe,
  unlike `openHistoryTab` at `:1731`. Ten row clicks = ten compare tabs.
- **GRAPH-O2 (med)** — `MainSurface.tsx:1102`: `baseRef: \`${oid}^\``. For a root
  commit that does not resolve; for a **merge commit** it silently means
  first-parent-only, so the compare shows the whole side-branch delta rather than
  the merge's own resolution.
- **GRAPH-O3 (low)** — `docs/features/commit-graph.md:83-86` is stale: it claims
  the graph tab does not persist and `Mod+Shift+T` cannot reopen it. Both false
  (`tabs.ts:475-486`, `layout/index.ts:1750`).
- **GRAPH-O4 (low)** — `:88-90` header shows the capped count with no "of N".

### Not reported, with reasons

The `PoisonError::into_inner` recovery (`mod.rs:258-260`) is deliberate and
correct for a `Mutex<()>`; the `laneColor` negative-modulo guard is defensive
but harmless; `limit as usize` cannot truncate on any supported target; the SVG
gutter offset is geometrically correct.

### Noticed outside the brief

`git_log_impl` (`status.rs:62-111`) is a **separate, TIME-only,
HEAD-or-single-branch walk** feeding the sidebar's History section. The sidebar
history and the graph will therefore disagree about both ordering (TIME vs
TOPOLOGICAL) and which commits exist (HEAD-only vs all branches).

---

## Track 7 — Branches & remotes

### Enumeration

- **BR-A1 (high, proven)** — **`origin/HEAD` is listed as a branch.**
  `branch.rs:19-32` iterates `repo.branches(Some(Remote))`, which returns the
  symbolic ref `refs/remotes/origin/HEAD`. Clicking it hits
  `safe_checkout.rs:114-118`, which computes `local_name = "HEAD"` and calls
  `repo.branch("HEAD", …)` → `Err("'HEAD' is not a valid branch name")`. So in
  **every cloned repo** there is a phantom, permanently un-checkout-able row —
  and its context menu still offers "Merge origin/HEAD into current", which
  *succeeds*, silently operating on `origin/main` under a misleading name.
- **BR-A2 (med, proven)** — the unborn/orphan branch is invisible.
  `git init -b main` with no commit lists zero branches while the header says
  `main`. With BR-A9 the pane is a blank rectangle in every fresh repo.
- **BR-A3 (med, reading)** — **remote branches are never pruned, and only
  `origin` is ever fetched.** `fetch.rs:23-35` never calls `prune()`, and
  `doFetch` (`GitSidebar.tsx:376`) passes no remote so `fetch.rs:26` falls back
  to `"origin"`. So a branch deleted on the server stays listed forever, and **a
  remote added via RemotesDialog is never fetched by any code path** — its
  branches never appear at all.
- **BR-A4 (low, reading)** — non-UTF-8 branch names silently dropped
  (`branch.rs:25-32`, `refs.rs:22-25`, `:38-45`). APFS-unreachable.
- **BR-A5 (low, proven)** — symbolic refs under `refs/heads/` render as ordinary
  branches; deleting one deletes the alias, not the target, with no label.
- **BR-A7 (low, reading)** — local and remote rows interleaved through one sort
  (`:1729-1734`), no grouping, no remote chip, no count, no way to hide remotes
  (`listBranches(p, true)` hardcoded at `:1548`).
- **BR-A8 (low, reading)** — `upstream`, `lastCommitSummary`, `lastCommitTime`
  are computed per branch (`branch.rs:61-73`, a `find_commit` each) and **never
  displayed**.
- **BR-A9 (med, reading)** — no loading state, no empty state, no error text.
  While loading and when the repo has zero branches the pane renders **nothing**.
  `TagsPane:2202` does have an `EmptyState`.
- **BR-A11 (low, reading)** — `refs.rs:59-60` pushes `refs/heads/*` + HEAD but
  not `refs/remotes/*`, so ref-picker "recent commits" never include a commit
  that exists only on a fetched remote branch.

**Correct:** packed refs read transparently (byte-identical list after
`git pack-refs --all`); tags have no cap and no dedup problem.

### Ahead/behind

- **BR-B1 (med, proven)** — **a deleted remote-tracking ref silently reads as
  "no upstream".** `branch.rs:36-56`'s `else` returns `(None, 0, 0, false)`. With
  `branch.feature.remote`/`.merge` still in config but the ref gone, the row
  renders identically to a branch that never tracked anything — no arrows, no
  `?`. `aheadBehindUnknown` exists for exactly this ambiguity and is not used.
- **BR-B3 (low, reading)** — remote rows hardcode `(None,0,0,false)`; reasonable,
  but visually identical to an in-sync local branch.
- **BR-B4 (med, proven)** — **detached HEAD marks no row and says nothing.**
  Every row has `head=false`; the pane loses its highlight and offers delete on
  every local branch including the one you were on. No banner in the pane.

**Correct:** diverged/ahead/behind is right; `graph_ahead_behind` failure sets
the `?` chip with tooltip; push sets upstream only when absent and never
clobbers (test-covered, `push.rs:129-136`); push rejects detached HEAD and
treats server rejects as errors (tested).

### Refresh

- **BR-C1 — negative result, a clean one.** `BranchesPane` **does** subscribe
  (`:1612`), and **every** branch/remote mutation emits in a `finally` —
  checkout, create, rename, delete, merge, rebase, fetch, pull, push, and all
  four remote ops. **No missing emit was found in this track.**
- **BR-C2 (high, reading)** — **Fetch / Pull / Manage-remotes are silent no-ops
  when the git sidebar is collapsed.** `App.tsx:1389-1393` unmounts `GitSidebar`
  when collapsed (and again in stacked mode, `:1476`), but the palette actions
  `git.fetch`/`git.pull`/`git.remotes` (`App.tsx:385-413`) just `dispatchEvent`,
  and the only listeners live in `GitSidebar.onMount` (`:321-323`). `Mod+J` then
  `Mod+Shift+F` → nothing happens, no error, no toast.
- **BR-C3 (med, reading)** — the standalone git window has **no fetch / pull /
  push / remotes at all**. `GitApp.tsx:340-346` renders `BranchesPane` alone;
  `RemotesDialog` is only instantiated at `GitSidebar.tsx:592`.
- **BR-C4 (low, reading)** — `RemotesDialog` does not subscribe, so a remote
  added from another window or a terminal is not reflected in an open dialog.
- **BR-C5 (low/med, reading)** — `<For>` keys by object identity over fresh
  objects, so every row is torn down each pulse: **a focused row button loses
  focus mid-refresh**, and hover-revealed buttons flicker. No virtualization
  here, unlike History.
- **BR-C6 (low, reading)** — verified against `solid.cjs:311-319`: `completeLoad`
  only calls `setValue` on success, so switching worktrees **renders the previous
  repo's branches** for the duration of the round-trip.

**Correct:** stale-while-*error* does not happen — `solid.cjs:320-324` throws
rather than rendering stale data. Which produces BR-D1.

- **BR-D1 (high, reading)** — a failing `listBranches` takes down the entire git
  window. See [the cross-cutting defect](#the-cross-cutting-defect).
- **BR-D2 (low, reading)** — `TagsPane` is mounted **twice** in the git window
  (`BranchesPane:1836` embeds it, `GitApp.tsx:362-364` renders it again), so both
  instances fetch `git_list_refs` on every pulse.
- **BR-D3 (low, reading)** — the context menu holds a stale branch name across a
  pulse.

### Filter/count — negative result

The Changes-section bug does **not** repeat: there are no counts or gates in
Branches or Remotes at all, and the one gate that exists (`:1832`) deliberately
and correctly mixes unfiltered and filtered counts.

- **BR-E2 (low)** — the fuzzy subsequence fallback is very loose (filtering
  `main` matches `feature/my-api-normalizer`), and matched ranges are not
  highlighted despite `FuzzyText`/`MatchRange` being imported at `:61-62`.

### Destructive-action safety

- **BR-F1 (high, proven)** — **deleting a branch mid-rebase corrupts the
  rebase.** `git_delete_branch_impl` (`branch.rs:121-150`) is the **only** branch
  mutation without `opstate::ensure_no_operation`. During a rebase HEAD is
  detached, so `branch.is_head()` is false and the guard at `:130` does not fire:

  ```
  state: RebaseInteractive detached=Ok(true)
    topic head=false
    delete() -> Ok(())
  then: git rebase --continue
    error: update_ref failed for ref 'refs/heads/topic': unable to resolve reference
  ```

  The replayed commit is then reachable only from the reflog. **Reachable from
  the UI in the git window**, where `BranchesPane` is mounted without the
  `operation` prop (`GitApp.tsx:341-345`) so the button is never disabled. In the
  workbench the button *is* disabled — meaning **the UI is the only thing
  preventing this; the backend is not.**
- **BR-F2 (med, reading)** — `deleteBranch` (`:1680-1710`) is the one action not
  routed through `run()`, so `busy()` never goes true during a delete and a
  checkout can start concurrently. `inflight.ts`'s own doc comment describes
  exactly this failure mode.
- **BR-F3 (med, proven)** — **"not fully merged" over-fires.** `branch.rs:176`'s
  `ref_name.ends_with(&format!("/{name}"))` is meant to skip the branch's own
  remote counterpart but skips *any* ref whose last segment matches. With
  `refs/heads/feature/topic` at `topic`'s exact tip, `is_merged_anywhere("topic")`
  is false and the force-delete prompt appears for a fully-contained branch. This
  retrains users to click through the force prompt — the exact harm the
  function's own doc comment says it exists to prevent.
- **BR-F5 (low/med, reading)** — `ensure_no_operation` inspects only the opened
  repo's git dir (`opstate.rs:19-22`), but a linked worktree's rebase state lives
  in `.git/worktrees/<id>/rebase-merge`, so renaming a branch mid-rebase **in
  another worktree** is not blocked.
- **BR-F6 (low, proven)** — rename has no force path. `gitApi.renameBranch`
  accepts `force` (`api/git.ts:64`), `BranchesPane:1670` never passes it, and
  there is no overwrite confirm — unlike the tag flow at `:2106-2131`.
- **BR-F7 (low, reading)** — no force-push or `--force-with-lease`; a diverged
  branch just errors. Safe by construction.

**Correct:** deleting a branch checked out in a linked worktree is refused with
a clear message; renaming one succeeds and the worktree follows (matches CLI
git); `switch_to_branch` restores HEAD on a failed checkout
(`branch.rs:237-280`); `safe_checkout` pops the auto-stash if the switch fails
(`:63-78`).

### RemotesDialog

- **BR-G1 (med, proven)** — **no URL validation whatsoever.**
  `repo.remote("origin", "not a url")` returns **`Ok(())`**, and `git config`
  then shows `remote.origin.url = not a url`. `addRemote` (`:2357-2374`) only
  checks `if (!url) return`; `editUrl` has the same hole.
- **BR-G2 (low, proven)** — name is not trimmed, so `" origin"` produces a raw
  libgit2 "is not a valid remote name".
- **BR-G3 (med, proven)** — **removing a remote silently strips every branch's
  upstream.** `remote_delete("origin")` removes all `refs/remotes/origin/*`
  **and** all `branch.*.remote`/`.merge` config. The confirm is just
  `Remove remote "origin"?`. Afterwards every branch loses ahead/behind and Pull
  says "No upstream is set", with nothing having warned the user.
- **BR-G7 (med, reading)** — **adding a remote does not fetch it.** `addRemote`
  emits a pulse whose comment claims "Remote-tracking refs feed ahead/behind and
  the branch list" (`:2370`), but no fetch is issued and per BR-A3 none ever will
  be for a non-`origin` remote. Adding `upstream` produces **zero visible change,
  forever.**
- **BR-G8 (low, reading)** — prompts await outside `run()`, so `busy()` is false
  while they are up; `PromptHost` is a single module-level host, so a second
  prompt likely clobbers the first.

**Correct:** rename rewrites upstream config and tracking refs properly and the
stranded-refspec toast is real and correct; `push_url` handling is correct; a
remote that fails to load is still listed with `—`.

### Two small ones

- `MainSurface.tsx:646-647` records the **requested** branch name into the MRU,
  not `result.branch` — a terminal deep-link to `origin/foo` writes `origin/foo`
  into MRU. `BranchesPane:1619` gets this right.
- `safe_checkout.rs:119-121` returns the *existing* local branch when one matches
  the remote's short name, but `GitSidebar.tsx:1620-1622` toasts "Created local
  branch foo tracking origin/foo" for any `result.branch !== name`. Neither
  happened.

### Docs drift — `docs/features/branches-and-sync.md`

Five "Gotchas" are now wrong: remote-branch click "fails, no create-tracking
path" (fixed in `safe_checkout.rs:92-136`); "push cannot set upstream" (fixed,
`push.rs:94-101`); "merged test compares against HEAD" (now all branchy refs);
"conflict detection is a substring match on `CONFLICT`" (now `has_unmerged_paths`);
the quoted error text predates the `[not-fully-merged]` marker. The doc also
says nothing calls `git_checkout_branch`, but `StackTab.tsx:145` does.
Undocumented entirely: the `origin/HEAD` phantom, the git window's missing sync
controls, RemotesDialog reachable only from the sidebar.

---

## Track 8 — Branch compare

### CMP-F24 — CRITICAL / proven against real `solid-js@1.9.7`

`CompareTab.tsx:97`: `const files = createMemo(() => diff()?.files ?? [])` reads
the resource directly, and there is no boundary above it.

```
  [tree effect] -> [{"p":"v1"}]
A) good ref v2
  [tree effect] -> [{"p":"v2"}]
B) BAD ref
C) good ref v3          <- no effect run
D) good ref v4          <- no effect run
E) good ref v5          <- no effect run
memo value now: [{"p":"v5"}]
```

The memo keeps computing the **correct** value; every effect downstream of it is
**dead forever**. `runUpdates`' catch discards the pending Effects queue while
the observers stay marked STALE, so they are never re-queued.

One typo'd ref — or a root commit, or a stash compare whose stash was dropped —
and from then on:

- The tree keeps showing the previous file list, indefinitely.
- The diff pane keeps showing the previous file.
- **Refresh, Retry, Merge-base toggle, and swap base/head all change the store,
  re-run the fetch, and change nothing on screen.**
- `noteRunning` (`:94`) reads `diff.loading`, not `files()`, so **the tab's
  activity spinner keeps spinning on every refetch** while the content never
  moves.
- The error UI at `:288-300` and the RefPicker `invalid`/`error` props are
  **unreachable** — the effect reading `errMessage()` was queued in the same
  aborted batch and never runs again.
- The Rust error arrives as an unhandled promise rejection in the console and
  nothing else.

Only closing and reopening the tab recovers.

### Diff base

**Correct (proven):** three-dot semantics are right. `compare.rs:33-46` uses
`merge_base(base, head)`'s tree as the left side; probe matches
`git diff --name-status main...feature` exactly, and two-dot matches
`git diff main feature`.

- **CMP-F1 (low)** — the tab label is always two-dot. `MainSurface.tsx:163` and
  `App.tsx:1070` write `` `${baseRef}..${headRef}` `` ignoring `useMergeBase`,
  and the default is merge-base **on**.
- **CMP-F3 (med)** — **the ahead/behind pill opens a two-dot diff.**
  `GitSidebar.tsx:348-352` passes `useMergeBase: false`, but ahead/behind is
  computed from the *symmetric* difference. At ↑1 ↓12 you click "↑1" and get 13
  commits' worth, with upstream's work rendered as deletions.
- **CMP-F2 (low)** — the merge-base fallback is silent and also catches
  non-"no merge base" errors, turning them into a wrong-but-successful diff.

### File-list completeness

- **CMP-F4 (high, proven)** — **mode-only changes render a completely blank
  pane.** `chmod +x run.sh` produces `status=Modified, hunks=0, additions=0,
  deletions=0, binary=false`. The tree lists `M run.sh +0 −0`; clicking it hands
  `DiffRenderer` a non-binary file with zero hunks, so `<For each={[]}>` renders
  nothing. Same shape for submodule pointer changes.
- **CMP-F5 (high, proven)** — **typechange becomes a duplicate-path
  Deleted+Added pair, and only the Deleted half is reachable.**
  `include_typechange` appears nowhere in `src-tauri/src`. A symlink→file change
  gives two `FileDiff`s with identical `newPath`, so `buildTree` pushes two
  leaves with the same path (**both rows highlight at once**), `selectedFile()`
  uses `.find()` and always returns the Deleted one (the Added half is
  **permanently unreachable**), and the footer says "6 files" where git says 5.
- **CMP-F6 (med, proven)** — file↔directory swaps collide on the same tree key.
  `swap` (file) → `swap/` (dir) creates a file leaf and a folder node both with
  `path:"swap"`; selection is ambiguous and sorting puts them non-adjacent.
- **CMP-F7 (med)** — renames appear as add+delete, so `StatusBadge`'s `R`/`C`
  letters are dead code for compare and both the file count and tree shape
  diverge from `git diff -M`.
- **CMP-F8 (low)** — `_ => "modified"` throws away `typechange` even though
  `StatusBadge` already knows the letter.
- **CMP-F9 (low, suspected)** — non-UTF-8 paths lossily transcoded via
  `to_string_lossy()`; two files differing only in invalid bytes collide into one
  tree key. Could not reproduce — APFS rejected the filename.
- **CMP-F10 (med)** — no size caps, no pagination. Every hunk of every file
  serialised as one JSON blob; combined with the per-repo mutex, **one large
  compare stalls every other git command in that repo.**
- **CMP-F11 (low)** — `ignoreWhitespace` is client-side only, so a
  whitespace-only file still counts in the footer and shows `+3 −3` in the tree
  but yields an empty pane. Same blank-pane symptom as CMP-F4, different cause.
- **CMP-F12 (low)** — the footer reduces over unfiltered `props.files` while the
  body shows filtered.

**Correct (verified in libgit2 source):** binary detection works
(`diff.c:146-150` calls `git_patch_from_diff` before the callbacks);
`last_mut()` hunk/line attribution is sound; **no delta is silently skipped** —
`should_skip` only filters on flags this code never sets, and patch failure
`break`s and surfaces as `Err`.

### Refresh

- **CMP-F13 (high)** — **the compare tab subscribes to nothing.** Grep across
  `compare/` and `shared/` for any refresh hook returns none. So: the resource
  keys purely on the ref *strings*, so a commit, fetch, reset, rebase or amend
  leaves the key unchanged and the tab shows a diff for commits no longer at
  those refs; the ref picker keys on `repoPath` alone, so **a newly created
  branch is absent from both pickers until the tab is closed and reopened**; and
  the ahead/behind chips go stale after any push.
- **CMP-F14 (high)** — **the auto-select effect can never re-fire once a
  selection exists.** `CompareTab.tsx:109-116` bails on
  `props.tab.selectedFilePath`, and `setCompareRefs` clears it only when
  `baseRef`/`headRef` change — **not** when `useMergeBase` changes. Four routes
  to a stale selection: toggling merge-base; app reload (`deserializeCompare`
  restores it verbatim); `FileTree.tsx:130-135` / `editorRequests.ts:84-91`
  setting a **working-tree** path that may not be in the diff; or a refresh after
  the file stopped differing. Result: "Select a file in the tree" next to a tree
  with 200 files.

### RefPicker

- **CMP-F17 (high, proven)** — **`EMPTY_TREE_OID` as a base always fails.**
  `GitSidebar.tsx:2660-2672` uses `c.parentOids[0] ?? EMPTY_TREE_OID`, but
  `compare.rs:26-28` calls `peel_to_commit()` unconditionally and a tree cannot
  peel to a commit. So **clicking a root commit in the sidebar always errors** —
  and per CMP-F24 that error bricks the tab. Meanwhile `MainSurface.tsx:1000`
  and `:1103` use `` `${oid}^` `` and fail differently
  (`parent 0 does not exist`), so the *same user action* fails with two different
  messages depending on which pane it was clicked in.
- **CMP-F15 (med)** — detached HEAD is unreachable from the picker:
  `refs.rs:15-33` lists only branches and never synthesises a `HEAD` entry.
- **CMP-F16 (med)** — recent commits push `refs/heads/*` + HEAD only, so commits
  that just arrived on `origin/main` cannot be picked by summary or short SHA.
- **CMP-F18 (low)** — the error-routing regex `\bbase\b`/`\bhead\b` fires on `/`,
  `-`, `_`, so a typo'd `origin/base-fix` turns **both** pickers red while a
  generic lock failure highlights neither.
- **CMP-F19 to F22 (low)** — `/^[0-9a-f]{7,40}$/` misclassifies branches named
  `deadbeef`/`accede`/`beaded` as commits; the first ArrowDown skips item 0 and
  ArrowUp is inert on a closed picker; Escape does not `stopPropagation`; the
  existing value is not editable; and `listBranches(p, false)` means **remote
  branches silently render no ahead/behind chip.**

**Correct:** `refs.rs:26-32` keeps the `origin/` prefix, which is what
`revparse_single` wants; slashes need no escaping; free text on Enter handles
`HEAD~3`, `origin/main^`, `stash@{0}^1`.

### Reactivity

- **CMP-F23 (high, proven)** — **the filename header is frozen on the first file
  you ever select.** `CompareDiffPane.tsx:50-51` does
  `const path = displayPath(f())` inside a non-keyed `<Show>` children function,
  which Solid calls inside `untrack()` and re-runs only on falsy→truthy
  (`solid.cjs:1475-1493`, condition memo `equals: (a,b) => !a === !b`):

  ```
  child runs: 1  header: first.ts   live: first.ts
  child runs: 1  header: first.ts   live: second.ts   <- after switching file
  ```

  The `+/−` counts update and the diff body updates, but **the filename in the
  header stays on the first file** — as does the "renamed from" line.
- **CMP-F25 (med)** — folder expand/collapse resets on every refetch:
  `buildTree` allocates all-new nodes, `<For>` disposes every row, and
  `FolderRow`'s `createSignal(true)` is recreated.
- **CMP-F26 (low, latent)** — `ChangedFileTree.tsx:397` reads `props.node.file`
  outside a tracking scope. Safe **only** because CMP-F25 guarantees fresh
  creation. Fixing F25 by keying on `node.path` turns this into a stale-data bug.
  *(Same trap shape as GRAPH-F4/F5 — found independently by two tracks.)*

**Correct:** `props.tab` reactivity across `<For>` is fine (store proxy,
`activeOf` returns the stored array uncopied); `refsKey` drives the resource
properly and correctly parks on `null`; RefPicker's section index math is
consistent; the resizer's listener lifecycle is clean across multiple tabs.

### Remainder

- **CMP-F28 (low)** — `open_repo`/lock failures carry no `base:`/`head:` prefix,
  so they are indistinguishable from ref typos and offer a Retry that hits the
  same lock.
- **CMP-F29 to F32 (low)** — the resizer keys on
  `getElementById(compare-tab-${id})` rather than a `ref`; tree width,
  `diffMode` and `ignoreWhitespace` are all global rather than per-tab; compact
  folder chains collapse `src/main/java/` but not `src/main/` with one file.
- **CMP-F33 (low)** — `types/git.ts:104`'s `FileDiff.status` union omits
  `untracked`/`typechange`/`conflicted`/`unmerged`, all of which `StatusBadge`
  branches on and `git_file_status` actually emits.
- **CMP-F34 (low)** — docs stale in three places, but `branch-compare.md`'s
  "Gotchas" is otherwise unusually accurate. Missing entirely: F4, F5, F14, F23,
  F24.

---

## Coverage boundary

What was **not** covered, stated so the audit does not read as clean:

- **No track launched the app.** Every frontend finding is source reading plus,
  where marked *proven*, a headless harness replaying the real `solid-js@1.9.7`
  scheduler. Nothing is observed on screen.
- **No track ran `cargo test`.** Rust findings marked *proven* come from probe
  repos driven by real `git`, or from standalone binaries built against
  git2 0.19 (the app's version) replicating the impl functions verbatim.
- **Non-UTF-8 paths** could not be created on APFS, so every non-UTF-8 finding
  is reading-level.
- **Submodules** reasoned by analogy with the proven mode-only case, not probed.
- **Shallow and partial clones** never probed — a shallow clone's boundary
  commits report unresolvable `parent_ids()`, plausibly another dangling-edge
  source.
- **Criss-cross histories** (multiple merge bases) not probed; `repo.merge_base`
  returns one arbitrary base and so does `git diff A...B`, judged equivalent.
- **Not audited at all:** `merge.rs`, `rebase.rs`, `pick.rs`, `conflict.rs`,
  `stack/*` internals, `auth.rs` and credential paths (no network probe),
  `tag.rs` internals, `blame.rs`, `api/windows.ts` itself.
- **Not evaluated:** accessibility beyond the specific findings above, keyboard
  navigation in the file trees, visual design, theme tokens.
- **Windows/Linux-specific behaviour** (ref names, symlinks, path encoding) not
  exercised.
