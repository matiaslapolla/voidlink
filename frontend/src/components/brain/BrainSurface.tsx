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
  /// The repository root of the open project. Its brain lives under
  /// `.voidlink/brain`; empty means no repo is open, which is the one state
  /// this surface cannot do anything useful in.
  repoPath: string;
}

/// Notion-like browse/search view over the open project's brain: a filtered,
/// virtualized entry list on the left and a rendered detail pane on the
/// right, plus a quick "note" capture form.
export function BrainSurface(props: BrainSurfaceProps) {
  const [entries, { refetch }] = createResource(
    () => props.repoPath,
    async (repoPath): Promise<BrainEntry[]> =>
      repoPath ? await brainApi.listEntries(repoPath) : [],
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
    () => (selectedPath() ? { repoPath: props.repoPath, relPath: selectedPath()! } : null),
    async (args): Promise<BrainEntryDetail | null> =>
      args ? await brainApi.readEntry(args.repoPath, args.relPath) : null,
  );

  return (
    <Show
      when={props.repoPath}
      fallback={
        <div class="h-full flex items-center justify-center text-title text-muted-foreground">
          Open a repository to browse its brain.
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
                class="flex-1 bg-transparent text-body focus:outline-none"
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
              class="w-full flex items-center justify-center gap-1 px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            >
              <Plus class="w-3 h-3" /> Quick note
            </button>
          </div>
          <div ref={scrollRef} class="flex-1 overflow-y-auto scrollbar-thin">
            <Show
              when={!entries.loading}
              fallback={<div class="p-3 text-body text-muted-foreground">Loading…</div>}
            >
              <Show
                when={filtered().length > 0}
                fallback={
                  <div class="p-3 text-body text-muted-foreground">
                    {query().trim() || typeFilter()
                      ? "No matching entries."
                      : "No entries yet — capture one with Quick note."}
                  </div>
                }
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
                                    class={`text-micro capitalize tracking-wide shrink-0 ${TYPE_COLORS[e().entryType]}`}
                                  >
                                    {e().entryType}
                                  </span>
                                  <span class="truncate text-body font-medium">{e().title}</span>
                                </div>
                                <div class="mt-0.5 text-micro text-muted-foreground truncate">
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
                repoPath={props.repoPath}
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
                <div class="h-full flex items-center justify-center text-title text-muted-foreground">
                  Select an entry to read it.
                </div>
              }
            >
              {(d) => (
                <div class="mx-auto max-w-[860px] px-10 py-8">
                  <div class="flex items-center gap-2 mb-1">
                    <span class={`text-micro capitalize tracking-wide ${TYPE_COLORS[d().entryType]}`}>
                      {d().entryType}
                    </span>
                    <Show when={d().project}>
                      {(p) => <span class="text-label text-muted-foreground">{p()}</span>}
                    </Show>
                  </div>
                  <h1 class="text-heading font-semibold mb-1">{d().title}</h1>
                  <div class="flex flex-wrap items-center gap-1.5 mb-6 text-label text-muted-foreground">
                    <Show when={d().created}>{(c) => <span>{c()}</span>}</Show>
                    <For each={d().labels}>
                      {(l) => <span class="px-1.5 py-0.5 rounded bg-muted/60">{l}</span>}
                    </For>
                  </div>
                  <div
                    class="markdown-body text-title leading-[1.7] text-foreground"
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
      class={`px-2 py-0.5 rounded text-micro border transition-colors ${
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
// The one write path. It creates a `note` — the type that needs no project or
// ticket to make sense, since the project is already implied by which repo's
// brain you are writing into. The other five folders are read if something
// puts entries there, but nothing in the app authors them yet.

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
  repoPath: string;
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
      await brainApi.saveEntry(props.repoPath, `notes/${id}.md`, content);
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
      <h2 class="text-title font-semibold">Quick note</h2>
      <input
        type="text"
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        placeholder="Title"
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-title focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <textarea
        value={body()}
        onInput={(e) => setBody(e.currentTarget.value)}
        placeholder="Body (markdown)"
        rows={8}
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-title font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
      />
      <input
        type="text"
        value={labelsInput()}
        onInput={(e) => setLabelsInput(e.currentTarget.value)}
        placeholder="Labels, comma-separated (at least one)"
        class="w-full rounded border border-border bg-muted/40 px-2 py-1.5 text-title focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <div class="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={saving()}
          class="px-3 py-1 rounded bg-primary text-primary-foreground text-body hover:bg-primary/90 disabled:opacity-50"
        >
          {saving() ? "Saving…" : "Save"}
        </button>
        <button
          onClick={props.onCancel}
          class="px-3 py-1 rounded text-body text-muted-foreground hover:text-foreground hover:bg-accent/40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
