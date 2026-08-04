import { For, Show, createMemo, createSignal } from "solid-js";
import { diffWordsWithSpace } from "diff";
import { Check, Clipboard, MessageSquarePlus, Plus, Minus, X } from "lucide-solid";
import type { DiffHunk, DiffLine, FileDiff } from "@/types/git";
import {
  explainLineStagingBlock,
  lineStagingBlock,
  selectionSizeFor,
  type LineSelection,
} from "./linePatch";
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
  /// The lines picked inside one hunk, or `null` for "no selection".
  ///
  /// The renderer draws it and reports clicks; it never decides what the
  /// buttons *do* with it. `onStageHunk`/`onDiscardHunk` keep their exact
  /// signature — a hunk index and nothing else — because the caller already
  /// holds the selection it passed down, and widening that callback is how a
  /// control ends up applying one hunk's lines to another.
  selection?: LineSelection | null;
  /// A click on a changed line. `shift` extends from the last plain click.
  /// Absent means line selection is off entirely, and the rows are inert.
  onLineClick?: (hunkIndex: number, lineIndex: number, shift: boolean) => void;
  /// Drop the selection without acting on it. Toggling every line back off one
  /// by one is not an exit from a twenty-line shift-select.
  onClearSelection?: () => void;
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

/// A line together with where it sits in the hunk's own `lines` array.
///
/// The index is carried, not recomputed: line selection addresses the raw
/// array (see `linePatch.ts`), and a row-position numbering derived separately
/// would be a second source of truth for the one thing that must not have two.
interface IndexedLine {
  line: DiffLine;
  index: number;
}

/// The lines that are lines. See `NO_NEWLINE_ORIGIN`.
function codeLines(lines: DiffLine[]): IndexedLine[] {
  const out: IndexedLine[] = [];
  lines.forEach((line, index) => {
    if (line.origin !== NO_NEWLINE_ORIGIN) out.push({ line, index });
  });
  return out;
}

// ─── Line selection ──────────────────────────────────────────────────────────

/// Is this raw-array position part of the current selection?
///
/// `undefined` for `lineIndex` is a row with no line on this side — the empty
/// half of a split pair — which is never selected and never pickable.
function isLineSelected(
  actions: HunkActions | undefined,
  hunkIndex: number,
  lineIndex: number | undefined,
): boolean {
  const sel = actions?.selection;
  if (!sel || lineIndex === undefined) return false;
  return sel.hunkIndex === hunkIndex && sel.lines.includes(lineIndex);
}

/// The click handler for one row, or `null` when the row is not a pick target.
///
/// Returning `null` rather than a no-op is deliberate: the callers spread it
/// straight onto `onClick`/`role`/`tabindex`, so an inert row gets no
/// interactive affordances at all rather than a focusable element that does
/// nothing when you press it.
function pickHandler(
  actions: HunkActions | undefined,
  hunkIndex: number,
  lineIndex: number | undefined,
  isPickable: boolean,
): ((e: MouseEvent) => void) | null {
  const onLineClick = actions?.onLineClick;
  if (!onLineClick || !isPickable || lineIndex === undefined) return null;
  return (e: MouseEvent) => {
    // Let a drag-select of the text win: pulling across three lines to copy
    // them should not also stage them.
    if (window.getSelection()?.toString()) return;
    onLineClick(hunkIndex, lineIndex, e.shiftKey);
  };
}

/// Selected rows get a ring rather than a background: the background already
/// carries the +/− meaning, and overwriting it would trade one fact for
/// another. Pickable-but-unselected rows only get a cursor, so the surface
/// does not shimmer under the pointer while you read.
function selectionClass(selected: boolean, pickable: boolean): string {
  if (selected) return "ring-1 ring-inset ring-primary/70 bg-primary/10";
  return pickable ? "cursor-pointer" : "";
}

/// The footnote a hunk carries when one of its sides has no trailing newline.
function NoNewlineNote() {
  return (
    <div class="px-3 py-0.5 text-label italic text-muted-foreground/70 select-none">
      No newline at end of file
    </div>
  );
}

// ─── Inline (unified) diff ───────────────────────────────────────────────────

interface InlineRowData {
  origin: " " | "+" | "-";
  line: DiffLine;
  /// Position in the hunk's raw `lines` array — what a line selection names.
  index: number;
  segments?: Segment[];
}

export function inlineRowsForHunk(all: DiffLine[]): InlineRowData[] {
  const lines = codeLines(all);
  const out: InlineRowData[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.line.origin === " " || l.line.origin === "~") {
      out.push({ origin: " ", line: l.line, index: l.index });
      i++;
      continue;
    }
    const dels: IndexedLine[] = [];
    while (i < lines.length && lines[i].line.origin === "-") {
      dels.push(lines[i]);
      i++;
    }
    const adds: IndexedLine[] = [];
    while (i < lines.length && lines[i].line.origin === "+") {
      adds.push(lines[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k];
      const a = adds[k];
      if (d && a) {
        const wordDiff = diffWordsWithSpace(d.line.content, a.line.content);
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
        out.push({ origin: "-", line: d.line, index: d.index, segments: leftSegs });
        out.push({ origin: "+", line: a.line, index: a.index, segments: rightSegs });
      } else if (d) {
        out.push({ origin: "-", line: d.line, index: d.index });
      } else if (a) {
        out.push({ origin: "+", line: a.line, index: a.index });
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

function InlineDiff(props: {
  file: FileDiff;
  hunkActions?: HunkActions;
  repoPath?: string;
  lineNumbers: boolean;
}) {
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
                <InlineRow
                  origin={row.origin}
                  line={row.line}
                  segments={row.segments}
                  lineNumbers={props.lineNumbers}
                  selected={isLineSelected(props.hunkActions, i(), row.index)}
                  onPick={pickHandler(props.hunkActions, i(), row.index, row.origin !== " ")}
                />
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
  /// Both gutters, together. A unified diff's two numbers are one reading —
  /// "line 40 became line 42" — so hiding one and keeping the other would be a
  /// third state nobody asked for.
  lineNumbers: boolean;
  selected: boolean;
  /// `null` when this row is not pickable — a context line, or a caller that
  /// did not opt into line selection at all.
  onPick: ((e: MouseEvent) => void) | null;
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
    <div
      class={`flex whitespace-pre ${bg()} ${selectionClass(props.selected, !!props.onPick)}`}
      onClick={props.onPick ?? undefined}
      role={props.onPick ? "checkbox" : undefined}
      aria-checked={props.onPick ? props.selected : undefined}
      aria-label={props.onPick ? `${props.origin === "+" ? "Added" : "Removed"} line: ${props.line.content}` : undefined}
      tabindex={props.onPick ? 0 : undefined}
      onKeyDown={(e) => {
        if (!props.onPick) return;
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        props.onPick(e as unknown as MouseEvent);
      }}
    >
      <Show when={props.lineNumbers}>
        <span
          data-lineno="old"
          class="w-12 flex-shrink-0 text-right pr-1 select-none text-muted-foreground/70 text-micro leading-[1.5]"
        >
          {props.line.oldLineno ?? ""}
        </span>
        <span
          data-lineno="new"
          class="w-12 flex-shrink-0 text-right pr-2 select-none text-muted-foreground/70 text-micro leading-[1.5]"
        >
          {props.line.newLineno ?? ""}
        </span>
      </Show>
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
  /// Raw-array positions of whichever of the three above is present. See
  /// `IndexedLine`.
  leftIndex?: number;
  rightIndex?: number;
  contextIndex?: number;
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
    if (l.line.origin === " " || l.line.origin === "~") {
      out.push({ left: null, right: null, context: l.line, contextIndex: l.index });
      i++;
      continue;
    }
    const dels: IndexedLine[] = [];
    while (i < lines.length && lines[i].line.origin === "-") {
      dels.push(lines[i]);
      i++;
    }
    const adds: IndexedLine[] = [];
    while (i < lines.length && lines[i].line.origin === "+") {
      adds.push(lines[i]);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k] ?? null;
      const a = adds[k] ?? null;
      let segments: SplitPair["segments"] | undefined;
      if (d && a) {
        const wordDiff = diffWordsWithSpace(d.line.content, a.line.content);
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
      out.push({
        left: d?.line ?? null,
        right: a?.line ?? null,
        context: null,
        leftIndex: d?.index,
        rightIndex: a?.index,
        segments,
      });
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

  /// How many lines the buttons would act on. Zero means "the whole hunk" —
  /// the selection is elsewhere, or there is none — which is what makes this
  /// an extension of hunk staging rather than a replacement for it.
  const picked = () => selectionSizeFor(props.actions?.selection ?? null, props.hunkIndex);

  /// Why this hunk cannot be split by line, when it cannot. Shown as a hint on
  /// the buttons rather than silently omitting the ability, so "you cannot
  /// pick lines here" is a sentence instead of an absence.
  const blocked = () =>
    props.actions?.onLineClick ? lineStagingBlock(props.file, props.hunk) : null;

  const stageLabel = () => {
    const base = props.actions?.stageLabel ?? "Stage hunk";
    const n = picked();
    if (n === 0) return base;
    // "Stage 3 lines", "Unstage 1 line" — the verb comes from the caller, the
    // noun from the selection.
    const verb = base.split(" ")[0];
    return `${verb} ${n} line${n === 1 ? "" : "s"}`;
  };

  const discardLabel = () => {
    const n = picked();
    return n === 0 ? "Discard hunk" : `Discard ${n} line${n === 1 ? "" : "s"}`;
  };

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
      <div class="flex-1 px-3 py-0.5 bg-muted/40 text-muted-foreground text-label border-y border-border flex items-center gap-2">
        <span class="truncate">{props.hunk.header}</span>
        {/* The note count sits outside the hover group: an existing comment has
            to be discoverable without hovering the hunk that carries it, or a
            review you left yesterday is invisible today. */}
        <Show when={notes().length > 0}>
          <span class="px-1 rounded bg-info/15 text-info text-micro">
            {notes().length}
          </span>
        </Show>
        {/* Outside the hover group, like the note count above: a live selection
            is state the user is standing in the middle of, and state you can
            only see by hovering is state you forget you are in. */}
        <Show when={picked() > 0}>
          <button
            onClick={() => props.actions?.onClearSelection?.()}
            title="Clear the line selection — the buttons go back to the whole hunk"
            aria-label="Clear line selection"
            class="flex items-center gap-1 px-1 rounded bg-primary/15 text-primary text-micro hover:bg-primary/25 transition-colors"
          >
            <span class="tabular-nums">{picked()}</span>
            <X class="w-2.5 h-2.5" />
          </button>
        </Show>
        <div class="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Show when={props.repoPath && filePath()}>
            <button
              onClick={() => setComposing((open) => !open)}
              title="Comment on this hunk — the next agent turn reads it"
              aria-label="Comment on this hunk"
              aria-expanded={composing()}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-micro hover:bg-accent/60 hover:text-foreground transition-colors"
            >
              <MessageSquarePlus class="w-2.5 h-2.5" />
              Comment
            </button>
          </Show>
          <Show when={props.actions?.onStageHunk}>
            <button
              onClick={() => void stage()}
              disabled={running()}
              title={
                blocked()
                  ? `${stageLabel()} — ${explainLineStagingBlock(blocked()!)}`
                  : stageLabel()
              }
              aria-label={stageLabel()}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-micro hover:bg-accent/60 hover:text-foreground transition-colors"
            >
              <Show
                when={props.actions?.stageReverse}
                fallback={<Plus class="w-2.5 h-2.5" />}
              >
                <Minus class="w-2.5 h-2.5" />
              </Show>
              {stageLabel()}
            </button>
          </Show>
          <Show when={props.actions?.onDiscardHunk}>
            <button
              onClick={() => void discard()}
              disabled={running()}
              title={
                picked() === 0
                  ? "Discard hunk (revert in working tree)"
                  : `${discardLabel()} (revert in working tree)`
              }
              aria-label={discardLabel()}
              class="flex items-center gap-1 px-1.5 py-0.5 rounded text-micro hover:bg-destructive/15 hover:text-destructive transition-colors"
            >
              <Minus class="w-2.5 h-2.5" />
              {picked() === 0 ? "Discard" : discardLabel()}
            </button>
          </Show>
          <button
            onClick={() => void copyAsMarkdown()}
            title="Copy hunk as markdown code block"
            aria-label="Copy hunk as markdown"
            class="flex items-center gap-1 px-1.5 py-0.5 rounded text-micro hover:bg-accent/60 hover:text-foreground transition-colors"
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
            <li class="flex items-start gap-2 px-3 py-1 text-label">
              <span class="flex-1 min-w-0 whitespace-pre-wrap break-words text-foreground/90">
                {note.body}
                <Show when={note.hunkHeader !== props.hunk.header}>
                  {/* The note's anchor moved. Saying so beats letting a reader
                      believe the comment is about the lines beneath it. */}
                  <span
                    class="ml-1 px-1 rounded bg-muted text-micro text-muted-foreground"
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
          class="flex-1 min-w-0 px-2 py-1 text-label bg-background rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          class="px-1.5 py-0.5 rounded text-micro hover:bg-accent/60 transition-colors"
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

function SplitDiff(props: {
  file: FileDiff;
  hunkActions?: HunkActions;
  repoPath?: string;
  lineNumbers: boolean;
}) {
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
              {(pair) => (
                <SplitRow
                  pair={pair}
                  lineNumbers={props.lineNumbers}
                  actions={props.hunkActions}
                  hunkIndex={i()}
                />
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

function SplitRow(props: {
  pair: SplitPair;
  lineNumbers: boolean;
  actions?: HunkActions;
  hunkIndex: number;
}) {
  /// Each half of a split row is its own pick target: the deletion on the left
  /// and the addition on the right are two separate lines of the patch, and
  /// `git add -p` lets you take one without the other.
  const leftPick = () =>
    pickHandler(props.actions, props.hunkIndex, props.pair.leftIndex, props.pair.left !== null);
  const rightPick = () =>
    pickHandler(props.actions, props.hunkIndex, props.pair.rightIndex, props.pair.right !== null);
  return (
    <div class="flex whitespace-pre min-w-0">
      <SplitCell
        line={props.pair.left ?? props.pair.context}
        side="left"
        kind={props.pair.context ? "context" : props.pair.left ? "deleted" : "empty"}
        segments={props.pair.segments?.leftSegs}
        lineNumbers={props.lineNumbers}
        selected={isLineSelected(props.actions, props.hunkIndex, props.pair.leftIndex)}
        onPick={leftPick()}
      />
      <div class="w-px bg-border shrink-0" />
      <SplitCell
        line={props.pair.right ?? props.pair.context}
        side="right"
        kind={props.pair.context ? "context" : props.pair.right ? "added" : "empty"}
        segments={props.pair.segments?.rightSegs}
        lineNumbers={props.lineNumbers}
        selected={isLineSelected(props.actions, props.hunkIndex, props.pair.rightIndex)}
        onPick={rightPick()}
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
  /// Off hides *both* sides' gutters — the two are one preference, and a split
  /// view numbered on one side only reads as a rendering bug.
  lineNumbers: boolean;
  selected: boolean;
  onPick: ((e: MouseEvent) => void) | null;
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
    <div
      class={`flex-1 flex min-w-0 ${rowBg()} ${selectionClass(props.selected, !!props.onPick)}`}
      onClick={props.onPick ?? undefined}
      role={props.onPick ? "checkbox" : undefined}
      aria-checked={props.onPick ? props.selected : undefined}
      aria-label={
        props.onPick
          ? `${props.kind === "added" ? "Added" : "Removed"} line: ${props.line?.content ?? ""}`
          : undefined
      }
      tabindex={props.onPick ? 0 : undefined}
      onKeyDown={(e) => {
        if (!props.onPick) return;
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        props.onPick(e as unknown as MouseEvent);
      }}
    >
      <div class={`w-1 shrink-0 ${gutter()}`} />
      <Show when={props.lineNumbers}>
        <span
          data-lineno={props.side}
          class="w-12 flex-shrink-0 text-right pr-2 select-none text-muted-foreground/70 text-micro leading-[1.5]"
        >
          {lineNum()}
        </span>
      </Show>
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
  /// Print the old/new line-number gutters. Defaults to on: a diff without
  /// them is the cheaper render, not the better one, and every caller with a
  /// preference to read passes `state.diffLineNumbers`.
  lineNumbers?: boolean;
}) {
  const lineNumbers = () => props.lineNumbers ?? true;
  return (
    <Show
      when={!props.file.isBinary}
      fallback={
        <div class="p-4 text-body text-muted-foreground italic">
          Binary file — no diff preview.
        </div>
      }
    >
      <Show
        // `|| truncated` because the global budget can be spent before this
        // file's first line, leaving it with real changes and no stored hunks.
        // `NoTextChange` would then say "no line changes to show" over a file
        // that changed by thousands.
        when={props.file.hunks.length > 0 || props.file.truncated}
        fallback={<NoTextChange file={props.file} />}
      >
        <Show
          when={props.mode === "split"}
          fallback={
            <InlineDiff
              file={props.file}
              hunkActions={props.hunkActions}
              repoPath={props.repoPath}
              lineNumbers={lineNumbers()}
            />
          }
        >
          <SplitDiff
            file={props.file}
            hunkActions={props.hunkActions}
            repoPath={props.repoPath}
            lineNumbers={lineNumbers()}
          />
        </Show>
        {/* Rust stops storing lines once a file blows the budget in
            `collect_diff`. The header's +/− counts are still the true totals,
            so without this the pane and the number above it disagree and the
            diff simply looks like it ends early — the same silent-wrongness
            shape as the blank pane `NoTextChange` exists to avoid. */}
        <Show when={props.file.truncated}>
          <div class="px-4 py-3 border-t border-border text-body text-muted-foreground">
            This file is too large to show in full. The{" "}
            <span class="tabular-nums">
              +{props.file.additions} −{props.file.deletions}
            </span>{" "}
            counts above are complete; the lines below the cut are not shown.
          </div>
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
    <div class="p-4 text-body text-muted-foreground space-y-1">
      <p class="italic">No line changes to show.</p>
      <p>{reason()}</p>
    </div>
  );
}
