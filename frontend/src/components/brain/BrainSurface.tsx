import { For, Show, createMemo, createResource, createSignal, type JSX } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { Search, Plus } from "lucide-solid";
import { brainApi } from "@/api/brain";
import type { BrainEntry, BrainEntryDetail, BrainEntryType } from "@/types/brain";
import { renderMarkdown } from "@/components/preview/markdown";
import { pushToast } from "@/commands/toast";

const ENTRY_TYPES: BrainEntryType[] = [
  "decision",
  "shipped",
  "note",
  "discovery",
  "content",
  "training",
];

const TYPE_COLORS: Record<BrainEntryType, string> = {
  decision: "text-primary",
  shipped: "text-success",
  discovery: "text-info",
  content: "text-warning",
  note: "text-muted-foreground",
  training: "text-muted-foreground",
};

// Adapted from FileFinder.tsx's fuzzyScore — substring match ranks by
// position, otherwise a subsequence match ranks by how spread out it is.
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return 1000 - idx;
  let score = 0;
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;
    score -= found - ti;
    ti = found + 1;
  }
  return 100 + score;
}

interface BrainSurfaceProps {
  vaultPath: string;
}

/// Notion-like browse/search view over the local brain-kb vault: a filtered,
/// virtualized entry list on the left and a rendered detail pane on the
/// right, plus a quick "note" capture form (the one type simple enough to
/// author from the UI without the CLI's project/ticket validation).
export function BrainSurface(props: BrainSurfaceProps) {
  const [entries, { refetch }] = createResource(
    () => props.vaultPath,
    async (vaultPath): Promise<BrainEntry[]> =>
      vaultPath ? await brainApi.listEntries(vaultPath) : [],
  );

  const [query, setQuery] = createSignal("");
  const [typeFilter, setTypeFilter] = createSignal<BrainEntryType | null>(null);
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const [composing, setComposing] = createSignal(false);

  const filtered = createMemo(() => {
    const list = entries() ?? [];
    const q = query().trim();
    const type = typeFilter();
    return list
      .filter((e) => (type ? e.entryType === type : true))
      .map((e) => ({
        entry: e,
        score: q ? fuzzyScore(`${e.title} ${e.labels.join(" ")} ${e.project ?? ""}`, q) : 0,
      }))
      .filter((r) => r.score >= 0)
      .sort((a, b) =>
        q ? b.score - a.score : (b.entry.created ?? "").localeCompare(a.entry.created ?? ""),
      )
      .map((r) => r.entry);
  });

  let scrollRef: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return filtered().length;
    },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => 52,
    overscan: 12,
  });

  const [detail] = createResource(
    () => (selectedPath() ? { vaultPath: props.vaultPath, relPath: selectedPath()! } : null),
    async (args): Promise<BrainEntryDetail | null> =>
      args ? await brainApi.readEntry(args.vaultPath, args.relPath) : null,
  );

  return (
    <Show
      when={props.vaultPath}
      fallback={
        <div class="h-full flex items-center justify-center text-sm text-muted-foreground">
          Set a vault path in Settings → Brain to browse your second brain.
        </div>
      }
    >
      <div class="h-full flex">
        <div class="w-[320px] shrink-0 border-r border-border flex flex-col">
          <div class="p-2 border-b border-border space-y-2">
            <div class="flex items-center gap-1.5 rounded border border-border bg-muted/40 px-2 py-1">
              <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                placeholder="Search entries…"
                class="flex-1 bg-transparent text-xs focus:outline-none"
              />
            </div>
            <div class="flex flex-wrap gap-1">
              <FilterChip active={typeFilter() === null} onClick={() => setTypeFilter(null)}>
                All
              </FilterChip>
              <For each={ENTRY_TYPES}>
                {(t) => (
                  <FilterChip active={typeFilter() === t} onClick={() => setTypeFilter(t)}>
                    {t}
                  </FilterChip>
                )}
              </For>
            </div>
            <button
              onClick={() => setComposing(true)}
              class="w-full flex items-center justify-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            >
              <Plus class="w-3 h-3" /> Quick note
            </button>
          </div>
          <div ref={scrollRef} class="flex-1 overflow-y-auto scrollbar-thin">
            <Show
              when={!entries.loading}
              fallback={<div class="p-3 text-xs text-muted-foreground">Loading…</div>}
            >
              <Show
                when={filtered().length > 0}
                fallback={<div class="p-3 text-xs text-muted-foreground">No entries.</div>}
              >
                <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
                  <For each={virtualizer.getVirtualItems()}>
                    {(vi) => {
                      const entry = () => filtered()[vi.index];
                      return (
                        <div
                          data-index={vi.index}
                          ref={virtualizer.measureElement}
                          class="absolute left-0 top-0 w-full"
                          style={{ transform: `translateY(${vi.start}px)` }}
                        >
                          <Show when={entry()}>
                            {(e) => (
                              <button
                                onClick={() => setSelectedPath(e().path)}
                                class={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-accent/30 transition-colors ${
                                  selectedPath() === e().path ? "bg-accent/40" : ""
                                }`}
                              >
                                <div class="flex items-center gap-1.5">
                                  <span
                                    class={`text-[10px] capitalize tracking-wide shrink-0 ${TYPE_COLORS[e().entryType]}`}
                                  >
                                    {e().entryType}
                                  </span>
                                  <span class="truncate text-[12px] font-medium">{e().title}</span>
                                </div>
                                <div class="mt-0.5 text-[10px] text-muted-foreground truncate">
                                  {e().project ?? (e().labels.length > 0 ? e().labels.join(", ") : "—")}
                                </div>
                              </button>
                            )}
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </div>

        <div class="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
          <Show
            when={!composing()}
            fallback={
              <QuickNoteForm
                vaultPath={props.vaultPath}
                existing={entries() ?? []}
                onDone={() => {
                  setComposing(false);
                  void refetch();
                }}
                onCancel={() => setComposing(false)}
              />
            }
          >
            <Show
              when={detail()}
              fallback={
                <div class="h-full flex items-center justify-center text-sm text-muted-foreground">
                  Select an entry to read it.
                </div>
              }
            >
              {(d) => (
                <div class="mx-auto max-w-[860px] px-10 py-8">
                  <div class="flex items-center gap-2 mb-1">
                    <span class={`text-[10px] capitalize tracking-wide ${TYPE_COLORS[d().entryType]}`}>
                      {d().entryType}
                    </span>
                    <Show when={d().project}>
                      {(p) => <span class="text-[11px] text-muted-foreground">{p()}</span>}
                    </Show>
                  </div>
                  <h1 class="text-xl font-semibold mb-1">{d().title}</h1>
                  <div class="flex flex-wrap items-center gap-1.5 mb-6 text-[11px] text-muted-foreground">
                    <Show when={d().created}>{(c) => <span>{c()}</span>}</Show>
                    <For each={d().labels}>
                      {(l) => <span class="px-1.5 py-0.5 rounded bg-muted/60">{l}</span>}
                    </For>
                  </div>
                  <div
                    class="markdown-body text-[14px] leading-[1.7] text-foreground"
                    innerHTML={renderMarkdown(d().body)}
                  />
                </div>
              )}
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function FilterChip(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      onClick={props.onClick}
      class={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
        props.active
          ? "border-primary/40 bg-primary/15 text-primary"
          : "border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {props.children}
    </button>
  );
}

// ─── Quick note capture ──────────────────────────────────────────────────────
//
// Mirrors @brain/core's slug/makeId/buildFrontmatter for the `note` type only
// (title + body + labels, no project/ticket to validate). Kept in sync by
// hand — this is a deliberately narrow client-side copy, not the contract's
// source of truth; the CLI (which owns @brain/core) remains the only path for
// the other five entry types.

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stampCreatedISO(): string {
  const OFFSET_MS = -3 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + OFFSET_MS);
  return shifted.toISOString().replace(/Z$/, "-03:00");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function resolveNoteId(baseId: string, existing: BrainEntry[]): string {
  const taken = new Set(existing.filter((e) => e.entryType === "note").map((e) => e.id));
  if (!taken.has(baseId)) return baseId;
  let n = 2;
  while (taken.has(`${baseId}-${n}`)) n++;
  return `${baseId}-${n}`;
}

function buildNoteMarkdown(
  title: string,
  body: string,
  labels: string[],
  id: string,
  createdISO: string,
): string {
  const lines = ["---", `id: ${id}`, "type: note", `title: ${yamlQuote(title)}`];
  if (labels.length > 0) {
    lines.push(`labels: [${labels.map(yamlQuote).join(", ")}]`);
  }
  lines.push(`created: ${yamlQuote(createdISO)}`);
  lines.push("links:");
  for (const l of labels) lines.push(`  - "[[labels/${l}]]"`);
  lines.push("---");
  return `${lines.join("\n")}\n${body}\n`;
}

function QuickNoteForm(props: {
  vaultPath: string;
  existing: BrainEntry[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = createSignal("");
  const [body, setBody] = createSignal("");
  const [labelsInput, setLabelsInput] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  const submit = async () => {
    const t = title().trim();
    const labels = labelsInput()
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!t || labels.length === 0) {
      pushToast("Title and at least one label are required.", "error");
      return;
    }
    setSaving(true);
    try {
      const createdISO = stampCreatedISO();
      const baseId = `${createdISO.slice(0, 10)}-${slug(t)}`;
      const id = resolveNoteId(baseId, props.existing);
      const content = buildNoteMarkdown(t, body(), labels, id, createdISO);
      await brainApi.saveEntry(props.vaultPath, `notes/${id}.md`, content, `register: note ${id}`);
      pushToast(`Saved ${id}`, "success");
      props.onDone();
    } catch (e) {
      pushToast(`Failed to save: ${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="mx-auto max-w-[640px] px-10 py-8 space-y-3">
      <h2 class="text-sm font-semibold">Quick note</h2>
      <input
        type="text"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Title"
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <textarea
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
        placeholder="Body (markdown)"
        rows={8}
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
      />
      <input
        type="text"
        value={labelsInput()}
        onInput={(e) => setLabelsInput(e.currentTarget.value)}
        placeholder="Labels, comma-separated (at least one)"
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div class="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={saving()}
          class="px-3 py-1 rounded bg-primary text-primary-foreground text-xs hover:bg-primary/90 disabled:opacity-50"
        >
          {saving() ? "Saving…" : "Save"}
        </button>
        <button
          onClick={props.onCancel}
          class="px-3 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
