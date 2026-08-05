/// Every conflict in the file, each with its own accept controls.
///
/// The merge editor's header already has "accept ours / theirs / both", but
/// they act on *one* conflict — whichever the prev/next cursor is parked on.
/// That is fine for a file with two conflicts and wrong for a file with
/// eleven: resolving the fourth means walking a cursor to it and trusting that
/// the label at the top still describes the block you are looking at. The
/// buttons belong next to the lines they rewrite.
///
/// Extracted from `components/git/conflict/ConflictTab.tsx`, which rendered
/// exactly this and was imported by nothing — the editor window's `MergeEditor`
/// had replaced it, and took the per-block controls out in the process. This
/// puts them back, in the surface that is actually mounted, without a second
/// copy of the marker grammar: parsing and splicing stay in
/// `components/editor/conflictMarkers.ts`.

import { For, Show } from "solid-js";
import type { ConflictBlock } from "@/components/editor/conflictMarkers";

export type ConflictChoice = "ours" | "theirs" | "both";

export function ConflictBlockList(props: {
  blocks: ConflictBlock[];
  /// Which block the header's cursor is on, so the list and the header agree
  /// about what "current" means rather than each keeping its own idea.
  activeIndex: number;
  onFocusBlock: (index: number) => void;
  onAccept: (block: ConflictBlock, choice: ConflictChoice) => void;
}) {
  return (
    <ul class="flex flex-col gap-2 p-2" aria-label="Conflicts in this file">
      <For each={props.blocks}>
        {(block, i) => (
          <ConflictCard
            index={i()}
            total={props.blocks.length}
            block={block}
            active={i() === props.activeIndex}
            onFocus={() => props.onFocusBlock(i())}
            onAccept={(choice) => props.onAccept(block, choice)}
          />
        )}
      </For>
    </ul>
  );
}

function ConflictCard(props: {
  index: number;
  total: number;
  block: ConflictBlock;
  active: boolean;
  onFocus: () => void;
  onAccept: (choice: ConflictChoice) => void;
}) {
  const label = () => `Conflict ${props.index + 1} of ${props.total}`;
  return (
    <li
      onClick={props.onFocus}
      class={`border rounded-md overflow-hidden transition-colors ${
        props.active ? "border-primary/60 bg-primary/5" : "border-border hover:border-border/80"
      }`}
    >
      <div class="flex items-center gap-1.5 px-2 py-1 bg-muted/40 border-b border-border text-micro text-muted-foreground">
        <span class="font-mono">{label()}</span>
        <span class="opacity-60 tabular-nums">
          · lines {props.block.startLine + 1}–{props.block.endLine + 1}
        </span>
        <span class="flex-1" />
        {/* Labelled with the conflict's number, not just "Accept ours": in a
            file with eleven conflicts, eleven identically-named buttons is a
            list nobody can navigate and a test nobody can scope. */}
        <button
          onClick={() => props.onAccept("ours")}
          aria-label={`Accept ours for conflict ${props.index + 1}`}
          class="px-1.5 py-0.5 rounded bg-info/15 text-info hover:bg-info/25"
        >
          Ours
        </button>
        <button
          onClick={() => props.onAccept("theirs")}
          aria-label={`Accept theirs for conflict ${props.index + 1}`}
          class="px-1.5 py-0.5 rounded bg-warning/15 text-warning hover:bg-warning/25"
        >
          Theirs
        </button>
        <button
          onClick={() => props.onAccept("both")}
          aria-label={`Accept both for conflict ${props.index + 1}`}
          class="px-1.5 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25"
        >
          Both
        </button>
      </div>
      <CodeBlock label={`Ours (${props.block.oursLabel})`} tone="info" text={props.block.ours} />
      <CodeBlock
        label={`Theirs (${props.block.theirsLabel})`}
        tone="warning"
        text={props.block.theirs}
      />
      {/* Only for diff3 markers. Saying "base: (empty)" for a file git recorded
          no ancestor for would be inventing a fact about the merge. */}
      <Show when={props.block.base !== null}>
        <CodeBlock label="Common ancestor" tone="muted" text={props.block.base!} />
      </Show>
    </li>
  );
}

function CodeBlock(props: { label: string; tone: "info" | "warning" | "muted"; text: string }) {
  const toneClass = () =>
    props.tone === "info"
      ? "text-info"
      : props.tone === "warning"
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <div class="flex flex-col border-t border-border/40 first-of-type:border-t-0">
      <div class={`px-2 pt-1 text-micro tracking-wide ${toneClass()}`}>{props.label}</div>
      <pre class="px-2 pb-1 text-micro font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto scrollbar-thin">
        {props.text || "(empty)"}
      </pre>
    </div>
  );
}
