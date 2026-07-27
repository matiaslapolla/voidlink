/// A working-tree diff, rendered as a Monaco side-by-side editor.
///
/// The workbench's git sidebar and compare tabs keep using
/// `components/git/shared/SplitDiffRenderer.tsx`: it renders straight from git
/// hunks, which is what you want for per-hunk staging in a 300px column. In the
/// editor window a diff gets the whole surface and sits next to real editors, so
/// it uses the same engine they do — matching gutters, matching scrolling,
/// matching syntax highlighting, and inline/side-by-side for free.
///
/// Monaco wants two whole documents, so the HEAD side is reconstructed from the
/// hunks (see `diffModel.ts`) rather than fetched — there is no "read file at
/// ref" command, and the reconstruction is exact.

import { Show, createMemo, createResource, createSignal } from "solid-js";
import { Columns2, GitCompare, RotateCw, Rows3, Space, Trash2, Plus } from "lucide-solid";
import { confirm as dialogConfirm } from "@tauri-apps/plugin-dialog";
import { fsApi } from "@/api/fs";
import { gitApi } from "@/api/git";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { pushToast } from "@/commands/toast";
import { useAppStore } from "@/store/LayoutContext";
import { applyIgnoreWhitespace } from "@/components/git/shared/SplitDiffRenderer";
import { workingTreeSides } from "./diffModel";
import { MonacoDiffPane } from "./MonacoPanes";
import type { FileDiff } from "@/types/git";

interface DiffTabViewProps {
  repoPath: string;
  filePath: string;
}

export function DiffTabView(props: DiffTabViewProps) {
  const { state, actions } = useAppStore();
  const [busy, setBusy] = createSignal(false);

  /// Refetched together: the diff decides which lines changed, the working file
  /// supplies the text those line numbers point into. Reading them separately
  /// would let one refresh land against the other's file version.
  const [data, { refetch }] = createResource(
    () => ({ repo: props.repoPath, file: props.filePath }),
    async ({ repo, file }) => {
      const [diff, working] = await Promise.all([
        gitApi.diffWorking(repo),
        fsApi.readFile(file).catch(() => ""),
      ]);
      const fileDiff =
        diff.files.find((f) => (f.newPath ?? f.oldPath) === file) ?? null;
      return { fileDiff, working };
    },
  );

  const fileDiff = createMemo<FileDiff | null>(() => {
    const raw = data()?.fileDiff ?? null;
    if (!raw || !state.ignoreWhitespace) return raw;
    return applyIgnoreWhitespace(raw);
  });

  const sides = createMemo(() => {
    const d = data();
    if (!d) return null;
    return workingTreeSides(d.working, fileDiff());
  });

  /// Path as git names it — relative to the repo root. The staging commands
  /// take repo-relative paths; the tab carries an absolute one.
  const relPath = () =>
    props.filePath.startsWith(`${props.repoPath}/`)
      ? props.filePath.slice(props.repoPath.length + 1)
      : props.filePath;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      refetch();
      emitGitRefsChanged();
    } catch (e) {
      pushToast(`${label}: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    const ok = await dialogConfirm(
      `Discard changes to ${relPath()}? The file is reverted in the working tree and this cannot be undone.`,
      { title: "Discard changes", kind: "warning" },
    );
    if (!ok) return;
    await run("Could not discard", async () => {
      await gitApi.discardFile(props.repoPath, relPath());
      pushToast(`Discarded changes to ${relPath()}`, "info", 2500);
    });
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
        <GitCompare class="w-3.5 h-3.5 text-info shrink-0" />
        <div class="flex-1 min-w-0 text-xs truncate">
          <span class="font-medium">{relPath()}</span>
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
          onClick={() =>
            void run("Could not stage", async () => {
              await gitApi.stageFiles(props.repoPath, [relPath()]);
              pushToast(`Staged ${relPath()}`, "success", 1800);
            })
          }
          disabled={busy()}
          class="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 disabled:opacity-40 transition-colors"
          title="Stage the whole file"
        >
          <Plus class="w-3 h-3" />
          Stage
        </button>
        <button
          onClick={() => void discard()}
          disabled={busy()}
          class="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border border-border text-muted-foreground hover:text-destructive hover:border-destructive/50 disabled:opacity-40 transition-colors"
          title="Discard working-tree changes to this file"
        >
          <Trash2 class="w-3 h-3" />
          Discard
        </button>

        <button
          onClick={() => refetch()}
          aria-label="Refresh diff"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          title="Refresh diff"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => actions.toggleIgnoreWhitespace()}
          aria-label="Toggle ignore whitespace"
          aria-pressed={state.ignoreWhitespace}
          class={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border transition-colors ${
            state.ignoreWhitespace
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
      </div>

      <div class="flex-1 min-h-0">
        <Show
          when={sides()}
          fallback={
            <div class="h-full flex items-center justify-center text-muted-foreground text-xs">
              <Show when={data.loading} fallback="Could not read this file.">
                Loading diff…
              </Show>
            </div>
          }
        >
          {(s) => (
            <Show
              when={!s().unavailable}
              fallback={
                <div class="h-full flex items-center justify-center text-muted-foreground text-xs">
                  {s().unavailable}
                </div>
              }
            >
              <MonacoDiffPane
                original={s().original}
                modified={s().modified}
                path={props.filePath}
                sideBySide={state.diffMode === "split"}
                ignoreWhitespace={state.ignoreWhitespace}
              />
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
