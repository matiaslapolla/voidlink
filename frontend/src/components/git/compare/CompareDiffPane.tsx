import { Show, createMemo } from "solid-js";
import { GitCompare } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import type { FileDiff } from "@/types/git";
import {
  DiffRenderer,
  applyIgnoreWhitespace,
} from "@/components/git/shared/SplitDiffRenderer";

// Right-hand side of the Compare tab. Receives a single FileDiff and
// delegates to the shared renderer. Inherits the global diffMode and
// ignoreWhitespace toggles so the Compare experience matches working-tree
// diff conventions.

type Props = {
  file: FileDiff | null;
  baseRef: string;
  headRef: string;
};

function displayPath(file: FileDiff): { primary: string; rename: string | null } {
  const newPath = file.newPath;
  const oldPath = file.oldPath;
  if (newPath && oldPath && newPath !== oldPath) {
    return { primary: newPath, rename: oldPath };
  }
  return { primary: newPath ?? oldPath ?? "(unknown)", rename: null };
}

export function CompareDiffPane(props: Props) {
  const { state } = useAppStore();

  const transformed = createMemo<FileDiff | null>(() => {
    const f = props.file;
    if (!f) return null;
    return state.ignoreWhitespace ? applyIgnoreWhitespace(f) : f;
  });

  return (
    <div class="flex flex-col h-full bg-background min-w-0">
      <Show
        when={transformed()}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-2 px-4 text-center">
            <GitCompare class="w-7 h-7 opacity-60" />
            <p class="text-[12px]">Select a file in the tree to view its diff.</p>
          </div>
        }
      >
        {(f) => {
          const path = displayPath(f());
          return (
            <>
              <div class="flex items-center gap-3 px-3 py-1.5 border-b border-border shrink-0 text-[11px]">
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{path.primary}</div>
                  <Show when={path.rename}>
                    <div class="text-muted-foreground/80 truncate">
                      renamed from <span class="font-mono">{path.rename}</span>
                    </div>
                  </Show>
                </div>
                <div class="flex items-center gap-2 shrink-0 tabular-nums">
                  <span class="text-success">+{f().additions}</span>
                  <span class="text-destructive">−{f().deletions}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0 text-[10px] text-muted-foreground">
                  <span class="font-mono truncate max-w-[120px]" title={props.baseRef}>
                    {props.baseRef}
                  </span>
                  <span>→</span>
                  <span class="font-mono truncate max-w-[120px]" title={props.headRef}>
                    {props.headRef}
                  </span>
                </div>
              </div>
              <div class="flex-1 overflow-auto scrollbar-thin font-mono text-[12px] leading-[1.5]">
                <DiffRenderer file={f()} mode={state.diffMode} />
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}
