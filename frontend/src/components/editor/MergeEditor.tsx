/// A three-way merge editor, laid out the way VS Code's is: Ours | Base |
/// Theirs across the top, Result underneath, with per-conflict accept actions
/// and a resolved counter.
///
/// monaco-editor 0.55 ships no merge editor — that surface is VS Code-only — so
/// this composes one out of the pieces it does ship: when git recorded a common
/// ancestor, the two incoming sides are `createDiffEditor`s against Base, which
/// is what makes "what did each side actually change" readable at a glance;
/// without an ancestor they degrade to plain read-only panes.
///
/// The conflict grammar itself is not re-implemented here. Parsing and splicing
/// come from `conflictMarkers.ts`, shared with the git sidebar's block view, so
/// the two surfaces can never disagree about what a half-resolved file means.

import {
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  type JSX,
} from "solid-js";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitMerge,
  RotateCw,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { pushToast } from "@/commands/toast";
import { emitGitRefsChanged } from "@/commands/gitEvents";
import { applyResolution, parseConflicts } from "./conflictMarkers";
import { MonacoDiffPane, MonacoPane } from "./MonacoPanes";

interface MergeEditorProps {
  repoPath: string;
  filePath: string;
  onResolved: () => void;
}

export function MergeEditor(props: MergeEditorProps) {
  const [versions, { refetch }] = createResource(
    () => ({ repo: props.repoPath, file: props.filePath }),
    ({ repo, file }) => gitApi.conflictVersions(repo, file),
  );

  /// The Result buffer: the file as it will be written. Seeded from the working
  /// tree (markers and all) and then whittled down by the accept buttons or by
  /// typing straight into the Result pane.
  const [buffer, setBuffer] = createSignal<string | null>(null);
  /// Which conflict the accept buttons act on. Clamped against the live block
  /// list, so resolving the last one walks back rather than pointing off the end.
  const [cursor, setCursor] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  /// Conflict count when the file was first loaded, so the counter can read
  /// "2 of 5 resolved" instead of just counting down from an unknown total.
  const [total, setTotal] = createSignal(0);

  // Seed (and re-seed after a reset) from whatever the resource last returned.
  createEffect(
    on(versions, (v) => {
      if (!v || buffer() !== null) return;
      setBuffer(v.working);
      setTotal(parseConflicts(v.working).blocks.length);
      setCursor(0);
    }),
  );

  const blocks = createMemo(() => {
    const b = buffer();
    return b !== null ? parseConflicts(b).blocks : [];
  });

  const resolved = () => Math.max(0, total() - blocks().length);
  const current = () => blocks()[Math.min(cursor(), blocks().length - 1)] ?? null;

  function accept(choice: "ours" | "theirs" | "both") {
    const block = current();
    const cur = buffer();
    if (!block || cur === null) return;
    setBuffer(applyResolution(cur, block, choice));
    // Stay on the same index: the blocks after this one shift down by one, so
    // the same index is now the *next* unresolved conflict.
    setCursor((c) => Math.min(c, Math.max(0, blocks().length - 1)));
  }

  function step(delta: 1 | -1) {
    const count = blocks().length;
    if (count === 0) return;
    setCursor((c) => (c + delta + count) % count);
  }

  async function save() {
    const cur = buffer();
    if (cur === null) return;
    const remaining = parseConflicts(cur).blocks.length;
    if (remaining > 0) {
      pushToast(
        `${remaining} conflict block${remaining === 1 ? "" : "s"} still unresolved`,
        "warning",
      );
      return;
    }
    setSaving(true);
    try {
      await gitApi.resolveConflict(props.repoPath, props.filePath, cur);
      pushToast(`Resolved ${shortName(props.filePath)}`, "success");
      emitGitRefsChanged();
      props.onResolved();
    } catch (e) {
      pushToast(`Resolve failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setBuffer(null);
    refetch();
  }

  const ours = () => versions()?.ours ?? "";
  const theirs = () => versions()?.theirs ?? "";
  const base = () => versions()?.base ?? null;

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      {/* Header: what we're merging, how far along, and the two global actions. */}
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <GitMerge class="w-4 h-4 text-warning shrink-0" />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-[13px] font-medium truncate">{shortName(props.filePath)}</span>
          <span class="text-[11px] text-muted-foreground truncate">{props.filePath}</span>
        </div>

        <span class="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap">
          {resolved()} of {total()} resolved
        </span>

        <Show when={blocks().length > 0}>
          <div class="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            <button
              onClick={() => step(-1)}
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Previous conflict"
              aria-label="Previous conflict"
            >
              <ChevronUp class="w-3 h-3" />
            </button>
            <span class="px-1 text-[11px] tabular-nums text-muted-foreground">
              {Math.min(cursor() + 1, blocks().length)}/{blocks().length}
            </span>
            <button
              onClick={() => step(1)}
              class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Next conflict"
              aria-label="Next conflict"
            >
              <ChevronDown class="w-3 h-3" />
            </button>
          </div>

          <button
            onClick={() => accept("ours")}
            class="px-2 py-1 rounded bg-info/15 text-info hover:bg-info/25 text-[11px] whitespace-nowrap"
          >
            Accept ours
          </button>
          <button
            onClick={() => accept("theirs")}
            class="px-2 py-1 rounded bg-warning/15 text-warning hover:bg-warning/25 text-[11px] whitespace-nowrap"
          >
            Accept theirs
          </button>
          <button
            onClick={() => accept("both")}
            class="px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25 text-[11px] whitespace-nowrap"
          >
            Accept both
          </button>
        </Show>

        <button
          onClick={reset}
          class="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          title="Reset to the working-tree version"
          aria-label="Reset"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void save()}
          disabled={saving() || blocks().length > 0}
          class="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          <Check class="w-3 h-3" /> Mark resolved &amp; stage
        </button>
      </div>

      <Show
        when={!versions.loading && buffer() !== null}
        fallback={
          <div class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Loading conflict versions…
          </div>
        }
      >
        <div class="flex-1 min-h-0 flex flex-col">
          {/* Top: the three incoming versions. */}
          <div class="flex-1 min-h-0 grid grid-cols-3 divide-x divide-border border-b border-border">
            <MergeColumn label="Ours (current)" tone="info">
              <Show
                when={base() !== null}
                fallback={<MonacoPane text={ours()} path={props.filePath} readOnly />}
              >
                <MonacoDiffPane
                  original={base()!}
                  modified={ours()}
                  path={props.filePath}
                  sideBySide={false}
                  modifiedEditable={false}
                />
              </Show>
            </MergeColumn>

            <MergeColumn label={base() === null ? "Base (unavailable)" : "Base (ancestor)"} tone="muted">
              <Show
                when={base() !== null}
                fallback={
                  <div class="h-full flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                    git recorded no common ancestor for this file, so each side is
                    shown as-is rather than as a diff.
                  </div>
                }
              >
                <MonacoPane text={base()!} path={props.filePath} readOnly />
              </Show>
            </MergeColumn>

            <MergeColumn label="Theirs (incoming)" tone="warning">
              <Show
                when={base() !== null}
                fallback={<MonacoPane text={theirs()} path={props.filePath} readOnly />}
              >
                <MonacoDiffPane
                  original={base()!}
                  modified={theirs()}
                  path={props.filePath}
                  sideBySide={false}
                  modifiedEditable={false}
                />
              </Show>
            </MergeColumn>
          </div>

          {/* Bottom: the result. Editable — accepting a side is a shortcut for
              typing, not a replacement for it. */}
          <div class="flex-[1.2] min-h-0 flex flex-col">
            <div class="flex items-center gap-2 px-3 py-1 border-b border-border/60 shrink-0">
              <span class="text-[10px] tracking-wide text-foreground/80">Result</span>
              <Show when={blocks().length > 0} fallback={
                <span class="text-[10px] text-success">no markers left</span>
              }>
                <span class="text-[10px] text-warning tabular-nums">
                  {blocks().length} conflict marker block{blocks().length === 1 ? "" : "s"} remaining
                </span>
              </Show>
              <Show when={current()}>
                {(block) => (
                  <span class="ml-auto text-[10px] text-muted-foreground tabular-nums">
                    conflict at lines {block().startLine + 1}–{block().endLine + 1}
                  </span>
                )}
              </Show>
            </div>
            <div class="flex-1 min-h-0">
              <MonacoPane
                text={buffer() ?? ""}
                path={props.filePath}
                onChange={(text) => setBuffer(text)}
              />
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function MergeColumn(props: {
  label: string;
  tone: "info" | "warning" | "muted";
  children: JSX.Element;
}) {
  const toneClass = () =>
    props.tone === "info"
      ? "text-info"
      : props.tone === "warning"
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <div class="flex flex-col min-w-0 min-h-0">
      <div class={`px-3 py-1 text-[10px] tracking-wide shrink-0 ${toneClass()}`}>
        {props.label}
      </div>
      <div class="flex-1 min-h-0">{props.children}</div>
    </div>
  );
}

function shortName(p: string): string {
  return p.split("/").pop() ?? p;
}
