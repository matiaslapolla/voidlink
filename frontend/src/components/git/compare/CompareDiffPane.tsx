import { Show, createMemo, createResource } from "solid-js";
import { GitCompare } from "lucide-solid";
import type { DiffMode } from "@/store/layout";
import type { FileDiff } from "@/types/git";
import {
  DiffRenderer,
} from "@/components/git/shared/SplitDiffRenderer";
import { ProvenanceNote } from "@/components/git/shared/ProvenanceNote";
import { isCommitOid, loadCommitProvenance } from "@/components/git/shared/provenance";

// Right-hand side of the Compare tab. Receives a single FileDiff and
// delegates to the shared renderer. `diffMode` comes from the owning
// CompareTab's own per-tab state, not the global working-tree toggle —
// see CompareTab.tsx for why the two are kept separate.

type Props = {
  file: FileDiff | null;
  baseRef: string;
  headRef: string;
  diffMode: DiffMode;
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
  /// The file exactly as the backend produced it. "Ignore whitespace" is now a
  /// diff option rather than a post-hoc filter here, so what this renders and
  /// what the tree counts are the same diff.
  const transformed = createMemo<FileDiff | null>(() => props.file ?? null);

  /// The agent the journal already credited this commit to, if any.
  ///
  /// Only asked when the head is a full oid — which is what
  /// `commands/commitDiff.ts` puts there when a commit's own diff is opened. A
  /// compare of two *branches* spans many commits, and naming one agent over a
  /// range that several of them contributed to would be a claim the log does
  /// not support: there is no per-hunk evidence to say which commit inside the
  /// range a given hunk came from. So that case shows nothing rather than
  /// something plausible.
  const [provenance] = createResource(
    () => (isCommitOid(props.headRef) ? props.headRef : null),
    (oid) => loadCommitProvenance(oid).catch(() => null),
  );

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
          // A function, not `const path = displayPath(f())`.
          //
          // A non-keyed `<Show>` runs this callback inside `untrack()` and
          // re-runs it only when the condition flips falsy→truthy — its
          // condition memo compares `!a === !b`, so file → *different* file is
          // not a change it reacts to. Computing the path once therefore froze
          // the header on whichever file was selected first: the +/− counts and
          // the diff body updated (they read `f()` during render, which does
          // track), while the name above them kept naming a file you were no
          // longer looking at.
          const path = () => displayPath(f());
          return (
            <>
              <div class="flex items-center gap-3 px-3 py-1.5 border-b border-border shrink-0 text-[11px]">
                <div class="flex-1 min-w-0">
                  <div class="font-medium truncate">{path().primary}</div>
                  <Show when={path().rename}>
                    <div class="text-muted-foreground/80 truncate">
                      renamed from <span class="font-mono">{path().rename}</span>
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
              <ProvenanceNote provenance={provenance()} />
              <div class="flex-1 overflow-auto scrollbar-thin font-mono text-[12px] leading-[1.5]">
                <DiffRenderer file={f()} mode={props.diffMode} />
              </div>
            </>
          );
        }}
      </Show>
    </div>
  );
}
