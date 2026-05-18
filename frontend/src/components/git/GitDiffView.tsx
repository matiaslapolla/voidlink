import { Show, createMemo, createResource } from "solid-js";
import { X, Rows3, Columns2, Space } from "lucide-solid";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import type { FileDiff } from "@/types/git";
import {
  DiffRenderer,
  applyIgnoreWhitespace,
} from "@/components/git/shared/SplitDiffRenderer";
import { pushToast } from "@/commands/toast";

interface GitDiffViewProps {
  repoPath: string;
  filePath: string;
  onClose: () => void;
}

export function GitDiffView(props: GitDiffViewProps) {
  const { state, actions } = useAppStore();

  const [diff, { refetch }] = createResource(
    () => props.repoPath,
    (p) => gitApi.diffWorking(p),
  );

  // Pre-whitespace-filter copy used by the hunk-staging callback. Applying a
  // patch against the index uses real line numbers, so we always send libgit2
  // the unfiltered hunk regardless of the user's view setting.
  const rawFileDiff = createMemo<FileDiff | null>(() => {
    const d = diff();
    if (!d) return null;
    return d.files.find((f) => (f.newPath ?? f.oldPath) === props.filePath) ?? null;
  });

  const fileDiff = createMemo<FileDiff | null>(() => {
    const file = rawFileDiff();
    if (!file || !state.ignoreWhitespace) return file;
    return applyIgnoreWhitespace(file);
  });

  async function stageHunk(filteredIndex: number) {
    const raw = rawFileDiff();
    const filtered = fileDiff();
    if (!raw || !filtered) return;
    // The renderer iterates `filtered.hunks`, so the index it gives us is
    // positional in the *filtered* list. When Ignore-WS strips hunks, that
    // index no longer matches the raw list we need to send to libgit2.
    // Map back by old_start + new_start, which uniquely identify a hunk
    // within a single file.
    const filteredHunk = filtered.hunks[filteredIndex];
    if (!filteredHunk) return;
    const rawIndex = raw.hunks.findIndex(
      (h) =>
        h.oldStart === filteredHunk.oldStart && h.newStart === filteredHunk.newStart,
    );
    if (rawIndex === -1) {
      pushToast(
        "Could not locate hunk in unfiltered diff. Disable Ignore WS and retry.",
        "error",
      );
      return;
    }
    try {
      await gitApi.applyHunk(props.repoPath, raw, rawIndex, false);
      pushToast("Staged hunk", "success", 1800);
      refetch();
      window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
    } catch (e) {
      pushToast(
        `Could not stage hunk: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    }
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      {/* Header */}
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <div class="flex-1 min-w-0 text-xs truncate">
          <span class="font-medium">{props.filePath}</span>
          <Show when={fileDiff()}>
            {(f) => (
              <span class="ml-2 text-muted-foreground tabular-nums">
                <span class="text-success">+{f().additions}</span>{" "}
                <span class="text-destructive">-{f().deletions}</span>
              </span>
            )}
          </Show>
        </div>
        <button
          onClick={() => refetch()}
          aria-label="Refresh diff"
          class="text-[11px] px-2 py-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="Refresh diff"
        >
          Refresh
        </button>
        <button
          onClick={() => actions.toggleIgnoreWhitespace()}
          aria-label="Toggle ignore whitespace"
          class={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border transition-colors ${
            state.ignoreWhitespace
              ? "bg-primary/15 border-primary/40 text-primary"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          }`}
          title="Ignore whitespace-only changes"
          aria-pressed={state.ignoreWhitespace}
        >
          <Space class="w-3 h-3" />
          Ignore WS
        </button>
        <div
          role="group"
          aria-label="Diff view mode"
          class="flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          <button
            onClick={() => actions.setDiffMode("inline")}
            aria-label="Inline (unified) view"
            aria-pressed={state.diffMode === "inline"}
            class={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition-colors ${
              state.diffMode === "inline"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            title="Inline (unified)"
          >
            <Rows3 class="w-3 h-3" />
            Inline
          </button>
          <button
            onClick={() => actions.setDiffMode("split")}
            aria-label="Split (side by side) view"
            aria-pressed={state.diffMode === "split"}
            class={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition-colors ${
              state.diffMode === "split"
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
          onClick={props.onClose}
          aria-label="Close diff"
          class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
          title="Close diff"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-auto scrollbar-thin font-mono text-[12px] leading-[1.5]">
        <Show
          when={fileDiff()}
          fallback={
            <div class="h-full flex items-center justify-center text-muted-foreground text-xs">
              <Show when={diff.loading} fallback="No diff for this file.">
                Loading diff…
              </Show>
            </div>
          }
        >
          {(f) => (
            <DiffRenderer
              file={f()}
              mode={state.diffMode}
              hunkActions={{
                onStageHunk: (idx) => void stageHunk(idx),
                stageLabel: "Stage hunk",
              }}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
