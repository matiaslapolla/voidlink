import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ChevronDown, GitBranch, GitCommit, Tag } from "lucide-solid";
import type { RefList } from "@/types/git";

// Combobox-style ref picker: typeable input with a dropdown of branches,
// tags, and recent commits. Free text is accepted on Enter, so revision
// expressions (`HEAD~3`, `origin/main^`) work without being in the list.
//
// Visual contract: a colored dot indicates ref kind for the selected value
// (branch=primary, tag=warning, commit=info). Sections in the dropdown are
// labeled and show inline metadata.

type RefKind = "branch" | "tag" | "commit" | "unknown";

type Props = {
  label: string;
  value: string;
  refs: RefList | null;
  loading?: boolean;
  error?: string | null;
  onChange: (value: string) => void;
  // Optional: highlight that this field rejected the user's last input.
  invalid?: boolean;
  /// Optional MRU branch list to sort the Branches section by. Order in
  /// the array is descending recency. Branches not in `mru` fall to the
  /// end alphabetically.
  mruBranches?: string[];
  /// Optional per-branch ahead/behind chips shown inline in the
  /// Branches section. Keyed by branch name.
  branchMeta?: Record<string, { ahead: number; behind: number }>;
};

interface DropdownItem {
  kind: RefKind;
  label: string;
  // Sub-line shown beneath the label.
  subtitle?: string;
  // The string we actually pass back through onChange.
  value: string;
  /// Optional inline chip rendered to the right (used for ↑/↓ counts).
  rightChip?: { ahead: number; behind: number };
}

function classifyRef(value: string, refs: RefList | null): RefKind {
  if (!value) return "unknown";
  if (refs) {
    if (refs.branches.includes(value)) return "branch";
    if (refs.tags.includes(value)) return "tag";
    if (refs.recentCommits.some((c) => c.oid === value || c.shortOid === value))
      return "commit";
  }
  // Heuristic for SHA-ish strings.
  if (/^[0-9a-f]{7,40}$/i.test(value)) return "commit";
  return "unknown";
}

function relativeTime(epochSeconds: number): string {
  const now = Date.now() / 1000;
  const diff = now - epochSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

function buildItems(
  refs: RefList | null,
  query: string,
  mruBranches?: string[],
  branchMeta?: Record<string, { ahead: number; behind: number }>,
): DropdownItem[] {
  if (!refs) return [];
  const q = query.toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);

  const order = new Map<string, number>();
  (mruBranches ?? []).forEach((b, i) => order.set(b, i));

  const branchItems: DropdownItem[] = refs.branches
    .filter(match)
    .map((b) => ({
      kind: "branch" as const,
      label: b,
      value: b,
      rightChip: branchMeta?.[b],
    }))
    .sort((a, b) => {
      const ai = order.has(a.label) ? order.get(a.label)! : Number.POSITIVE_INFINITY;
      const bi = order.has(b.label) ? order.get(b.label)! : Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label);
    });

  const out: DropdownItem[] = [...branchItems];
  for (const t of refs.tags) {
    if (match(t)) out.push({ kind: "tag", label: t, value: t });
  }
  for (const c of refs.recentCommits) {
    if (match(c.shortOid) || match(c.summary)) {
      out.push({
        kind: "commit",
        label: c.shortOid,
        subtitle: `${c.summary} · ${relativeTime(c.time)}`,
        value: c.oid,
      });
    }
  }
  return out;
}

function dotClassFor(kind: RefKind): string {
  switch (kind) {
    case "branch":
      return "bg-primary";
    case "tag":
      return "bg-warning";
    case "commit":
      return "bg-info";
    default:
      return "bg-muted-foreground/40";
  }
}

function iconFor(kind: RefKind) {
  switch (kind) {
    case "branch":
      return GitBranch;
    case "tag":
      return Tag;
    case "commit":
      return GitCommit;
    default:
      return GitBranch;
  }
}

export function RefPicker(props: Props) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  let containerRef: HTMLDivElement | undefined;
  let inputRef: HTMLInputElement | undefined;

  const kind = createMemo(() => classifyRef(props.value, props.refs));

  const items = createMemo(() =>
    buildItems(props.refs, query(), props.mruBranches, props.branchMeta),
  );

  // Group items for display.
  const grouped = createMemo(() => {
    const list = items();
    return {
      branches: list.filter((i) => i.kind === "branch"),
      tags: list.filter((i) => i.kind === "tag"),
      commits: list.filter((i) => i.kind === "commit"),
    };
  });

  function commitValue(value: string) {
    props.onChange(value);
    setQuery("");
    setOpen(false);
  }

  function commitFreeText() {
    const trimmed = query().trim();
    if (trimmed) commitValue(trimmed);
    else setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(items().length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const list = items();
      if (open() && list.length > 0 && highlight() < list.length) {
        commitValue(list[highlight()].value);
      } else {
        commitFreeText();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  // Close on outside click.
  onMount(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef && !containerRef.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  return (
    <div ref={containerRef} class="relative flex-1 min-w-0">
      <label class="block text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-0.5">
        {props.label}
      </label>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setQuery("");
          setHighlight(0);
          queueMicrotask(() => inputRef?.focus());
        }}
        class={`flex items-center gap-1.5 w-full px-2 py-1 rounded-md border text-left text-[12px] transition-colors ${
          props.invalid
            ? "border-destructive/60 bg-destructive/5"
            : open()
              ? "border-primary/50 bg-background"
              : "border-border bg-background/60 hover:border-border/80"
        }`}
        aria-haspopup="listbox"
        aria-expanded={open()}
      >
        <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClassFor(kind())}`} />
        <Dynamic component={iconFor(kind())} class="w-3 h-3 text-muted-foreground shrink-0" />
        <span class="flex-1 truncate font-mono">
          <Show when={props.value} fallback={<span class="text-muted-foreground/60">Pick a ref…</span>}>
            {props.value}
          </Show>
        </span>
        <ChevronDown class="w-3 h-3 text-muted-foreground shrink-0" />
      </button>

      <Show when={props.error}>
        <div class="mt-0.5 text-[10px] text-destructive truncate" title={props.error ?? ""}>
          {props.error}
        </div>
      </Show>

      <Show when={open()}>
        <div class="absolute z-30 left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-lg max-h-72 overflow-hidden flex flex-col">
          <input
            ref={inputRef}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setHighlight(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a branch, tag, SHA, or HEAD~N…"
            class="px-2 py-1.5 text-[12px] bg-transparent border-b border-border outline-none placeholder:text-muted-foreground/60"
            aria-label="Search refs"
          />
          <div class="overflow-auto scrollbar-thin">
            <Show
              when={!props.loading}
              fallback={
                <div class="px-3 py-2 text-[11px] text-muted-foreground">Loading refs…</div>
              }
            >
              <Show
                when={items().length > 0}
                fallback={
                  <div class="px-3 py-2 text-[11px] text-muted-foreground">
                    No matches. Press Enter to use “{query()}” as a revision expression.
                  </div>
                }
              >
                <RefSection title="Branches" kind="branch" items={grouped().branches} highlightIndex={highlight()} startIndex={0} onPick={commitValue} />
                <RefSection
                  title="Tags"
                  kind="tag"
                  items={grouped().tags}
                  highlightIndex={highlight()}
                  startIndex={grouped().branches.length}
                  onPick={commitValue}
                />
                <RefSection
                  title="Recent commits"
                  kind="commit"
                  items={grouped().commits}
                  highlightIndex={highlight()}
                  startIndex={grouped().branches.length + grouped().tags.length}
                  onPick={commitValue}
                />
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function RefSection(props: {
  title: string;
  kind: RefKind;
  items: DropdownItem[];
  highlightIndex: number;
  startIndex: number;
  onPick: (value: string) => void;
}) {
  const Icon = iconFor(props.kind);
  return (
    <Show when={props.items.length > 0}>
      <div class="py-1">
        <div class="px-3 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {props.title}
        </div>
        <For each={props.items}>
          {(item, idx) => {
            const absIndex = () => props.startIndex + idx();
            const active = () => absIndex() === props.highlightIndex;
            return (
              <button
                type="button"
                onClick={() => props.onPick(item.value)}
                class={`w-full flex items-center gap-2 px-3 py-1 text-left text-[12px] transition-colors ${
                  active() ? "bg-primary/15 text-primary" : "hover:bg-accent/30"
                }`}
              >
                <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClassFor(props.kind)}`} />
                <Icon class="w-3 h-3 text-muted-foreground shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="font-mono truncate">{item.label}</div>
                  <Show when={item.subtitle}>
                    <div class="text-[10px] text-muted-foreground truncate">
                      {item.subtitle}
                    </div>
                  </Show>
                </div>
                <Show when={item.rightChip}>
                  {(chip) => (
                    <span class="flex items-center gap-0.5 text-[10px] font-mono tabular-nums shrink-0">
                      <Show when={chip().ahead > 0}>
                        <span class="text-success">↑{chip().ahead}</span>
                      </Show>
                      <Show when={chip().behind > 0}>
                        <span class="text-destructive">↓{chip().behind}</span>
                      </Show>
                    </span>
                  )}
                </Show>
              </button>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
