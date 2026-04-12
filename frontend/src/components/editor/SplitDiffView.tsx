import { createSignal, createEffect, on, Show, For } from "solid-js";
import { gitApi } from "@/api/git";
import type { FileDiff, DiffHunk, DiffLine } from "@/types/git";

interface SplitDiffViewProps {
  filePath: string;
  repoPath: string;
}

function lineClass(origin: string): string {
  if (origin === "+") return "bg-success/15 text-success";
  if (origin === "-") return "bg-destructive/15 text-destructive";
  return "text-muted-foreground";
}

function gutterClass(origin: string): string {
  if (origin === "+") return "bg-success/20 text-success/70";
  if (origin === "-") return "bg-destructive/20 text-destructive/70";
  return "text-muted-foreground/40";
}

function SplitHunk(props: { hunk: DiffHunk }) {
  // Build paired lines: old (left) and new (right)
  const pairs = () => {
    const result: { left: DiffLine | null; right: DiffLine | null }[] = [];
    const oldLines: DiffLine[] = [];
    const newLines: DiffLine[] = [];

    for (const line of props.hunk.lines) {
      if (line.origin === "-") {
        oldLines.push(line);
      } else if (line.origin === "+") {
        newLines.push(line);
      } else {
        // Context line: flush pending changes first
        while (oldLines.length > 0 || newLines.length > 0) {
          result.push({
            left: oldLines.shift() ?? null,
            right: newLines.shift() ?? null,
          });
        }
        result.push({ left: line, right: line });
      }
    }
    // Flush remaining
    while (oldLines.length > 0 || newLines.length > 0) {
      result.push({
        left: oldLines.shift() ?? null,
        right: newLines.shift() ?? null,
      });
    }
    return result;
  };

  return (
    <>
      <div class="flex border-b border-border/30 bg-accent/10 px-2 py-0.5">
        <span class="text-[10px] text-muted-foreground font-mono">{props.hunk.header}</span>
      </div>
      <For each={pairs()}>
        {(pair) => (
          <div class="flex font-mono text-[11px] leading-[1.6] border-b border-border/10">
            {/* Left side (old) */}
            <div class="flex-1 flex min-w-0 border-r border-border/20">
              <Show
                when={pair.left}
                fallback={<div class="flex-1 bg-accent/5" />}
              >
                {(line) => (
                  <>
                    <span class={`w-10 shrink-0 text-right pr-2 select-none text-[10px] ${gutterClass(line().origin)}`}>
                      {line().oldLineno ?? ""}
                    </span>
                    <span class={`flex-1 whitespace-pre overflow-hidden ${lineClass(line().origin)}`}>
                      {line().origin !== " " ? line().origin : " "}{line().content}
                    </span>
                  </>
                )}
              </Show>
            </div>
            {/* Right side (new) */}
            <div class="flex-1 flex min-w-0">
              <Show
                when={pair.right}
                fallback={<div class="flex-1 bg-accent/5" />}
              >
                {(line) => (
                  <>
                    <span class={`w-10 shrink-0 text-right pr-2 select-none text-[10px] ${gutterClass(line().origin)}`}>
                      {line().newLineno ?? ""}
                    </span>
                    <span class={`flex-1 whitespace-pre overflow-hidden ${lineClass(line().origin)}`}>
                      {line().origin !== " " ? line().origin : " "}{line().content}
                    </span>
                  </>
                )}
              </Show>
            </div>
          </div>
        )}
      </For>
    </>
  );
}

export function SplitDiffView(props: SplitDiffViewProps) {
  const [fileDiff, setFileDiff] = createSignal<FileDiff | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    on(
      () => [props.repoPath, props.filePath] as const,
      async ([repoPath, filePath]) => {
        if (!repoPath || !filePath) return;
        setLoading(true);
        setError(null);
        try {
          const result = await gitApi.diffWorking(repoPath);
          // Find the diff for the specific file
          const rel = filePath.startsWith(repoPath)
            ? filePath.slice(repoPath.length + 1)
            : filePath;
          const match = result.files.find(
            (f) => f.newPath === rel || f.oldPath === rel,
          );
          if (match) {
            setFileDiff(match);
          } else {
            setError("No changes detected for this file.");
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      },
    ),
  );

  const fileName = () => props.filePath.split("/").pop() ?? props.filePath;

  return (
    <div class="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div class="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3">
        <span class="text-xs font-medium">{fileName()}</span>
        <Show when={fileDiff()}>
          {(diff) => (
            <span class="text-[10px] text-muted-foreground">
              <span class="text-success">+{diff().additions}</span>
              {" / "}
              <span class="text-destructive">-{diff().deletions}</span>
            </span>
          )}
        </Show>
      </div>

      {/* Column headers */}
      <Show when={fileDiff()}>
        <div class="shrink-0 border-b border-border flex text-[10px] text-muted-foreground">
          <div class="flex-1 px-2 py-0.5 border-r border-border/20">
            Old: {fileDiff()!.oldPath ?? "(new file)"}
          </div>
          <div class="flex-1 px-2 py-0.5">
            New: {fileDiff()!.newPath ?? "(deleted)"}
          </div>
        </div>
      </Show>

      {/* Content */}
      <div class="flex-1 overflow-auto">
        <Show when={loading()}>
          <div class="flex items-center justify-center h-32">
            <span class="text-xs text-muted-foreground animate-pulse">Loading diff...</span>
          </div>
        </Show>

        <Show when={error()}>
          {(err) => (
            <div class="flex items-center justify-center h-32 px-4">
              <span class="text-xs text-muted-foreground">{err()}</span>
            </div>
          )}
        </Show>

        <Show when={!loading() && fileDiff()}>
          {(diff) => (
            <Show
              when={!diff().isBinary}
              fallback={
                <div class="flex items-center justify-center h-32 text-xs text-muted-foreground">
                  Binary file — diff not available
                </div>
              }
            >
              <For each={diff().hunks}>
                {(hunk) => <SplitHunk hunk={hunk} />}
              </For>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
