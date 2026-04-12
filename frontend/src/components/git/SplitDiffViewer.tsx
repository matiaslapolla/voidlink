import { createSignal, For, Show, createMemo } from "solid-js";
import { ChevronDown, ChevronRight, FileText, FilePlus, FileMinus, Plus } from "lucide-solid";
import type { DiffResult, FileDiff, DiffHunk, DiffLine } from "@/types/git";

interface SplitDiffViewerProps {
  diff: DiffResult;
  onFileClick?: (path: string) => void;
  onAddToContext?: (filePath: string, content: string) => void;
}

interface SplitRow {
  type: "context" | "added" | "deleted" | "modified";
  leftLine: number | null;
  leftContent: string | null;
  leftOrigin: string | null;
  rightLine: number | null;
  rightContent: string | null;
  rightOrigin: string | null;
}

function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.origin === " " || line.origin === "~") {
      rows.push({
        type: "context",
        leftLine: line.oldLineno,
        leftContent: line.content,
        leftOrigin: line.origin,
        rightLine: line.newLineno,
        rightContent: line.content,
        rightOrigin: line.origin,
      });
      i++;
    } else if (line.origin === "-") {
      // Collect consecutive deletions
      const deletes: DiffLine[] = [];
      while (i < lines.length && lines[i].origin === "-") {
        deletes.push(lines[i]);
        i++;
      }
      // Collect consecutive additions
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].origin === "+") {
        adds.push(lines[i]);
        i++;
      }
      // Pair them up
      const maxLen = Math.max(deletes.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        const del = j < deletes.length ? deletes[j] : null;
        const add = j < adds.length ? adds[j] : null;
        rows.push({
          type: del && add ? "modified" : del ? "deleted" : "added",
          leftLine: del?.oldLineno ?? null,
          leftContent: del?.content ?? null,
          leftOrigin: del ? "-" : null,
          rightLine: add?.newLineno ?? null,
          rightContent: add?.content ?? null,
          rightOrigin: add ? "+" : null,
        });
      }
    } else if (line.origin === "+") {
      rows.push({
        type: "added",
        leftLine: null,
        leftContent: null,
        leftOrigin: null,
        rightLine: line.newLineno,
        rightContent: line.content,
        rightOrigin: "+",
      });
      i++;
    } else {
      i++;
    }
  }
  return rows;
}

export function SplitDiffViewer(props: SplitDiffViewerProps) {
  return (
    <div class="space-y-2 font-mono text-xs">
      <Show when={props.diff.files.length === 0}>
        <p class="text-sm text-muted-foreground text-center py-8">No changes</p>
      </Show>
      <For each={props.diff.files}>
        {(file) => (
          <SplitFileDiffBlock
            file={file}
            onFileClick={props.onFileClick}
            onAddToContext={props.onAddToContext}
          />
        )}
      </For>
    </div>
  );
}

function SplitFileDiffBlock(props: {
  file: FileDiff;
  onFileClick?: (path: string) => void;
  onAddToContext?: (filePath: string, content: string) => void;
}) {
  const [collapsed, setCollapsed] = createSignal(false);

  const filePath = () => props.file.newPath ?? props.file.oldPath ?? "unknown";

  const StatusIcon = () => {
    switch (props.file.status) {
      case "added":
        return <FilePlus class="w-3.5 h-3.5 text-success" />;
      case "deleted":
        return <FileMinus class="w-3.5 h-3.5 text-destructive" />;
      default:
        return <FileText class="w-3.5 h-3.5 text-info" />;
    }
  };

  return (
    <div class="rounded-md border border-border overflow-hidden">
      <div
        class="flex items-center gap-2 px-3 py-2 bg-accent/30 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setCollapsed((p) => !p)}
      >
        <button class="flex-shrink-0 text-muted-foreground">
          <Show when={collapsed()} fallback={<ChevronDown class="w-3.5 h-3.5" />}>
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
        <span class="flex-shrink-0 text-success">+{props.file.additions}</span>
        <span class="flex-shrink-0 text-destructive">-{props.file.deletions}</span>
        <Show when={props.onAddToContext}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const content = props.file.hunks
                .map((h) => h.header + "\n" + h.lines.map((l) => l.origin + l.content).join("\n"))
                .join("\n\n");
              props.onAddToContext!(filePath(), content);
            }}
            class="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors"
            title="Add diff to context"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        </Show>
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
            {(hunk) => <SplitHunkBlock hunk={hunk} />}
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

function SplitHunkBlock(props: { hunk: DiffHunk }) {
  const rows = createMemo(() => buildSplitRows(props.hunk));

  return (
    <div>
      <div class="px-3 py-1 bg-info/10 text-info border-y border-border/50 text-xs">
        {props.hunk.header}
      </div>
      <div class="grid grid-cols-2 divide-x divide-border/50">
        {/* Left (old) + Right (new) rendered as a table for alignment */}
        <table class="w-full border-collapse">
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr
                  class={
                    row.leftOrigin === "-"
                      ? "bg-destructive/8"
                      : ""
                  }
                >
                  <td class="w-10 px-2 text-right text-muted-foreground/40 select-none border-r border-border/30 tabular-nums">
                    {row.leftLine ?? ""}
                  </td>
                  <td
                    class={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                      row.leftOrigin === "-" ? "text-destructive/90" : "text-foreground"
                    }`}
                  >
                    <Show when={row.leftContent !== null}>
                      <span class="select-none text-muted-foreground/40 mr-1">
                        {row.leftOrigin === "-" ? "-" : " "}
                      </span>
                      {row.leftContent}
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <table class="w-full border-collapse">
          <tbody>
            <For each={rows()}>
              {(row) => (
                <tr
                  class={
                    row.rightOrigin === "+"
                      ? "bg-success/8"
                      : ""
                  }
                >
                  <td class="w-10 px-2 text-right text-muted-foreground/40 select-none border-r border-border/30 tabular-nums">
                    {row.rightLine ?? ""}
                  </td>
                  <td
                    class={`px-3 py-0.5 whitespace-pre-wrap break-all ${
                      row.rightOrigin === "+" ? "text-success/90" : "text-foreground"
                    }`}
                  >
                    <Show when={row.rightContent !== null}>
                      <span class="select-none text-muted-foreground/40 mr-1">
                        {row.rightOrigin === "+" ? "+" : " "}
                      </span>
                      {row.rightContent}
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </div>
  );
}
