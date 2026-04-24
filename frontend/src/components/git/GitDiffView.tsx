import { For, Show, createMemo, createResource } from "solid-js";
import { X, Rows3, Columns2, Space } from "lucide-solid";
import { diffWordsWithSpace } from "diff";
import { gitApi } from "@/api/git";
import { useAppStore } from "@/store/LayoutContext";
import type { DiffLine, FileDiff, DiffHunk } from "@/types/git";

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

  const fileDiff = createMemo<FileDiff | null>(() => {
    const d = diff();
    if (!d) return null;
    const file = d.files.find((f) => (f.newPath ?? f.oldPath) === props.filePath) ?? null;
    if (!file || !state.ignoreWhitespace) return file;
    return applyIgnoreWhitespace(file);
  });

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
        <div role="group" aria-label="Diff view mode" class="flex items-center gap-0.5 rounded-md border border-border p-0.5">
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
            <Show when={!f().isBinary} fallback={
              <div class="p-4 text-xs text-muted-foreground italic">Binary file — no diff preview.</div>
            }>
              <Show when={state.diffMode === "split"} fallback={<InlineDiff file={f()} />}>
                <SplitDiff file={f()} />
              </Show>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

// ─── Inline (unified) diff ───────────────────────────────────────────────────

interface InlineRowData {
  origin: " " | "+" | "-";
  line: DiffLine;
  segments?: Segment[];
}

function inlineRowsForHunk(lines: DiffLine[]): InlineRowData[] {
  const out: InlineRowData[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.origin === " " || l.origin === "~") {
      out.push({ origin: " ", line: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "-") { dels.push(lines[i]); i++; }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "+") { adds.push(lines[i]); i++; }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k], a = adds[k];
      if (d && a) {
        const wordDiff = diffWordsWithSpace(d.content, a.content);
        const leftSegs: Segment[] = [];
        const rightSegs: Segment[] = [];
        for (const part of wordDiff) {
          if (part.added) rightSegs.push({ text: part.value, changed: true });
          else if (part.removed) leftSegs.push({ text: part.value, changed: true });
          else {
            leftSegs.push({ text: part.value, changed: false });
            rightSegs.push({ text: part.value, changed: false });
          }
        }
        out.push({ origin: "-", line: d, segments: leftSegs });
        out.push({ origin: "+", line: a, segments: rightSegs });
      } else if (d) {
        out.push({ origin: "-", line: d });
      } else if (a) {
        out.push({ origin: "+", line: a });
      }
    }
  }
  return out;
}

function InlineDiff(props: { file: FileDiff }) {
  return (
    <div>
      <For each={props.file.hunks}>
        {(hunk) => (
          <div>
            <HunkHeader text={hunk.header} />
            <For each={inlineRowsForHunk(hunk.lines)}>
              {(row) => <InlineRow origin={row.origin} line={row.line} segments={row.segments} />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

function InlineRow(props: {
  origin: " " | "+" | "-";
  line: DiffLine;
  segments?: Segment[];
}) {
  const bg = () => {
    switch (props.origin) {
      case "+": return "bg-success/10 text-foreground/90";
      case "-": return "bg-destructive/10 text-foreground/90";
      default: return "text-foreground/85";
    }
  };
  return (
    <div class={`flex whitespace-pre ${bg()}`}>
      <span class="w-12 flex-shrink-0 text-right pr-1 select-none text-muted-foreground/70 text-[10px] leading-[1.5]">
        {props.line.oldLineno ?? ""}
      </span>
      <span class="w-12 flex-shrink-0 text-right pr-2 select-none text-muted-foreground/70 text-[10px] leading-[1.5]">
        {props.line.newLineno ?? ""}
      </span>
      <span class="w-4 flex-shrink-0 select-none opacity-70">{props.origin}</span>
      <span class="flex-1 pr-3">
        <Show when={props.segments} fallback={props.line.content}>
          <For each={props.segments}>
            {(seg) => (
              <span class={seg.changed ? (props.origin === "+" ? "bg-success/35" : "bg-destructive/35") : ""}>
                {seg.text}
              </span>
            )}
          </For>
        </Show>
      </span>
    </div>
  );
}

// ─── Split (side-by-side) diff — JetBrains style ─────────────────────────────
//
// Key elements that make IntelliJ's two-pane diff distinctive:
//   • pair lines across panes so matching context aligns vertically
//   • word-level (token-level) intra-line highlighting: within a modified row,
//     shade only the tokens that actually changed, not the whole line
//   • a thin change bar in the gutter next to each changed line
//   • ghost rows on the other side when one pane has lines the other lacks
//
// We compute word-level diffs with the `diff` package (diffWordsWithSpace) for
// every paired delete/add, which matches how IntelliJ highlights "character
// differences" between matched rows.

interface Segment {
  text: string;
  changed: boolean;
}

interface SplitPair {
  header?: string;
  left: DiffLine | null;
  right: DiffLine | null;
  context: DiffLine | null;
  segments?: {
    leftSegs: Segment[];
    rightSegs: Segment[];
  };
}

/**
 * Pair lines so deletions sit next to their matching additions within a run,
 * and context lines align on both sides. For paired -/+ rows we also compute
 * word-level diffs so the split renderer can shade only the changed tokens.
 */
function pairHunkLines(lines: DiffLine[]): SplitPair[] {
  const out: SplitPair[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.origin === " " || l.origin === "~") {
      out.push({ left: null, right: null, context: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "-") {
      dels.push(lines[i]); i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "+") {
      adds.push(lines[i]); i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k] ?? null;
      const a = adds[k] ?? null;
      let segments: SplitPair["segments"] | undefined;
      if (d && a) {
        const wordDiff = diffWordsWithSpace(d.content, a.content);
        const leftSegs: Segment[] = [];
        const rightSegs: Segment[] = [];
        for (const part of wordDiff) {
          if (part.added) {
            rightSegs.push({ text: part.value, changed: true });
          } else if (part.removed) {
            leftSegs.push({ text: part.value, changed: true });
          } else {
            leftSegs.push({ text: part.value, changed: false });
            rightSegs.push({ text: part.value, changed: false });
          }
        }
        segments = { leftSegs, rightSegs };
      }
      out.push({ left: d, right: a, context: null, segments });
    }
  }
  return out;
}

function HunkHeader(props: { text: string }) {
  return (
    <div class="flex">
      <div class="w-1 shrink-0 bg-primary/40" />
      <div class="flex-1 px-3 py-0.5 bg-muted/40 text-muted-foreground text-[11px] border-y border-border">
        {props.text}
      </div>
    </div>
  );
}

function SplitDiff(props: { file: FileDiff }) {
  return (
    <div>
      <For each={props.file.hunks}>
        {(hunk) => (
          <div>
            <HunkHeader text={hunk.header} />
            <For each={pairHunkLines(hunk.lines)}>
              {(pair) => <SplitRow pair={pair} />}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

function SplitRow(props: { pair: SplitPair }) {
  return (
    <div class="flex whitespace-pre min-w-0">
      <SplitCell
        line={props.pair.left ?? props.pair.context}
        side="left"
        kind={props.pair.context ? "context" : props.pair.left ? "deleted" : "empty"}
        segments={props.pair.segments?.leftSegs}
      />
      <div class="w-px bg-border shrink-0" />
      <SplitCell
        line={props.pair.right ?? props.pair.context}
        side="right"
        kind={props.pair.context ? "context" : props.pair.right ? "added" : "empty"}
        segments={props.pair.segments?.rightSegs}
      />
    </div>
  );
}

type CellKind = "context" | "deleted" | "added" | "empty";

/**
 * Return a copy of the file diff with whitespace-only changes stripped.
 * Paired -/+ where trimmed content matches get dropped (not reclassified as
 * context — matches what `git diff -w` shows). Lone blank-only additions or
 * deletions are dropped too. Recomputes per-hunk +/- counts.
 */
function applyIgnoreWhitespace(file: FileDiff): FileDiff {
  const normalize = (s: string) => s.replace(/\s+/g, "");

  const newHunks: DiffHunk[] = file.hunks.map((hunk) => {
    const lines: DiffLine[] = [];
    let i = 0;
    while (i < hunk.lines.length) {
      const l = hunk.lines[i];
      if (l.origin === " " || l.origin === "~") {
        lines.push(l);
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].origin === "-") { dels.push(hunk.lines[i]); i++; }
      const adds: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].origin === "+") { adds.push(hunk.lines[i]); i++; }

      // Pair by position; if a pair normalises to the same string, drop both.
      const max = Math.max(dels.length, adds.length);
      for (let k = 0; k < max; k++) {
        const d = dels[k];
        const a = adds[k];
        if (d && a && normalize(d.content) === normalize(a.content)) continue;
        if (d && !a && normalize(d.content) === "") continue;
        if (a && !d && normalize(a.content) === "") continue;
        if (d) lines.push(d);
        if (a) lines.push(a);
      }
    }
    return { ...hunk, lines };
  });

  // Hunks that ended up with only context lines are gone entirely.
  const keptHunks = newHunks.filter((h) =>
    h.lines.some((l) => l.origin === "+" || l.origin === "-"),
  );

  let totalAdd = 0;
  let totalDel = 0;
  for (const h of keptHunks) {
    for (const l of h.lines) {
      if (l.origin === "+") totalAdd++;
      else if (l.origin === "-") totalDel++;
    }
  }

  return {
    ...file,
    hunks: keptHunks,
    additions: totalAdd,
    deletions: totalDel,
  };
}

function SplitCell(props: {
  line: DiffLine | null;
  side: "left" | "right";
  kind: CellKind;
  segments?: Segment[];
}) {
  const gutter = () => {
    switch (props.kind) {
      case "deleted": return "bg-destructive/60";
      case "added": return "bg-success/60";
      default: return "bg-transparent";
    }
  };
  const rowBg = () => {
    switch (props.kind) {
      case "deleted": return "bg-destructive/10 text-foreground/90";
      case "added": return "bg-success/10 text-foreground/90";
      case "empty": return "bg-muted/20";
      default: return "text-foreground/85";
    }
  };
  const tokenShade = () => {
    if (props.kind === "deleted") return "bg-destructive/40";
    if (props.kind === "added") return "bg-success/40";
    return "";
  };
  const lineNum = () => {
    if (!props.line) return "";
    return props.side === "left" ? props.line.oldLineno ?? "" : props.line.newLineno ?? "";
  };
  return (
    <div class={`flex-1 flex min-w-0 ${rowBg()}`}>
      {/* JB-style change bar in the gutter */}
      <div class={`w-1 shrink-0 ${gutter()}`} />
      <span class="w-12 flex-shrink-0 text-right pr-2 select-none text-muted-foreground/70 text-[10px] leading-[1.5]">
        {lineNum()}
      </span>
      <span class="flex-1 pr-3 min-w-0 overflow-hidden">
        <Show when={props.segments && props.segments.length > 0} fallback={props.line?.content ?? ""}>
          <For each={props.segments}>
            {(seg) => (
              <span class={seg.changed ? tokenShade() : ""}>{seg.text}</span>
            )}
          </For>
        </Show>
      </span>
    </div>
  );
}
