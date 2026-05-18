import { Show, createMemo, createResource, createSignal } from "solid-js";
import { For } from "solid-js";
import { Check, GitMerge, RotateCw, Save } from "lucide-solid";
import { gitApi } from "@/api/git";
import { pushToast } from "@/commands/toast";

/// A single parsed conflict block from a working-tree file. `ours` and
/// `theirs` always exist; `base` is only present for diff3-style markers
/// (`|||||||` between the `<<<` and `===`). `startLine` / `endLine` are
/// 0-indexed positions in the raw file so we can splice back accurately.
interface ConflictBlock {
  startLine: number;
  endLine: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

/// Parse `<<<<<<< / ||||||| / ======= / >>>>>>>` markers out of `content`
/// and return both the block metadata and the segmented text so we can
/// render conflict regions distinctly from plain prose.
function parseConflicts(content: string): {
  blocks: ConflictBlock[];
  lines: string[];
} {
  const lines = content.split("\n");
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const startLine = i;
    const oursLabel = lines[i].slice(8).trim();
    const oursStart = i + 1;
    let baseStart: number | null = null;
    let theirsStart: number | null = null;
    let endLine: number | null = null;
    let theirsLabel = "";
    for (let j = oursStart; j < lines.length; j++) {
      if (lines[j].startsWith("|||||||")) baseStart = j + 1;
      else if (lines[j].startsWith("=======")) theirsStart = j + 1;
      else if (lines[j].startsWith(">>>>>>>")) {
        endLine = j;
        theirsLabel = lines[j].slice(8).trim();
        break;
      }
    }
    if (theirsStart === null || endLine === null) {
      // Malformed — give up on this block but skip past `<<<` to avoid
      // an infinite loop.
      i++;
      continue;
    }
    const oursEnd = baseStart !== null ? baseStart - 1 : theirsStart - 1;
    const baseEnd = baseStart !== null ? theirsStart - 1 : null;
    const ours = lines.slice(oursStart, oursEnd).join("\n");
    const base =
      baseStart !== null && baseEnd !== null
        ? lines.slice(baseStart, baseEnd).join("\n")
        : null;
    const theirs = lines.slice(theirsStart, endLine).join("\n");
    blocks.push({
      startLine,
      endLine,
      ours,
      base,
      theirs,
      oursLabel: oursLabel || "ours",
      theirsLabel: theirsLabel || "theirs",
    });
    i = endLine + 1;
  }
  return { blocks, lines };
}

/// Splice `replacement` into `content` from `block.startLine` through
/// `block.endLine` (inclusive). Returns the updated full-file string.
function replaceBlock(
  content: string,
  block: ConflictBlock,
  replacement: string,
): string {
  const lines = content.split("\n");
  const replacementLines = replacement.split("\n");
  // Edge case: if the replacement is the empty string we still want to
  // splice in one empty line so subsequent block offsets stay sane
  // until the next parse. Skipping the splice would be wrong because
  // `endLine - startLine + 1` lines need to go away.
  lines.splice(
    block.startLine,
    block.endLine - block.startLine + 1,
    ...(replacement === "" ? [] : replacementLines),
  );
  return lines.join("\n");
}

interface Props {
  repoPath: string;
  filePath: string;
  workspaceId: string;
  onResolved: () => void;
}

export function ConflictTab(props: Props) {
  const [versions, { refetch }] = createResource(
    () => ({ repo: props.repoPath, file: props.filePath }),
    ({ repo, file }) => gitApi.conflictVersions(repo, file),
  );

  /// Local editable buffer — initialized from the working-tree version
  /// and mutated by the accept buttons. Persists across re-renders so
  /// half-resolved files don't lose user edits.
  const [buffer, setBuffer] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  // Seed the buffer once `versions` loads.
  createMemo(() => {
    const v = versions();
    if (v && buffer() === null) setBuffer(v.working);
  });

  const blocks = createMemo(() => {
    const b = buffer();
    return b !== null ? parseConflicts(b).blocks : [];
  });

  function applyChoice(block: ConflictBlock, choice: "ours" | "theirs" | "both") {
    const cur = buffer();
    if (cur === null) return;
    const replacement =
      choice === "ours"
        ? block.ours
        : choice === "theirs"
          ? block.theirs
          : // "Both" keeps ours first, then theirs — the convention git itself
            // suggests with diff3 markers.
            block.ours + (block.ours.endsWith("\n") || block.ours === "" ? "" : "\n") + block.theirs;
    setBuffer(replaceBlock(cur, block, replacement));
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
      window.dispatchEvent(new CustomEvent("voidlink:refresh-git"));
      props.onResolved();
    } catch (e) {
      pushToast(`Resolve failed: ${e instanceof Error ? e.message : String(e)}`, "error", 6000);
    } finally {
      setSaving(false);
    }
  }

  function shortName(p: string): string {
    return p.split("/").pop() ?? p;
  }

  return (
    <div class="absolute inset-0 flex flex-col bg-background">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <GitMerge class="w-4 h-4 text-warning" />
        <div class="flex flex-col min-w-0 flex-1">
          <span class="text-[13px] font-medium truncate">{shortName(props.filePath)}</span>
          <span class="text-[11px] text-muted-foreground truncate">{props.filePath}</span>
        </div>
        <span class="text-[11px] text-muted-foreground tabular-nums">
          {blocks().length} unresolved
        </span>
        <button
          onClick={() => {
            setBuffer(null);
            refetch();
          }}
          class="p-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
          title="Reset to working-tree version"
          aria-label="Reset"
        >
          <RotateCw class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void save()}
          disabled={saving() || blocks().length > 0}
          class="flex items-center gap-1 px-2 py-1 rounded text-[13px] bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Check class="w-3 h-3" /> Mark resolved & stage
        </button>
      </div>

      <Show
        when={!versions.loading}
        fallback={
          <div class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            Loading conflict versions…
          </div>
        }
      >
        <Show
          when={blocks().length > 0}
          fallback={
            <ResolvedPane
              buffer={buffer() ?? ""}
              onEdit={(v) => setBuffer(v)}
              onSave={() => void save()}
            />
          }
        >
          <div class="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-3">
            <For each={blocks()}>
              {(block, idx) => (
                <ConflictBlockCard
                  index={idx() + 1}
                  total={blocks().length}
                  block={block}
                  onAcceptOurs={() => applyChoice(block, "ours")}
                  onAcceptTheirs={() => applyChoice(block, "theirs")}
                  onAcceptBoth={() => applyChoice(block, "both")}
                />
              )}
            </For>
            <details class="border border-border/50 rounded">
              <summary class="px-3 py-2 text-[12px] text-muted-foreground cursor-pointer hover:bg-accent/30">
                Raw file (advanced — edit conflict markers manually)
              </summary>
              <RawEditor
                buffer={buffer() ?? ""}
                onEdit={(v) => setBuffer(v)}
              />
            </details>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function ConflictBlockCard(props: {
  index: number;
  total: number;
  block: ConflictBlock;
  onAcceptOurs: () => void;
  onAcceptTheirs: () => void;
  onAcceptBoth: () => void;
}) {
  return (
    <div class="border border-border rounded-md overflow-hidden">
      <div class="flex items-center gap-2 px-3 py-1.5 bg-muted/40 border-b border-border text-[11px] text-muted-foreground">
        <span class="font-mono">Conflict {props.index} / {props.total}</span>
        <span class="opacity-60">· lines {props.block.startLine + 1}–{props.block.endLine + 1}</span>
        <span class="flex-1" />
        <button
          onClick={props.onAcceptOurs}
          class="px-2 py-0.5 rounded bg-info/15 text-info hover:bg-info/25 text-[11px]"
        >
          Accept ours
        </button>
        <button
          onClick={props.onAcceptTheirs}
          class="px-2 py-0.5 rounded bg-warning/15 text-warning hover:bg-warning/25 text-[11px]"
        >
          Accept theirs
        </button>
        <button
          onClick={props.onAcceptBoth}
          class="px-2 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25 text-[11px]"
        >
          Accept both
        </button>
      </div>
      <div class="grid grid-cols-2">
        <CodeBlock
          label={`Ours (${props.block.oursLabel})`}
          tone="info"
          text={props.block.ours}
        />
        <CodeBlock
          label={`Theirs (${props.block.theirsLabel})`}
          tone="warning"
          text={props.block.theirs}
        />
      </div>
      <Show when={props.block.base !== null}>
        <div class="border-t border-border/50">
          <CodeBlock label="Common ancestor (base)" tone="muted" text={props.block.base!} />
        </div>
      </Show>
    </div>
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
    <div class="flex flex-col">
      <div class={`px-3 py-1 text-[10px] uppercase tracking-wide ${toneClass()}`}>{props.label}</div>
      <pre class="px-3 pb-2 text-[12px] font-mono whitespace-pre-wrap break-words overflow-x-auto">
        {props.text || "(empty)"}
      </pre>
    </div>
  );
}

function RawEditor(props: { buffer: string; onEdit: (v: string) => void }) {
  return (
    <textarea
      value={props.buffer}
      onInput={(e) => props.onEdit(e.currentTarget.value)}
      spellcheck={false}
      class="w-full min-h-[200px] px-3 py-2 font-mono text-[12px] bg-muted/30 border-t border-border outline-none resize-y"
    />
  );
}

function ResolvedPane(props: { buffer: string; onEdit: (v: string) => void; onSave: () => void }) {
  return (
    <div class="flex-1 flex flex-col">
      <div class="px-3 py-2 text-[12px] text-success border-b border-border bg-success/5 flex items-center gap-2">
        <Save class="w-3.5 h-3.5" />
        All conflict markers resolved. Review the file and stage.
      </div>
      <textarea
        value={props.buffer}
        onInput={(e) => props.onEdit(e.currentTarget.value)}
        spellcheck={false}
        class="flex-1 px-3 py-2 font-mono text-[12px] bg-background outline-none resize-none"
      />
    </div>
  );
}
