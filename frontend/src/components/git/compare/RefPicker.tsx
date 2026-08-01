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
  /// The SHA heuristic only runs once the real answer is in.
  ///
  /// `deadbeef`, `accede`, `beaded`, `facade`, `decaf` — all legal branch
  /// names, all matching `/^[0-9a-f]{7,40}$/`. The lookup below settles those
  /// correctly, but the heuristic used to run even while `refs` was still
  /// loading, so a branch named after a hex word opened as a commit dot and
  /// then changed under the user a moment later. Nothing is claimed until
  /// there is something to check against.
  if (!refs) return "unknown";
  if (refs.branches.includes(value)) return "branch";
  if (refs.tags.includes(value)) return "tag";
  if (
    value === "HEAD" ||
    refs.recentCommits.some((c) => c.oid === value || c.shortOid === value)
  ) {
    return "commit";
  }
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
  /// First in the commits section, when there is one.
  ///
  /// A detached HEAD is the one position in a repository no ref names, so it
  /// was unreachable from this picker entirely: mid-bisect, mid-rebase or
  /// after checking out a tag, the commit the user was standing on could only
  /// be compared by typing the word "HEAD" from memory. `HEAD` rather than the
  /// oid as the value, because that is the name that keeps meaning "here" as
  /// the bisect moves.
  const head = refs.detachedHead;
  if (head && (match("HEAD") || match(head.shortOid) || match(head.summary))) {
    out.push({
      kind: "commit",
      label: "HEAD",
      subtitle: `detached at ${head.shortOid} · ${head.summary}`,
      value: "HEAD",
    });
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
  /// What is in the box, which is not the same thing as what the list is
  /// filtered by — see `query` below.
  const [text, setText] = createSignal("");
  const [edited, setEdited] = createSignal(false);
  /// The filter, which stays empty until the user actually types.
  ///
  /// The box opens pre-filled with the current ref so it can be edited rather
  /// than retyped, and filtering on that would have narrowed the dropdown to
  /// the one ref already selected — turning the list the picker exists to
  /// offer into a list of one.
  const query = () => (edited() ? text() : "");
  /// `-1` means "nothing highlighted yet", which is what a freshly opened
  /// picker means. It used to open on `0`, so the first ArrowDown moved to
  /// item *1* and item 0 could only be reached by wrapping all the way around
  /// or by mouse. Enter with nothing highlighted commits the typed text, which
  /// is the other half of the same correction.
  const [highlight, setHighlight] = createSignal(-1);
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
    setText("");
    setEdited(false);
    setHighlight(-1);
    setOpen(false);
  }

  /// Opens with the current ref already in the box, selected.
  ///
  /// It used to open empty, which made the common edit impossible to do by
  /// typing: turning `origin/main` into `origin/main~3`, or fixing one
  /// character of a long branch name, meant retyping the whole thing from
  /// nothing. Selected rather than merely present, so the other common case —
  /// replacing it outright — still costs one keystroke.
  function openPicker() {
    setOpen(true);
    setText(props.value);
    setEdited(false);
    setHighlight(-1);
    queueMicrotask(() => {
      inputRef?.focus();
      inputRef?.select();
    });
  }

  function commitFreeText() {
    const trimmed = text().trim();
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
      // Down to `-1` rather than stopping at 0, so the way back out of the
      // list is the same key that went in — otherwise the first item is a trap
      // and Enter can no longer commit what was typed.
      setHighlight((h) => Math.max(-1, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const list = items();
      if (open() && highlight() >= 0 && highlight() < list.length) {
        commitValue(list[highlight()].value);
      } else {
        commitFreeText();
      }
    } else if (e.key === "Escape") {
      // Stopped, or the same keystroke that closes this dropdown also reaches
      // whatever is behind it — closing the tab the user was mid-edit in.
      // Escape here means "close the picker" and nothing else.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setText("");
      setEdited(false);
      setHighlight(-1);
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
      <label class="block text-micro tracking-wide text-muted-foreground/70 mb-0.5">
        {props.label}
      </label>
      <button
        type="button"
        onClick={openPicker}
        // The arrows only ever reached the search input, which does not exist
        // until the picker is open — so on a closed picker they did nothing at
        // all, and the keyboard route in was Enter or Space only.
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openPicker();
          }
        }}
        class={`flex items-center gap-1.5 w-full px-2 py-1 rounded-md border text-left text-body transition-colors ${
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
        <div class="mt-0.5 text-micro text-destructive truncate" title={props.error ?? ""}>
          {props.error}
        </div>
      </Show>

      <Show when={open()}>
        <div class="absolute z-30 left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-lg max-h-72 overflow-hidden flex flex-col">
          <input
            ref={inputRef}
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setEdited(true);
              setHighlight(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a branch, tag, SHA, or HEAD~N…"
            class="px-2 py-1.5 text-body bg-transparent border-b border-border outline-none placeholder:text-muted-foreground/60"
            aria-label="Search refs"
          />
          <div class="overflow-auto scrollbar-thin">
            <Show
              when={!props.loading}
              fallback={
                <div class="px-3 py-2 text-label text-muted-foreground">Loading refs…</div>
              }
            >
              <Show
                when={items().length > 0}
                fallback={
                  <div class="px-3 py-2 text-label text-muted-foreground">
                    No matches. Press Enter to use “{text()}” as a revision expression.
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
        <div class="px-3 py-0.5 text-micro tracking-wider text-muted-foreground/70">
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
                class={`w-full flex items-center gap-2 px-3 py-1 text-left text-body transition-colors ${
                  active() ? "bg-primary/15 text-primary" : "hover:bg-accent/30"
                }`}
              >
                <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClassFor(props.kind)}`} />
                <Icon class="w-3 h-3 text-muted-foreground shrink-0" />
                <div class="flex-1 min-w-0">
                  <div class="font-mono truncate">{item.label}</div>
                  <Show when={item.subtitle}>
                    <div class="text-micro text-muted-foreground truncate">
                      {item.subtitle}
                    </div>
                  </Show>
                </div>
                <Show when={item.rightChip}>
                  {(chip) => (
                    <span class="flex items-center gap-0.5 text-micro font-mono tabular-nums shrink-0">
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
