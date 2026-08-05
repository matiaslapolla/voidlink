/// Every change in the worktree, in one scroll.
///
/// Staged, unstaged and untracked, sectioned, one collapsible row per file —
/// the reading pass the app had no surface for. Reviewing your own branch meant
/// opening one diff tab per file and holding the shape of the change in your
/// head across them.
///
/// Two things make this survive a worktree with hundreds of changed files:
///
///   1. **Files are collapsed by default.** A collapsed file is exactly one
///      row, so nothing builds hunks until you open something. `combinedRows`
///      in `combinedDiff.ts` is where that is enforced, and it is tested
///      without a DOM.
///   2. **The row list is windowed** with `@tanstack/solid-virtual`, the same
///      way `FileTree` and the commit graph are. Rows are measured rather than
///      estimated, because an expanded file's height is its diff's height and
///      no estimate can stand in for that.
///
/// The assembly itself — which section a file is filed under, and what happens
/// to a path that is staged *and* modified — is `combinedDiff.ts`. Nothing
/// here decides it.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  GitCompare,
  Minus,
  Plus,
  RotateCw,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { emitGitRefsChanged, onGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { useAppStore } from "@/store/LayoutContext";
import { DiffRenderer } from "./SplitDiffRenderer";
import { StatusBadge } from "./StatusBadge";
import {
  assembleCombinedDiff,
  combinedRows,
  untrackedExplanation,
  SECTION_LABELS,
  type CombinedEntry,
  type CombinedRow,
  type CombinedSection,
} from "./combinedDiff";

export function CombinedDiffView(props: { repoPath: string }) {
  const { state, actions } = useAppStore();
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [busy, setBusy] = createSignal(false);

  /// Both diffs in one request pair, so the two halves of the model always
  /// describe the same instant. Fetching them from two independent resources
  /// would let a refresh land between them and produce a file that is in
  /// neither section or in both.
  const [data, { refetch }] = createResource(
    () => ({ repo: props.repoPath, ignoreWhitespace: state.ignoreWhitespace }),
    async ({ repo, ignoreWhitespace }) => {
      const [staged, unstaged] = await Promise.all([
        gitApi.diffWorking(repo, true, ignoreWhitespace),
        gitApi.diffWorking(repo, false, ignoreWhitespace),
      ]);
      return { staged: staged.files, unstaged: unstaged.files };
    },
  );

  onMount(() => onCleanup(onGitRefsChanged(() => void refetch())));

  const model = createMemo(() =>
    assembleCombinedDiff({ staged: data()?.staged ?? [], unstaged: data()?.unstaged ?? [] }),
  );

  const rows = createMemo(() => combinedRows(model(), (p) => expanded().has(p)));

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function setAll(open: boolean) {
    setExpanded(open ? new Set(model().entries.map((e) => e.path)) : new Set<string>());
  }

  let scrollEl: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl ?? null,
    // A collapsed file row. Expanded rows are measured, so this only has to be
    // right for the common case — and the common case is what decides whether
    // the initial scrollbar is honest.
    estimateSize: () => 28,
    overscan: 6,
    getItemKey: (i) => rows()[i]?.key ?? i,
  });

  // Expanding a file changes the height of a row that is already measured, and
  // the virtualizer caches measurements by key. Re-measuring on every change to
  // the row list is what keeps the scroll offset from drifting as sections open.
  createEffect(() => {
    void rows();
    virtualizer.measure();
  });

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      void refetch();
      emitGitRefsChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("[stale-diff]")) {
        pushToast("The worktree moved since this was drawn — refreshed. Try again.", "warning", 5000);
        void refetch();
      } else {
        pushToast(`${label}: ${msg}`, "error", 6000);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 text-body">
        <GitCompare class="w-3.5 h-3.5 text-info shrink-0" />
        <span class="font-medium">All changes</span>
        <span class="text-muted-foreground tabular-nums">
          {model().entries.length} file{model().entries.length === 1 ? "" : "s"}{" "}
          <span class="text-success">+{model().totalAdditions}</span>{" "}
          <span class="text-destructive">−{model().totalDeletions}</span>
        </span>
        {/* The most surprising thing a working tree can be, and nothing else in
            the app says it. */}
        <Show when={model().partiallyStagedCount > 0}>
          <span
            class="px-1.5 py-0.5 rounded bg-warning/15 text-warning text-micro"
            title="These files have both staged and unstaged changes — committing now takes only part of what you see"
          >
            {model().partiallyStagedCount} partly staged
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <button
            onClick={() => setAll(true)}
            class="px-2 py-0.5 text-label rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title="Expand every file — slow on a large change, which is why it is not the default"
          >
            Expand all
          </button>
          <button
            onClick={() => setAll(false)}
            class="px-2 py-0.5 text-label rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            Collapse all
          </button>
          <button
            onClick={() => void refetch()}
            aria-label="Refresh"
            title="Refresh"
            class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <RotateCw class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div ref={scrollEl} class="flex-1 min-h-0 overflow-auto scrollbar-thin">
        <Show
          when={rows().length > 0}
          fallback={
            <div class="h-full flex items-center justify-center text-muted-foreground text-body">
              <Show when={data.loading} fallback="Nothing has changed in this worktree.">
                Loading changes…
              </Show>
            </div>
          }
        >
          <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <For each={virtualizer.getVirtualItems()}>
              {(item) => {
                const row = () => rows()[item.index];
                return (
                  <div
                    ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                    data-index={item.index}
                    class="absolute left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <Row
                      row={row()}
                      repoPath={props.repoPath}
                      diffMode={state.diffMode}
                      lineNumbers={state.diffLineNumbers}
                      busy={busy()}
                      onToggle={toggle}
                      onRun={run}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
      {/* Read-only surface for whitespace, matching the diff tab's toggle so
          the two never disagree about what "changed" means. */}
      <div class="flex items-center gap-2 px-3 py-1 border-t border-border shrink-0 text-micro text-muted-foreground">
        <button
          onClick={() => actions.toggleIgnoreWhitespace()}
          aria-pressed={state.ignoreWhitespace}
          class={`px-1.5 py-0.5 rounded transition-colors ${
            state.ignoreWhitespace ? "bg-primary/15 text-primary" : "hover:bg-accent/40"
          }`}
        >
          Ignore whitespace
        </button>
        <span>Click a file to open its diff in place. Staged and unstaged halves are listed separately.</span>
      </div>
    </div>
  );
}

function Row(props: {
  row: CombinedRow | undefined;
  repoPath: string;
  diffMode: "inline" | "split";
  lineNumbers: boolean;
  busy: boolean;
  onToggle: (path: string) => void;
  onRun: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  return (
    <Show when={props.row}>
      {(row) => (
        <>
          <Show when={row().kind === "section"}>
            <SectionHeader row={row() as Extract<CombinedRow, { kind: "section" }>} />
          </Show>
          <Show when={row().kind === "file"}>
            <FileRow
              row={row() as Extract<CombinedRow, { kind: "file" }>}
              repoPath={props.repoPath}
              busy={props.busy}
              onToggle={props.onToggle}
              onRun={props.onRun}
            />
          </Show>
          <Show when={row().kind === "body"}>
            <BodyRow
              row={row() as Extract<CombinedRow, { kind: "body" }>}
              repoPath={props.repoPath}
              diffMode={props.diffMode}
              lineNumbers={props.lineNumbers}
            />
          </Show>
        </>
      )}
    </Show>
  );
}

function SectionHeader(props: { row: Extract<CombinedRow, { kind: "section" }> }) {
  const tone = (): string => {
    switch (props.row.section) {
      case "staged":
        return "text-success";
      case "unstaged":
        return "text-warning";
      default:
        return "text-info";
    }
  };
  return (
    <div class="sticky top-0 z-10 flex items-center gap-2 px-3 py-1 bg-background border-y border-border">
      <span class={`text-micro tracking-wide ${tone()}`}>
        {SECTION_LABELS[props.row.section]}
      </span>
      <span class="text-micro text-muted-foreground tabular-nums">{props.row.count}</span>
    </div>
  );
}

function FileRow(props: {
  row: Extract<CombinedRow, { kind: "file" }>;
  repoPath: string;
  busy: boolean;
  onToggle: (path: string) => void;
  onRun: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const entry = () => props.row.entry;
  /// Untracked and unstaged both stage; staged unstages. A file in both states
  /// gets both, because "stage the rest" and "unstage what is staged" are the
  /// two things you actually want on a partially-staged file.
  const canStage = () => entry().states.some((s) => s.section !== "staged");
  const canUnstage = () => entry().states.some((s) => s.section === "staged");

  return (
    <div class="flex items-center gap-2 px-3 py-0.5 hover:bg-accent/30 group">
      <button
        onClick={() => props.onToggle(entry().path)}
        aria-expanded={props.row.expanded}
        aria-label={`${props.row.expanded ? "Collapse" : "Expand"} ${entry().path}`}
        class="flex items-center gap-1 flex-1 min-w-0 text-left text-body"
      >
        <Show when={props.row.expanded} fallback={<ChevronRight class="w-3 h-3 shrink-0 opacity-60" />}>
          <ChevronDown class="w-3 h-3 shrink-0 opacity-60" />
        </Show>
        <StatusBadge status={entry().states[0].file.status} />
        <span class="truncate">{entry().path}</span>
        <Show when={entry().renamedFrom}>
          {(from) => (
            <span class="text-micro text-muted-foreground/80 truncate">from {from()}</span>
          )}
        </Show>
        {/* A file in two sections is the case the whole model exists for. The
            row says which halves it has, so "why does committing take less
            than I see" has an answer on screen. */}
        <Show when={entry().states.length > 1}>
          <span class="px-1 rounded bg-warning/15 text-warning text-micro shrink-0">
            staged + unstaged
          </span>
        </Show>
      </button>
      <span class="text-micro tabular-nums shrink-0">
        <span class="text-success">+{entry().additions}</span>{" "}
        <span class="text-destructive">−{entry().deletions}</span>
      </span>
      <div class="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <Show when={canStage()}>
          <button
            disabled={props.busy}
            onClick={() =>
              void props.onRun("Could not stage", async () => {
                await gitApi.stageFiles(props.repoPath, [entry().path]);
              })
            }
            aria-label={`Stage ${entry().path}`}
            title="Stage this whole file"
            class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-40"
          >
            <Plus class="w-3 h-3" />
          </button>
        </Show>
        <Show when={canUnstage()}>
          <button
            disabled={props.busy}
            onClick={() =>
              void props.onRun("Could not unstage", async () => {
                await gitApi.unstageFiles(props.repoPath, [entry().path]);
              })
            }
            aria-label={`Unstage ${entry().path}`}
            title="Unstage this whole file"
            class="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60 disabled:opacity-40"
          >
            <Minus class="w-3 h-3" />
          </button>
        </Show>
      </div>
    </div>
  );
}

function BodyRow(props: {
  row: Extract<CombinedRow, { kind: "body" }>;
  repoPath: string;
  diffMode: "inline" | "split";
  lineNumbers: boolean;
}) {
  const state = () => props.row.state;
  return (
    <div class="border-l-2 border-border/60 ml-3 mb-1">
      {/* Which of the file's halves this is. On a partially-staged file two of
          these sit under one header and are otherwise indistinguishable. */}
      <Show when={props.row.entry.states.length > 1}>
        <div class="px-3 py-0.5 text-micro text-muted-foreground bg-muted/30">
          {SECTION_LABELS[state().section]} half of this file
        </div>
      </Show>
      <Show when={state().section === "untracked"}>
        <div class="px-3 py-1 text-label text-muted-foreground bg-info/5 border-b border-border/50 flex items-start gap-1.5">
          <FilePlus2 class="w-3 h-3 mt-0.5 shrink-0 text-info" />
          <span>{untrackedExplanation(state().file)}</span>
        </div>
      </Show>
      <div class="font-mono text-body leading-[1.5] overflow-x-auto scrollbar-thin">
        <DiffRenderer
          file={state().file}
          mode={props.diffMode}
          lineNumbers={props.lineNumbers}
          repoPath={props.repoPath}
        />
      </div>
    </div>
  );
}

/// Re-exported so the tab wrapper does not have to know the section type.
export type { CombinedEntry, CombinedSection };
