import { For, Show, createSignal } from "solid-js";
import { diffWordsWithSpace } from "diff";
import { Check, Clipboard, Plus, Minus } from "lucide-solid";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";

export interface HunkActions {
  /// Called when the user clicks "Stage hunk" / "Unstage hunk".
  /// The renderer doesn't know about staged-vs-unstaged context — the caller
  /// decides whether the action is staging (reverse=false) or unstaging
  /// (reverse=true) and passes the right label/icon via `stageLabel`.
  onStageHunk?: (hunkIndex: number) => void | Promise<void>;
  stageLabel?: string;
  stageReverse?: boolean;
}

// JetBrains-style diff renderer used by both working-tree and ref-vs-ref
// comparison views. Two modes: inline (unified) and split (side-by-side).
// In split mode, paired delete/add rows compute word-level diffs with
// `diff` and shade only the changed tokens — IntelliJ's "character
// differences" treatment.

interface Segment {
  text: string;
  changed: boolean;
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
    while (i < lines.length && lines[i].origin === "-") {
      dels.push(lines[i]);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "+") {
      adds.push(lines[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k];
      const a = adds[k];
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

function InlineDiff(props: { file: FileDiff; hunkActions?: HunkActions }) {
  return (
    <div>
      <For each={props.file.hunks}>
        {(hunk, i) => (
          <div>
            <HunkHeader
              hunk={hunk}
              file={props.file}
              hunkIndex={i()}
              actions={props.hunkActions}
            />
            <For each={inlineRowsForHunk(hunk.lines)}>
              {(row) => (
                <InlineRow origin={row.origin} line={row.line} segments={row.segments} />
              )}
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
      case "+":
        return "bg-success/10 text-foreground/90";
      case "-":
        return "bg-destructive/10 text-foreground/90";
      default:
        return "text-foreground/85";
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
              <span
                class={
                  seg.changed
                    ? props.origin === "+"
                      ? "bg-success/35"
                      : "bg-destructive/35"
                    : ""
                }
              >
                {seg.text}
              </span>
            )}
          </For>
        </Show>
      </span>
    </div>
  );
}

// ─── Split (side-by-side) diff ───────────────────────────────────────────────

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
      dels.push(lines[i]);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].origin === "+") {
      adds.push(lines[i]);
      i++;
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

function HunkHeader(props: {
  hunk: DiffHunk;
  file: FileDiff;
  hunkIndex: number;
  actions?: HunkActions;
}) {
  const [copied, setCopied] = createSignal(false);
  const [running, setRunning] = createSignal(false);

  async function copyAsMarkdown() {
    const path = props.file.newPath ?? props.file.oldPath ?? "diff";
    const ext = path.split(".").pop() ?? "";
    const body = props.hunk.lines
      .map((l) => {
        const prefix = l.origin === "+" ? "+" : l.origin === "-" ? "-" : " ";
        return `${prefix}${l.content}`;
      })
      .join("\n");
    const snippet =
      "`" + path + "` " + props.hunk.header + "\n```" + ext + "\n" + body + "\n```";
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard may be unavailable in some webview configurations.
    }
  }

  async function stage() {
    if (!props.actions?.onStageHunk || running()) return;
    setRunning(true);
    try {
      await props.actions.onStageHunk(props.hunkIndex);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="flex group">
      <div class="w-1 shrink-0 bg-primary/40" />
      <div class="flex-1 px-3 py-0.5 bg-muted/40 text-muted-foreground text-[11px] border-y border-border flex items-center gap-2">
        <span class="truncate">{props.hunk.header}</span>
        <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Show when={props.actions?.onStageHunk}>
            <button
              onClick={() => void stage()}
              disabled={running()}
              title={props.actions?.stageLabel ?? "Stage hunk"}
              aria-label={props.actions?.stageLabel ?? "Stage hunk"}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-accent/60 hover:text-foreground transition-colors"
            >
              <Show
                when={props.actions?.stageReverse}
                fallback={<Plus class="w-2.5 h-2.5" />}
              >
                <Minus class="w-2.5 h-2.5" />
              </Show>
              {props.actions?.stageLabel ?? "Stage hunk"}
            </button>
          </Show>
          <button
            onClick={() => void copyAsMarkdown()}
            title="Copy hunk as markdown code block"
            aria-label="Copy hunk as markdown"
            class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-accent/60 hover:text-foreground transition-colors"
          >
            <Show when={copied()} fallback={<Clipboard class="w-2.5 h-2.5" />}>
              <Check class="w-2.5 h-2.5 text-success" />
            </Show>
            {copied() ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SplitDiff(props: { file: FileDiff; hunkActions?: HunkActions }) {
  return (
    <div>
      <For each={props.file.hunks}>
        {(hunk, i) => (
          <div>
            <HunkHeader
              hunk={hunk}
              file={props.file}
              hunkIndex={i()}
              actions={props.hunkActions}
            />
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

function SplitCell(props: {
  line: DiffLine | null;
  side: "left" | "right";
  kind: CellKind;
  segments?: Segment[];
}) {
  const gutter = () => {
    switch (props.kind) {
      case "deleted":
        return "bg-destructive/60";
      case "added":
        return "bg-success/60";
      default:
        return "bg-transparent";
    }
  };
  const rowBg = () => {
    switch (props.kind) {
      case "deleted":
        return "bg-destructive/10 text-foreground/90";
      case "added":
        return "bg-success/10 text-foreground/90";
      case "empty":
        return "bg-muted/20";
      default:
        return "text-foreground/85";
    }
  };
  const tokenShade = () => {
    if (props.kind === "deleted") return "bg-destructive/40";
    if (props.kind === "added") return "bg-success/40";
    return "";
  };
  const lineNum = () => {
    if (!props.line) return "";
    return props.side === "left"
      ? (props.line.oldLineno ?? "")
      : (props.line.newLineno ?? "");
  };
  return (
    <div class={`flex-1 flex min-w-0 ${rowBg()}`}>
      <div class={`w-1 shrink-0 ${gutter()}`} />
      <span class="w-12 flex-shrink-0 text-right pr-2 select-none text-muted-foreground/70 text-[10px] leading-[1.5]">
        {lineNum()}
      </span>
      <span class="flex-1 pr-3 min-w-0 overflow-hidden">
        <Show
          when={props.segments && props.segments.length > 0}
          fallback={props.line?.content ?? ""}
        >
          <For each={props.segments}>
            {(seg) => <span class={seg.changed ? tokenShade() : ""}>{seg.text}</span>}
          </For>
        </Show>
      </span>
    </div>
  );
}

// ─── Ignore-whitespace transform ─────────────────────────────────────────────

/**
 * Return a copy of the file diff with whitespace-only changes stripped.
 * Mirrors `git diff -w`: paired -/+ that match after collapsing whitespace are
 * dropped (not reclassified as context). Lone blank-only additions/deletions
 * are dropped too. Recomputes per-file +/- counts.
 */
export function applyIgnoreWhitespace(file: FileDiff): FileDiff {
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
      while (i < hunk.lines.length && hunk.lines[i].origin === "-") {
        dels.push(hunk.lines[i]);
        i++;
      }
      const adds: DiffLine[] = [];
      while (i < hunk.lines.length && hunk.lines[i].origin === "+") {
        adds.push(hunk.lines[i]);
        i++;
      }
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

// ─── Public renderer ─────────────────────────────────────────────────────────

export function DiffRenderer(props: {
  file: FileDiff;
  mode: "inline" | "split";
  hunkActions?: HunkActions;
}) {
  return (
    <Show
      when={!props.file.isBinary}
      fallback={
        <div class="p-4 text-xs text-muted-foreground italic">
          Binary file — no diff preview.
        </div>
      }
    >
      <Show
        when={props.mode === "split"}
        fallback={<InlineDiff file={props.file} hunkActions={props.hunkActions} />}
      >
        <SplitDiff file={props.file} hunkActions={props.hunkActions} />
      </Show>
    </Show>
  );
}
