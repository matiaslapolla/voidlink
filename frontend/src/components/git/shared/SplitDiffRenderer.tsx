import { For, Show, createMemo, createSignal } from "solid-js";
import { diffWordsWithSpace } from "diff";
import { Check, Clipboard, MessageSquarePlus, Plus, Minus, X } from "lucide-solid";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";
import { createRowIdentity } from "@/store/stableRows";
import {
  addReviewNote,
  anchorNotes,
  resolveReviewNote,
  reviewNotesForFile,
  type ReviewNote,
} from "@/store/reviewNotes";

export interface HunkActions {
  /// Called when the user clicks "Stage hunk" / "Unstage hunk".
  /// The renderer doesn't know about staged-vs-unstaged context — the caller
  /// decides whether the action is staging (reverse=false) or unstaging
  /// (reverse=true) and passes the right label/icon via `stageLabel`.
  onStageHunk?: (hunkIndex: number) => void | Promise<void>;
  stageLabel?: string;
  stageReverse?: boolean;
  /// Called when the user clicks "Discard hunk" — reverts just this hunk in
  /// the working tree. Only shown for unstaged working-tree diffs.
  onDiscardHunk?: (hunkIndex: number) => void | Promise<void>;
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

/// The origin Rust gives `\ No newline at end of file`.
///
/// libgit2 emits that annotation as a diff line like any other, and both row
/// builders below fell through to their context arm for it — so the sentence
/// rendered as a line of the file, in the gutter, with a line number beside it,
/// as if the author had typed it. It is a note about the line above, so it is
/// pulled out of the row stream and rendered once per hunk as a footnote.
const NO_NEWLINE_ORIGIN = "\\";

export function hasNoNewlineMarker(lines: readonly DiffLine[]): boolean {
  return lines.some((l) => l.origin === NO_NEWLINE_ORIGIN);
}

/// The lines that are lines. See `NO_NEWLINE_ORIGIN`.
function codeLines(lines: DiffLine[]): DiffLine[] {
  return lines.filter((l) => l.origin !== NO_NEWLINE_ORIGIN);
}

/// The footnote a hunk carries when one of its sides has no trailing newline.
function NoNewlineNote() {
  return (
    <div class="px-3 py-0.5 text-[11px] italic text-muted-foreground/70 select-none">
      No newline at end of file
    </div>
  );
}

// ─── Inline (unified) diff ───────────────────────────────────────────────────

interface InlineRowData {
  origin: " " | "+" | "-";
  line: DiffLine;
  segments?: Segment[];
}

export function inlineRowsForHunk(all: DiffLine[]): InlineRowData[] {
  const lines = codeLines(all);
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

/// The file's hunks, as stable objects across a refetch that did not change
/// them.
///
/// `DiffTabView` refetches on every refs pulse — several a second while
/// anything is running — and `<For>` is keyed by reference, so every hunk and
/// therefore every row inside it was torn down and rebuilt. On a large diff
/// that is thousands of DOM nodes per pulse, and it takes the text selection,
/// any open review-note composer and the caret with it.
///
/// Stabilising the *hunks* is enough: `<For>`'s child closure receives the hunk
/// as a plain value, so an unchanged hunk's row builder never re-runs at all.
/// Keyed on position rather than header, because two hunks can share a header
/// and the position is what the stage/discard actions already index by.
function useStableHunks(file: () => FileDiff) {
  const stabilize = createRowIdentity<DiffHunk>((h) => `${h.oldStart}:${h.newStart}`);
  return createMemo(() => stabilize(file().hunks));
}

function InlineDiff(props: { file: FileDiff; hunkActions?: HunkActions; repoPath?: string }) {
  const hunks = useStableHunks(() => props.file);
  return (
    <div>
      <For each={hunks()}>
        {(hunk, i) => (
          // `min-w-max` makes the hunk wrapper size to the widest row inside
          // it. Header bar and every +/- row then stretch to that width, so
          // their colored backgrounds extend across the full horizontally-
          // scrolled area instead of cutting off at the viewport edge.
          <div class="min-w-max">
            <HunkHeader
              hunk={hunk}
              file={props.file}
              hunkIndex={i()}
              actions={props.hunkActions}
              repoPath={props.repoPath}
            />
            <For each={inlineRowsForHunk(hunk.lines)}>
              {(row) => (
                <InlineRow origin={row.origin} line={row.line} segments={row.segments} />
              )}
            </For>
            <Show when={hasNoNewlineMarker(hunk.lines)}>
              <NoNewlineNote />
            </Show>
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

export function pairHunkLines(all: DiffLine[]): SplitPair[] {
  const lines = codeLines(all);
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
  repoPath?: string;
}) {
  const [copied, setCopied] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const filePath = () => props.file.newPath ?? props.file.oldPath ?? "";

  /// The notes anchored to *this* hunk.
  ///
  /// Anchoring runs per hunk rather than once per file because the renderer has
  /// no per-file component to hang it on — the cost is a header-string compare
  /// per hunk, which is nothing next to the word-level diffing above.
  const notes = createMemo<ReviewNote[]>(() => {
    const repo = props.repoPath;
    const path = filePath();
    if (!repo || !path) return [];
    const fileNotes = reviewNotesForFile(repo, path).filter((n) => !n.resolved);
    if (fileNotes.length === 0) return [];
    const headers = props.file.hunks.map((h) => h.header);
    const anchored = anchorNotes(fileNotes, headers);
    // Detached notes are shown against the first hunk, so a note whose anchor
    // moved is still visible on the file rather than disappearing until the
    // diff happens to line up again.
    const own = anchored.byHunk.get(props.hunkIndex) ?? [];
    return props.hunkIndex === 0 ? [...own, ...anchored.detached] : own;
  });

  function submitNote(e: Event) {
    e.preventDefault();
    const repo = props.repoPath;
    const path = filePath();
    if (!repo || !path) return;
    const id = addReviewNote({
      repo,
      filePath: path,
      hunkHeader: props.hunk.header,
      body: draft(),
    });
    if (!id) return;
    setDraft("");
    setComposing(false);
  }

  async function copyAsMarkdown() {
    const path = props.file.newPath ?? props.file.oldPath ?? "diff";
    const ext = path.split(".").pop() ?? "";
    const body = props.hunk.lines
      .map((l) => {
        // The EOFNL annotation carries its own leading `\` in git's own format,
        // so prefixing it with a space would paste a line that no longer parses
        // as a patch.
        if (l.origin === NO_NEWLINE_ORIGIN) return `\\ ${l.content}`;
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

  async function discard() {
    if (!props.actions?.onDiscardHunk || running()) return;
    setRunning(true);
    try {
      await props.actions.onDiscardHunk(props.hunkIndex);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
    {/* Sticky so the current hunk's `@@ … @@` context (file + enclosing
        function) stays pinned to the top of the scroll area as you read a
        long hunk, handing off to the next hunk's header as it scrolls in.
        `bg-background` makes the otherwise-translucent bar opaque so diff
        rows don't bleed through while it floats; z-10 keeps it above them. */}
    <div class="flex group sticky top-0 z-10 bg-background">
      <div class="w-1 shrink-0 bg-primary/40" />
      <div class="flex-1 px-3 py-0.5 bg-muted/40 text-muted-foreground text-[11px] border-y border-border flex items-center gap-2">
        <span class="truncate">{props.hunk.header}</span>
        {/* The note count sits outside the hover group: an existing comment has
            to be discoverable without hovering the hunk that carries it, or a
            review you left yesterday is invisible today. */}
        <Show when={notes().length > 0}>
          <span class="px-1 rounded bg-info/15 text-info text-[10px]">
            {notes().length}
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Show when={props.repoPath && filePath()}>
            <button
              onClick={() => setComposing((open) => !open)}
              title="Comment on this hunk — the next agent turn reads it"
              aria-label="Comment on this hunk"
              aria-expanded={composing()}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-accent/60 hover:text-foreground transition-colors"
            >
              <MessageSquarePlus class="w-2.5 h-2.5" />
              Comment
            </button>
          </Show>
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
          <Show when={props.actions?.onDiscardHunk}>
            <button
              onClick={() => void discard()}
              disabled={running()}
              title="Discard hunk (revert in working tree)"
              aria-label="Discard hunk"
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] hover:bg-destructive/15 hover:text-destructive transition-colors"
            >
              <Minus class="w-2.5 h-2.5" />
              Discard
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

    {/* Notes and the composer sit *below* the sticky bar, in normal flow, so a
        long comment scrolls with its hunk instead of covering the code the
        comment is about. */}
    <Show when={notes().length > 0}>
      <ul class="border-b border-border bg-info/5">
        <For each={notes()}>
          {(note) => (
            <li class="flex items-start gap-2 px-3 py-1 text-[11px]">
              <span class="flex-1 min-w-0 whitespace-pre-wrap break-words text-foreground/90">
                {note.body}
                <Show when={note.hunkHeader !== props.hunk.header}>
                  {/* The note's anchor moved. Saying so beats letting a reader
                      believe the comment is about the lines beneath it. */}
                  <span
                    class="ml-1 px-1 rounded bg-muted text-[10px] text-muted-foreground"
                    title="The hunk this was written against has changed"
                  >
                    moved
                  </span>
                </Show>
              </span>
              <button
                onClick={() => resolveReviewNote(props.repoPath ?? "", note.id)}
                title="Resolve — stops sending it to the agent, keeps the note"
                aria-label={`Resolve comment: ${note.body.split("\n")[0]}`}
                class="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
              >
                <Check class="w-2.5 h-2.5" />
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>

    <Show when={composing()}>
      <form class="flex items-start gap-2 px-3 py-1.5 border-b border-border bg-muted/20" onSubmit={submitNote}>
        <textarea
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter submits, Shift+Enter is a newline: a review comment is one
            // or two sentences, and a textarea that needs a mouse to submit is
            // a textarea people stop using.
            if (e.key === "Enter" && !e.shiftKey) submitNote(e);
            if (e.key === "Escape") setComposing(false);
          }}
          rows="2"
          placeholder="What should change here? The next agent turn reads this."
          aria-label="Comment on this hunk"
          class="flex-1 min-w-0 px-2 py-1 text-[11px] bg-background rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          class="px-1.5 py-0.5 rounded text-[10px] hover:bg-accent/60 transition-colors"
        >
          Comment
        </button>
        <button
          type="button"
          onClick={() => setComposing(false)}
          aria-label="Cancel this comment"
          class="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
        >
          <X class="w-2.5 h-2.5" />
        </button>
      </form>
    </Show>
    </>
  );
}

function SplitDiff(props: { file: FileDiff; hunkActions?: HunkActions; repoPath?: string }) {
  const hunks = useStableHunks(() => props.file);
  return (
    <div>
      <For each={hunks()}>
        {(hunk, i) => (
          <div>
            <HunkHeader
              hunk={hunk}
              file={props.file}
              hunkIndex={i()}
              actions={props.hunkActions}
              repoPath={props.repoPath}
            />
            <For each={pairHunkLines(hunk.lines)}>
              {(pair) => <SplitRow pair={pair} />}
            </For>
            <Show when={hasNoNewlineMarker(hunk.lines)}>
              <NoNewlineNote />
            </Show>
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

// ─── Public renderer ─────────────────────────────────────────────────────────

export function DiffRenderer(props: {
  file: FileDiff;
  mode: "inline" | "split";
  hunkActions?: HunkActions;
  /// The repository this diff belongs to. Optional, and its absence is what
  /// turns review comments off: the compare view diffs two refs and a note
  /// written there would have nowhere to land in the working tree. A caller
  /// that wants annotation opts in by passing the repo.
  repoPath?: string;
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
        when={props.file.hunks.length > 0}
        fallback={<NoTextChange file={props.file} />}
      >
        <Show
          when={props.mode === "split"}
          fallback={
            <InlineDiff
              file={props.file}
              hunkActions={props.hunkActions}
              repoPath={props.repoPath}
            />
          }
        >
          <SplitDiff file={props.file} hunkActions={props.hunkActions} repoPath={props.repoPath} />
        </Show>
      </Show>
    </Show>
  );
}

/// A file that changed without any line changing.
///
/// A non-binary file with zero hunks used to render `<For each={[]}>` — an
/// empty white pane with nothing to explain it, reachable in three ordinary
/// ways: a mode change (`chmod +x`), a submodule pointer move, and a file whose
/// only edit was whitespace when `ignoreWhitespace` filtered every hunk away.
/// The row above it says the file changed, so silence here reads as the diff
/// viewer being broken rather than as an answer.
///
/// §7.5.2/§7.5.4: never blank a region to say something about it.
function NoTextChange(props: { file: FileDiff }) {
  const reason = () => {
    switch (props.file.status) {
      case "typechange":
        return "Its type changed — between a regular file, a symlink and a directory.";
      case "renamed":
      case "copied":
        return "Only its path changed; the contents are identical.";
      default:
        return "Its mode or the commit it points at changed, but no line did.";
    }
  };
  return (
    <div class="p-4 text-xs text-muted-foreground space-y-1">
      <p class="italic">No line changes to show.</p>
      <p>{reason()}</p>
    </div>
  );
}
