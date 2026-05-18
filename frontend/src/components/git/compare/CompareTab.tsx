import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { ArrowLeftRight, GitMerge, RotateCw } from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import type { CompareTab as CompareTabState } from "@/store/layout";
import { ChangedFileTree } from "./ChangedFileTree";
import { CompareDiffPane } from "./CompareDiffPane";
import { RefPicker } from "./RefPicker";
import { branchMruFor } from "@/commands/branchMru";

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
  workspaceId: string;
};

const TREE_WIDTH_KEY = "voidlink-compare-tree-width";
const DEFAULT_TREE_WIDTH = 320;
const MIN_TREE_WIDTH = 220;
const MAX_TREE_WIDTH = 600;

function loadTreeWidth(): number {
  const raw = localStorage.getItem(TREE_WIDTH_KEY);
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_TREE_WIDTH;
  return Math.min(MAX_TREE_WIDTH, Math.max(MIN_TREE_WIDTH, n));
}

export function CompareTab(props: Props) {
  const { actions } = useAppStore();
  const [treeWidth, setTreeWidth] = createSignal(loadTreeWidth());

  // ─── Refs (autocomplete data) ───────────────────────────────────────
  const [refs] = createResource(() => props.repoPath, (p) => gitApi.listRefs(p));

  /// Branch metadata for ahead/behind chips in the picker dropdown.
  /// listBranches is a heavier call than listRefs (it computes upstream
  /// counts) — keep it cached at the tab level so swapping ref dropdowns
  /// doesn't refetch.
  const [branchInfo] = createResource(
    () => props.repoPath,
    (p) => gitApi.listBranches(p, false),
  );

  const branchMeta = createMemo<Record<string, { ahead: number; behind: number }>>(() => {
    const out: Record<string, { ahead: number; behind: number }> = {};
    for (const b of branchInfo() ?? []) {
      out[b.name] = { ahead: b.ahead, behind: b.behind };
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
        }
      : null,
  );

  const [diff, { refetch }] = createResource(refsKey, async (k) => {
    return gitApi.diffRefs(k.repoPath, k.baseRef, k.headRef, k.useMergeBase);
  });

  const files = createMemo(() => diff()?.files ?? []);

  const selectedFile = createMemo(() => {
    const path = props.tab.selectedFilePath;
    if (!path) return null;
    return (
      files().find((f) => (f.newPath ?? f.oldPath) === path) ?? null
    );
  });

  // After a fresh load with no current selection, pick the first file so
  // the diff pane shows something instead of the placeholder.
  createEffect(() => {
    const list = files();
    if (props.tab.selectedFilePath || list.length === 0) return;
    const path = list[0].newPath ?? list[0].oldPath;
    if (path) {
      actions.setCompareSelectedFile(props.workspaceId, props.tab.id, path);
    }
  });

  // ─── Tree-pane resizer ──────────────────────────────────────────────
  const [dragging, setDragging] = createSignal(false);

  function startDrag(e: MouseEvent) {
    e.preventDefault();
    setDragging(true);
  }

  onMount(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging()) return;
      const target = document.getElementById(`compare-tab-${props.tab.id}`);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const next = Math.min(
        MAX_TREE_WIDTH,
        Math.max(MIN_TREE_WIDTH, e.clientX - rect.left),
      );
      setTreeWidth(next);
    };
    const onUp = () => {
      if (!dragging()) return;
      setDragging(false);
      localStorage.setItem(TREE_WIDTH_KEY, String(treeWidth()));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  });

  function swapRefs() {
    actions.setCompareRefs(props.workspaceId, props.tab.id, {
      baseRef: props.tab.headRef,
      headRef: props.tab.baseRef,
    });
  }

  function setBase(value: string) {
    actions.setCompareRefs(props.workspaceId, props.tab.id, { baseRef: value });
  }

  function setHead(value: string) {
    actions.setCompareRefs(props.workspaceId, props.tab.id, { headRef: value });
  }

  function toggleMergeBase() {
    actions.setCompareRefs(props.workspaceId, props.tab.id, {
      useMergeBase: !props.tab.useMergeBase,
    });
  }

  const errMessage = () => {
    const e = diff.error;
    if (!e) return null;
    return e instanceof Error ? e.message : String(e);
  };

  const baseInvalid = () => {
    const m = errMessage();
    return !!m && /\bbase\b/i.test(m);
  };
  const headInvalid = () => {
    const m = errMessage();
    return !!m && /\bhead\b/i.test(m);
  };

  return (
    <div
      id={`compare-tab-${props.tab.id}`}
      class="absolute inset-0 flex flex-col bg-background"
    >
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
          class={`mb-0.5 flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors ${
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
            <div class="flex-1 flex flex-col items-center justify-center text-muted-foreground text-[12px] gap-2 text-center px-6">
              <p>Pick two refs to compare.</p>
              <p class="text-muted-foreground/60 text-[11px]">
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
              when={!diff.loading || diff.latest}
              fallback={
                <div class="h-full flex items-center justify-center text-muted-foreground text-[11px]">
                  Computing diff…
                </div>
              }
            >
              <Show
                when={!errMessage()}
                fallback={
                  <div class="h-full flex flex-col items-center justify-center px-3 text-center gap-2">
                    <p class="text-destructive text-[12px]">{errMessage()}</p>
                    <button
                      onClick={() => refetch()}
                      class="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent/40"
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
                    actions.setCompareSelectedFile(props.workspaceId, props.tab.id, p)
                  }
                  mode={props.tab.treeMode}
                  filter={props.tab.treeFilter}
                  onModeChange={(m) =>
                    actions.setCompareTreeMode(props.workspaceId, props.tab.id, m)
                  }
                  onFilterChange={(f) =>
                    actions.setCompareTreeFilter(props.workspaceId, props.tab.id, f)
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
            />
          </div>
        </Show>
      </div>
    </div>
  );
}
