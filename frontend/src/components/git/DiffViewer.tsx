import { createSignal, For, Show } from "solid-js";
import { ChevronDown, ChevronRight, FileText, FilePlus, FileMinus } from "lucide-solid";
import type { DiffResult, FileDiff, DiffHunk } from "@/types/git";

interface DiffViewerProps {
  diff: DiffResult;
  onFileClick?: (path: string) => void;
}

export function DiffViewer(props: DiffViewerProps) {
  return (
    <div class="space-y-2 font-mono text-xs">
      <Show when={props.diff.files.length === 0}>
        <p class="text-sm text-muted-foreground text-center py-8">No changes</p>
      </Show>

      <For each={props.diff.files}>
        {(file) => <FileDiffBlock file={file} onFileClick={props.onFileClick} />}
      </For>
    </div>
  );
}

function FileDiffBlock(props: {
  file: FileDiff;
  onFileClick?: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = createSignal(false);

  const filePath = () =>
    props.file.newPath ?? props.file.oldPath ?? "unknown";

  const StatusIcon = () => {
    switch (props.file.status) {
      case "added":
        return <FilePlus class="w-3.5 h-3.5 text-green-500" />;
      case "deleted":
        return <FileMinus class="w-3.5 h-3.5 text-red-500" />;
      default:
        return <FileText class="w-3.5 h-3.5 text-blue-400" />;
    }
  };

  return (
    <div class="rounded-md border border-border overflow-hidden">
      {/* File header */}
      <div
        class="flex items-center gap-2 px-3 py-2 bg-accent/30 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setCollapsed((p) => !p)}
      >
        <button class="flex-shrink-0 text-muted-foreground">
          <Show
            when={collapsed()}
            fallback={<ChevronDown class="w-3.5 h-3.5" />}
          >
            <ChevronRight class="w-3.5 h-3.5" />
          </Show>
        </button>
        <StatusIcon />
        <button
          class="flex-1 text-left truncate hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            props.onFileClick?.(filePath());
          }}
        >
          {filePath()}
        </button>
        <span class="flex-shrink-0 text-green-500">+{props.file.additions}</span>
        <span class="flex-shrink-0 text-red-400">-{props.file.deletions}</span>
      </div>

      <Show when={!collapsed()}>
        <Show
          when={!props.file.isBinary}
          fallback={
            <div class="px-4 py-3 text-xs text-muted-foreground italic">
              Binary file not shown
            </div>
          }
        >
          <For each={props.file.hunks}>
            {(hunk) => <HunkBlock hunk={hunk} />}
          </For>
          <Show when={props.file.hunks.length === 0}>
            <div class="px-4 py-3 text-xs text-muted-foreground italic">
              File {props.file.status}
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  );
}

function HunkBlock(props: { hunk: DiffHunk }) {
  return (
    <div>
      {/* Hunk header */}
      <div class="px-3 py-1 bg-blue-500/10 text-blue-400 border-y border-border/50 text-xs">
        {props.hunk.header}
      </div>

      {/* Lines */}
      <table class="w-full border-collapse">
        <tbody>
          <For each={props.hunk.lines}>
            {(line) => (
              <tr
                class={
                  line.origin === "+"
                    ? "bg-green-500/10"
                    : line.origin === "-"
                      ? "bg-red-500/10"
                      : ""
                }
              >
                <td class="w-10 px-2 text-right text-muted-foreground/50 select-none border-r border-border/30 tabular-nums">
                  {line.origin === "-" ? (line.oldLineno ?? "") : ""}
                </td>
                <td class="w-10 px-2 text-right text-muted-foreground/50 select-none border-r border-border/30 tabular-nums">
                  {line.origin === "+" ? (line.newLineno ?? "") : ""}
                </td>
                <td
                  class={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                    line.origin === "+" ? "text-green-400" : line.origin === "-" ? "text-red-400" : "text-foreground"
                  }`}
                >
                  <span class="select-none text-muted-foreground/40 mr-1">
                    {line.origin === "~" ? "\\" : line.origin}
                  </span>
                  {line.content}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
