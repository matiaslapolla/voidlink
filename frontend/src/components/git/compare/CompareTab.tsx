import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { ArrowLeftRight, Columns2, GitMerge, RotateCw, Rows3, Space } from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import {
  COMPARE_TREE_WIDTH_MAX,
  COMPARE_TREE_WIDTH_MIN,
  type CompareTab as CompareTabState,
} from "@/store/layout";
import { ChangedFileTree } from "./ChangedFileTree";
import { CompareDiffPane } from "./CompareDiffPane";
import { RefPicker } from "./RefPicker";
import { branchMruFor } from "@/commands/branchMru";
import { onGitRefsChanged } from "@/commands/gitEvents";
import { clearTabActivity, noteRunning } from "@/store/activity";

// Top-level layout for the Compare tab:
//
//   ┌─ ref pickers + options ────────────────────────────┐
//   │  base ↔ head | merge-base toggle | refresh        │
//   ├─ tree (resizable) │ diff pane                     │
//
// Loads the diff via gitApi.diffRefs whenever both refs are non-empty.
// The tree-panel UI state (mode, filter, selected file) lives in the store
// per CompareTab, so switching between Compare tabs preserves position.

type Props = {
  repoPath: string;
  tab: CompareTabState;
  worktreeId: string;
};

export function CompareTab(props: Props) {
  const { state, actions } = useAppStore();
  /// The element the drag measures against, held directly.
  ///
  /// It used to be re-found by id on every mousemove — a document-wide lookup
  /// per frame that also depended on an id nothing else enforced, so a
  /// duplicated or renamed id would have made the divider silently stop moving
  /// with no error anywhere.
  let rootRef: HTMLDivElement | undefined;

  // ─── Refs (autocomplete data) ───────────────────────────────────────
  const [refs, { refetch: refetchRefs }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listRefs(p),
  );

  /// Branch metadata for ahead/behind chips in the picker dropdown.
  /// listBranches is a heavier call than listRefs (it computes upstream
  /// counts) — keep it cached at the tab level so swapping ref dropdowns
  /// doesn't refetch.
  ///
  /// Local only, deliberately — but no longer because the number does not
  /// exist. Since CMP-F22 a remote-tracking branch *is* counted, against the
  /// local branch of the same name, so flipping this to `true` would light up
  /// chips on the `origin/…` rows `listRefs` already puts in this dropdown.
  ///
  /// It stays off because this picker's chip is a bare `↑2 ↓0` with nowhere to
  /// say what the other side is. In the branches pane the row carries that
  /// label; here it would read as "ahead of the ref in the other dropdown",
  /// which is the one thing it is not. Turning it on means designing the label
  /// first.
  const [branchInfo, { refetch: refetchBranches }] = createResource(
    () => props.repoPath,
    (p) => gitApi.listBranches(p, false),
  );

  const branchMeta = createMemo<Record<string, { ahead: number; behind: number }>>(() => {
    const out: Record<string, { ahead: number; behind: number }> = {};
    for (const b of branchInfo() ?? []) {
      // A branch with nothing to count against gets no entry rather than a
      // zeroed one: `RefPicker` gates its chip on `> 0`, so a fabricated 0/0
      // would draw the same as a real one — which is the confusion
      // `aheadBehind` being nullable exists to prevent.
      if (b.aheadBehind) out[b.name] = { ahead: b.aheadBehind.ahead, behind: b.aheadBehind.behind };
    }
    return out;
  });

  const mruBranches = createMemo(() => branchMruFor(props.repoPath));

  // ─── Diff resource — refetches on ref / merge-base change ───────────
  const refsKey = createMemo(() =>
    props.tab.baseRef && props.tab.headRef
      ? {
          repoPath: props.repoPath,
          baseRef: props.tab.baseRef,
          headRef: props.tab.headRef,
          useMergeBase: props.tab.useMergeBase,
          // Part of the key, because it is part of the *question*. It used to
          // be applied to the answer afterwards, which left the tree, the
          // counts and the footer describing a different diff from the one on
          // screen.
          //
          // Per tab, not the global `state.ignoreWhitespace` the working-tree
          // toolbar drives — that is the whole point of TODO row 6. Reading
          // the global here would mean the toolbar toggle refetches every
          // open compare tab at once, each re-running a full diff behind the
          // same per-repo git mutex (CMP-F10). Keying on the tab's own field
          // means flipping one tab's control invalidates only this memo, and
          // only this tab's resource refetches.
          ignoreWhitespace: props.tab.ignoreWhitespace ?? false,
        }
      : null,
  );

  const [diff, { refetch }] = createResource(refsKey, async (k) => {
    return gitApi.diffRefs(
      k.repoPath,
      k.baseRef,
      k.headRef,
      k.useMergeBase,
      k.ignoreWhitespace,
    );
  });

  /// A compare tab is keyed on ref *names*, which do not change when the
  /// commits under them do.
  ///
  /// So committing, fetching, resetting, rebasing or amending left the resource
  /// source identical and the tab kept rendering a diff of commits that were no
  /// longer at either ref, with the manual Refresh button as the only way back.
  /// The pickers were stale in the same way: keyed on `repoPath` alone, a branch
  /// created anywhere was absent from both dropdowns until the tab was closed
  /// and reopened, and the ahead/behind chips went stale after any push.
  onMount(() =>
    onCleanup(
      onGitRefsChanged(() => {
        void refetch();
        void refetchRefs();
        void refetchBranches();
      }),
    ),
  );

  // §7.5.3: a compare that is re-diffing is a *running* tab, and the badge has
  // to be readable from the strip of a group the user isn't in. `noteRunning`
  // is the whole wiring — everything else (precedence, escalation, the group
  // header, the status bar) is already downstream of it.
  createEffect(() => noteRunning(props.tab.id, diff.loading));
  onCleanup(() => clearTabActivity(props.tab.id));

  /// True only while the resource is settled on a rejection.
  ///
  /// This guard is load-bearing, and the reason is worth spelling out. A Solid
  /// resource *rethrows* the fetcher's rejection from `diff()` — and from
  /// `diff.latest` — whenever it is read with no fetch in flight. Reading it
  /// bare inside `files` below threw from within a reactive update, and Solid's
  /// update loop discards the whole pending effects queue on the way out while
  /// leaving those effects marked stale. They are never re-queued. So one
  /// unresolvable ref did not merely fail this diff, it killed every
  /// computation downstream of it *for the life of the tab*: the tree kept
  /// rendering the previous file list, Refresh and Retry and the merge-base
  /// toggle all re-ran the fetch and moved nothing on screen, and — because
  /// `noteRunning` reads `diff.loading` rather than `files()` — the tab's
  /// activity dot went on spinning over frozen content.
  ///
  /// `diff.error` and `diff.state` are plain signal reads and never throw, so
  /// short-circuiting on them keeps the error out of the update entirely. That
  /// is what makes the `errMessage()` UI below reachable; it was always written
  /// correctly and was simply never given a chance to render.
  ///
  /// `"errored"` rather than `!!diff.error`: a refetch after a failure keeps
  /// the old error hanging around while it is in flight, and during that window
  /// Solid itself does not throw.
  const failed = () => diff.state === "errored";

  const files = createMemo(() => (failed() ? [] : (diff()?.files ?? [])));

  const selectedFile = createMemo(() => {
    const path = props.tab.selectedFilePath;
    if (!path) return null;
    return (
      files().find((f) => (f.newPath ?? f.oldPath) === path) ?? null
    );
  });

  // Keep a file selected whenever there is one to select.
  //
  // The condition used to be "no selection at all", which could never recover
  // from a selection that pointed at a file the current diff does not contain —
  // and there are four ordinary ways to get one:
  //
  //   * toggling merge-base (`setCompareRefs` clears the selection only when
  //     the *refs* change, and a file can differ two-dot but not three-dot),
  //   * reloading the app, since `deserializeCompare` restores the path
  //     verbatim while the refs may have moved underneath it,
  //   * "Compare with…" from the file tree, which sets a working-tree path that
  //     need not appear in the diff at all,
  //   * a refresh after the file simply stopped differing.
  //
  // In all four the tree filled with files while the pane said "select a file",
  // and clicking one was the only way out. Testing whether the selection
  // *resolves* rather than whether it exists makes the stale case self-heal.
  createEffect(() => {
    const list = files();
    if (list.length === 0) return;
    if (props.tab.selectedFilePath && selectedFile()) return;
    const path = list[0].newPath ?? list[0].oldPath;
    if (path) {
      actions.setCompareSelectedFile(props.worktreeId, props.tab.id, path);
    }
  });

  // ─── Tree-pane resizer ──────────────────────────────────────────────
  const [dragging, setDragging] = createSignal(false);
  /// The in-flight width, local for the length of the drag only.
  ///
  /// The committed value lives on the tab in the store, which is also what
  /// gets persisted — and writing it on every mousemove would put a store
  /// update and a persistence write on every frame of a drag. `null` means
  /// "not dragging", so the rendered width falls back to the stored one.
  const [dragWidth, setDragWidth] = createSignal<number | null>(null);
  const treeWidth = () => dragWidth() ?? props.tab.treeWidth;

  function startDrag(e: MouseEvent) {
    e.preventDefault();
    setDragging(true);
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging() || !rootRef) return;
      const rect = rootRef.getBoundingClientRect();
      setDragWidth(
        Math.min(
          COMPARE_TREE_WIDTH_MAX,
          Math.max(COMPARE_TREE_WIDTH_MIN, e.clientX - rect.left),
        ),
      );
    };
    const onUp = () => {
      if (!dragging()) return;
      setDragging(false);
      const width = dragWidth();
      setDragWidth(null);
      if (width !== null) {
        actions.setCompareTreeWidth(props.worktreeId, props.tab.id, width);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  });

  function swapRefs() {
    actions.setCompareRefs(props.worktreeId, props.tab.id, {
      baseRef: props.tab.headRef,
      headRef: props.tab.baseRef,
    });
  }

  function setBase(value: string) {
    actions.setCompareRefs(props.worktreeId, props.tab.id, { baseRef: value });
  }

  function setHead(value: string) {
    actions.setCompareRefs(props.worktreeId, props.tab.id, { headRef: value });
  }

  function toggleMergeBase() {
    actions.setCompareRefs(props.worktreeId, props.tab.id, {
      useMergeBase: !props.tab.useMergeBase,
    });
  }

  /// Resolved view of the tab's optional fields — `undefined` on the tab means
  /// "at the shipped default", both here and in what gets persisted. See
  /// `CompareTab` in `store/layout/tabs.ts` for why they stay optional.
  const diffMode = () => props.tab.diffMode ?? "inline";
  const ignoreWhitespace = () => props.tab.ignoreWhitespace ?? false;

  function setDiffMode(mode: "inline" | "split") {
    actions.setCompareDiffMode(props.worktreeId, props.tab.id, mode);
  }

  function toggleIgnoreWhitespace() {
    actions.setCompareIgnoreWhitespace(props.worktreeId, props.tab.id, !ignoreWhitespace());
  }

  const errMessage = () => {
    const e = diff.error;
    if (!e) return null;
    return e instanceof Error ? e.message : String(e);
  };

  /// Which picker to paint red, decided by the prefix Rust puts on the message
  /// rather than by looking for the words anywhere in it.
  ///
  /// `\bbase\b` matched on `/`, `-` and `_`, so a typo'd `origin/base-fix` in
  /// the *head* field turned both pickers red — while a repository that would
  /// not open, containing neither word, highlighted neither and read as a ref
  /// typo. `compare.rs` now answers `base:`, `head:` or `repo:` at the front,
  /// and only the side that actually failed lights up.
  const baseInvalid = () => /^base:/i.test(errMessage() ?? "");
  const headInvalid = () => /^head:/i.test(errMessage() ?? "");

  return (
    <div ref={rootRef} class="absolute inset-0 flex flex-col bg-background">
      {/* Toolbar */}
      <div class="flex items-end gap-2 px-3 py-2 border-b border-border shrink-0">
        <div class="flex-1 min-w-0">
          <RefPicker
            label="Base"
            value={props.tab.baseRef}
            refs={refs() ?? null}
            loading={refs.loading}
            onChange={setBase}
            invalid={baseInvalid()}
            error={baseInvalid() ? errMessage() : null}
            mruBranches={mruBranches()}
            branchMeta={branchMeta()}
          />
        </div>
        <button
          type="button"
          onClick={swapRefs}
          class="mb-0.5 p-1.5 rounded-md border border-border hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Swap base and head"
          title="Swap base and head"
        >
          <ArrowLeftRight class="w-3.5 h-3.5" />
        </button>
        <div class="flex-1 min-w-0">
          <RefPicker
            label="Head"
            value={props.tab.headRef}
            refs={refs() ?? null}
            loading={refs.loading}
            onChange={setHead}
            invalid={headInvalid()}
            error={headInvalid() ? errMessage() : null}
            mruBranches={mruBranches()}
            branchMeta={branchMeta()}
          />
        </div>
        <button
          type="button"
          onClick={toggleMergeBase}
          aria-pressed={props.tab.useMergeBase}
          class={`mb-0.5 flex items-center gap-1 px-2 py-1 text-label rounded-md border transition-colors ${
            props.tab.useMergeBase
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title={
            props.tab.useMergeBase
              ? "Showing changes since branch divergence (three-dot)"
              : "Showing direct diff (two-dot)"
          }
        >
          <GitMerge class="w-3 h-3" />
          Merge-base
        </button>
        <button
          type="button"
          onClick={toggleIgnoreWhitespace}
          aria-label="Toggle ignore whitespace"
          aria-pressed={ignoreWhitespace()}
          class={`mb-0.5 flex items-center gap-1 px-2 py-1 text-label rounded-md border transition-colors ${
            ignoreWhitespace()
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title="Ignore whitespace-only changes"
        >
          <Space class="w-3 h-3" />
          Ignore WS
        </button>
        <div
          role="group"
          aria-label="Diff view mode"
          class="mb-0.5 flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <button
            type="button"
            onClick={() => setDiffMode("inline")}
            aria-label="Inline (unified) view"
            aria-pressed={diffMode() === "inline"}
            class={`flex items-center gap-1 px-2 py-0.5 text-label rounded transition-colors ${
              diffMode() === "inline"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Inline (unified)"
          >
            <Rows3 class="w-3 h-3" />
            Inline
          </button>
          <button
            type="button"
            onClick={() => setDiffMode("split")}
            aria-label="Split (side by side) view"
            aria-pressed={diffMode() === "split"}
            class={`flex items-center gap-1 px-2 py-0.5 text-label rounded transition-colors ${
              diffMode() === "split"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Side by side"
          >
            <Columns2 class="w-3 h-3" />
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          class="mb-0.5 p-1.5 rounded-md border border-border hover:bg-accent/40 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Refresh diff"
          title="Refresh diff"
          disabled={diff.loading}
        >
          <RotateCw
            class={`w-3.5 h-3.5 ${diff.loading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {/* Body */}
      <div class="flex-1 flex min-h-0 overflow-hidden">
        <Show
          when={props.tab.baseRef && props.tab.headRef}
          fallback={
            <div class="flex-1 flex flex-col items-center justify-center text-muted-foreground text-body gap-2 text-center px-6">
              <p>Pick two refs to compare.</p>
              <p class="text-muted-foreground/60 text-label">
                Branches, tags, commit SHAs, and revision expressions like{" "}
                <span class="font-mono">HEAD~3</span> are all accepted.
              </p>
            </div>
          }
        >
          {/* Tree pane */}
          <div
            class="shrink-0 border-r border-border min-h-0 overflow-hidden"
            style={{ width: `${treeWidth()}px` }}
          >
            <Show
              // `failed()` first, and the short-circuit is the point: reaching
              // `diff.latest` on an errored resource rethrows exactly like
              // `diff()` does, which would put the throw back into the update
              // this guard exists to keep it out of.
              when={failed() || !diff.loading || diff.latest}
              fallback={
                <div class="h-full flex items-center justify-center text-muted-foreground text-label">
                  Computing diff…
                </div>
              }
            >
              <Show
                when={!errMessage()}
                fallback={
                  <div class="h-full flex flex-col items-center justify-center px-3 text-center gap-2">
                    <p class="text-destructive text-body">{errMessage()}</p>
                    <button
                      onClick={() => refetch()}
                      class="text-label px-2 py-0.5 rounded border border-border hover:bg-accent/40"
                    >
                      Retry
                    </button>
                  </div>
                }
              >
                <ChangedFileTree
                  files={files()}
                  selectedPath={props.tab.selectedFilePath}
                  onSelect={(p) =>
                    actions.setCompareSelectedFile(props.worktreeId, props.tab.id, p)
                  }
                  mode={props.tab.treeMode}
                  filter={props.tab.treeFilter}
                  onModeChange={(m) =>
                    actions.setCompareTreeMode(props.worktreeId, props.tab.id, m)
                  }
                  onFilterChange={(f) =>
                    actions.setCompareTreeFilter(props.worktreeId, props.tab.id, f)
                  }
                />
              </Show>
            </Show>
          </div>

          {/* Resizer */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startDrag}
            class={`w-1 shrink-0 cursor-col-resize transition-colors ${
              dragging() ? "bg-primary/60" : "bg-transparent hover:bg-primary/40"
            }`}
          />

          {/* Diff pane */}
          <div class="flex-1 min-w-0">
            <CompareDiffPane
              file={selectedFile()}
              baseRef={props.tab.baseRef}
              headRef={props.tab.headRef}
              diffMode={diffMode()}
              lineNumbers={state.diffLineNumbers}
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
