import { For, Show } from "solid-js";
import { FilePlus, FileMinus, FileText } from "lucide-solid";
import type { FileDiff } from "@/types/git";

interface DiffFileListProps {
  files: FileDiff[];
  onSelectFile: (path: string) => void;
  selectedFile?: string;
}

export function DiffFileList(props: DiffFileListProps) {
  const filePath = (f: FileDiff) => f.newPath ?? f.oldPath ?? "unknown";

  return (
    <div class="h-full overflow-y-auto border-r border-border bg-sidebar py-1">
      <div class="px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Changed Files ({props.files.length})
      </div>
      <Show when={props.files.length === 0}>
        <p class="px-3 py-2 text-xs text-muted-foreground">No changes</p>
      </Show>
      <For each={props.files}>
        {(file) => {
          const path = filePath(file);
          const isSelected = () => props.selectedFile === path;

          return (
            <button
              onClick={() => props.onSelectFile(path)}
              class={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors text-left hover:bg-accent/60 ${
                isSelected() ? "bg-accent text-accent-foreground" : "text-foreground"
              }`}
            >
              <Show when={file.status === "added"}>
                <FilePlus class="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
              </Show>
              <Show when={file.status === "deleted"}>
                <FileMinus class="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
              </Show>
              <Show when={file.status !== "added" && file.status !== "deleted"}>
                <FileText class="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
              </Show>
              <span class="flex-1 truncate">{path}</span>
              <span class="flex-shrink-0 text-green-500 text-xs">
                +{file.additions}
              </span>
              <span class="flex-shrink-0 text-red-400 text-xs">
                -{file.deletions}
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
