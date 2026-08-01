/// Find-in-files, rendered.
///
/// All six states of `findInFiles.ts` have a visible form here and none of them
/// animates: every path into this panel is keyboard-initiated (⌘⇧F, Enter,
/// Escape), which MASTER §7.1 budgets at 0ms. The single exception is
/// `animate-pulse` on the results region while a walk is in flight — a
/// functional loop reporting genuinely indeterminate work (§7.3.9), stopped the
/// moment the walk ends.
///
/// Per-file spinners are deliberately absent (§7.5.2): one region-level
/// indication is right, a spinner per row is noise that also lies about which
/// files are being read.

import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { AlertTriangle, Replace, Search, X } from "lucide-solid";
import { fsApi, type SearchError, type SearchMatch, type SearchSummary } from "@/api/fs";
import { pushToast } from "@/commands/toast";
import {
  applyReplacements,
  createFindController,
  describeEmpty,
  describeResults,
  describeTruncated,
  type FindState,
} from "./findInFiles";

export interface FindPanelProps {
  /// Repository root to search. `null` closes the panel down to its empty
  /// state — there is nothing to search without a repo.
  root: () => string | null;
  /// Open a hit. Line and column are 1-based, straight from the walker.
  onOpen: (path: string, line: number, column: number) => void;
  onClose: () => void;
}

export function FindPanel(props: FindPanelProps) {
  const find = createFindController({
    search: (id, root, query, options) => fsApi.searchFiles(id, root, query, options),
    cancel: (id) => fsApi.cancelSearch(id),
  });

  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [replacing, setReplacing] = createSignal(false);
  let queryInput: HTMLInputElement | undefined;

  onMount(() => {
    queryInput?.focus();
    const unlisten = fsApi.onSearchBatch((batch) => find.acceptBatch(batch));
    onCleanup(() => {
      void unlisten.then((fn) => fn());
      find.clear();
    });
  });

  function submit() {
    const root = props.root();
    if (!root) return;
    void find.run(root, query());
  }

  /// Rewrite every match on disk.
  ///
  /// Reads each file fresh and skips any match whose recorded position no
  /// longer holds the searched text — the file may have changed since the walk,
  /// and rewriting blind is how replace-all corrupts a file. The result is
  /// reported honestly, including the skips.
  async function replaceAll() {
    const groups = find.groups();
    if (!groups.length || replacing()) return;
    setReplacing(true);
    let applied = 0;
    let skipped = 0;
    const failed: string[] = [];
    try {
      for (const group of groups) {
        try {
          const text = await fsApi.readFile(group.path);
          const out = applyReplacements(text, group.matches, queryOf(), replacement());
          if (out.applied > 0) await fsApi.writeFile(group.path, out.text);
          applied += out.applied;
          skipped += out.skipped;
        } catch {
          failed.push(group.path);
        }
      }
      const parts = [`Replaced ${applied} ${applied === 1 ? "match" : "matches"}`];
      if (skipped) parts.push(`${skipped} skipped (file changed)`);
      if (failed.length) parts.push(`${failed.length} file(s) failed`);
      pushToast(parts.join(" · "), failed.length ? "warning" : "success");
      submit();
    } finally {
      setReplacing(false);
    }
  }

  /// The query the current results belong to, which is not necessarily what is
  /// in the input box right now.
  function queryOf(): string {
    const s = find.state();
    return s.kind === "idle" ? "" : s.query;
  }

  return (
    <div class="flex flex-col h-full min-h-0 bg-sidebar">
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border/60 shrink-0">
        <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span class="ui-section-label">Search</span>
        <span class="ml-auto" />
        <button
          onClick={props.onClose}
          aria-label="Close search"
          title="Close search"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X class="w-3 h-3" />
        </button>
      </div>

      <div class="px-3 py-2 space-y-2 border-b border-border/60 shrink-0">
        <div class="flex flex-col gap-1">
          <label for="find-query" class="ui-section-label">
            Find in files
          </label>
          <input
            ref={queryInput}
            id="find-query"
            type="text"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
            placeholder="Search this repository"
            class="rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono outline-2 outline-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div class="flex flex-col gap-1">
          <label for="find-replace" class="ui-section-label">
            Replace with
          </label>
          <div class="flex items-center gap-1">
            <input
              id="find-replace"
              type="text"
              value={replacement()}
              onInput={(e) => setReplacement(e.currentTarget.value)}
              class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-label font-mono outline-2 outline-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              onClick={() => void replaceAll()}
              aria-label="Replace across all matches"
              title={
                find.groups().length
                  ? "Replace every match on disk"
                  : "Run a search first — there is nothing to replace"
              }
              aria-disabled={find.groups().length === 0}
              disabled={find.groups().length === 0}
              class="shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Icon slot is reserved at rest, so the pending swap costs no
                  reflow (§7.5.2). */}
              <Replace class="w-3 h-3 shrink-0" classList={{ "animate-spin": replacing() }} />
              All
            </button>
          </div>
        </div>

        <div class="flex flex-wrap gap-1">
          <OptionToggle
            label="Aa"
            title="Match case"
            active={find.options().caseSensitive ?? false}
            onClick={() => {
              find.setOptions({ caseSensitive: !find.options().caseSensitive });
              submit();
            }}
          />
          <OptionToggle
            label="ab"
            title="Whole word"
            active={find.options().wholeWord ?? false}
            onClick={() => {
              find.setOptions({ wholeWord: !find.options().wholeWord });
              submit();
            }}
          />
          <OptionToggle
            label="Ignored"
            title="Include gitignored files"
            active={find.options().includeIgnored ?? false}
            onClick={() => {
              find.setOptions({ includeIgnored: !find.options().includeIgnored });
              submit();
            }}
          />
        </div>
      </div>

      {/* Results region. `aria-live` so the count and the state changes reach a
          screen reader — this panel updates without the user acting (§10.10). */}
      <div
        class="flex-1 min-h-0 overflow-y-auto scrollbar-thin"
        aria-live="polite"
        aria-busy={find.state().kind === "searching"}
      >
        <Show when={find.state().kind !== "idle"}>
          <div
            class="px-3 py-1.5 text-micro text-muted-foreground border-b border-border/40"
            classList={{ "animate-pulse": find.state().kind === "searching" }}
          >
            <Show
              when={find.state().kind === "searching"}
              fallback={<StatusLine state={find.state()} />}
            >
              Searching… {find.matchCount().toLocaleString()} so far
            </Show>
          </div>
        </Show>

        {/* Results stream in while the walk is still running, so this renders
            for `searching` and `results` alike. */}
        <div classList={{ "animate-pulse": find.state().kind === "searching" }}>
          <For each={find.groups()}>
            {(group) => (
              <section>
                <div class="px-3 py-1 text-micro font-mono uppercase tracking-wider text-muted-foreground/80 truncate">
                  {relativePath(group.path, props.root())}
                </div>
                <For each={group.matches}>
                  {(m) => (
                    <MatchRow
                      match={m}
                      onOpen={() => props.onOpen(m.path, m.line, m.column)}
                    />
                  )}
                </For>
              </section>
            )}
          </For>
        </div>

        <Show when={truncatedOf(find.state())}>
          {(summary) => (
            <div class="px-3 py-2 text-label text-warning border-t border-border/40">
              {describeTruncated(summary())}
              <button
                onClick={() => {
                  find.setOptions({ maxResults: (summary().matches ?? 0) * 4 });
                  submit();
                }}
                class="ml-2 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                Keep going
              </button>
            </div>
          )}
        </Show>

        <Show when={errorsOf(find.state())}>
          {(errors) => (
            <div class="px-3 py-2 border-t border-border/40 space-y-1">
              <For each={errors()}>
                {(err) => (
                  <div class="flex items-start gap-1.5 text-label text-destructive">
                    <AlertTriangle class="w-3 h-3 shrink-0 mt-0.5" />
                    <span class="font-mono truncate">{err.path}</span>
                    <span class="text-muted-foreground truncate">{err.message}</span>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

/// The settled states' one line of prose. `searching` is handled inline
/// because its text changes as batches land.
function StatusLine(props: { state: FindState }) {
  return (
    <Switch>
      <Match when={props.state.kind === "error" ? props.state : null}>
        {(err) => <span class="text-destructive">Search failed: {err().message}</span>}
      </Match>
      <Match when={props.state.kind === "empty" ? props.state : null}>
        {(empty) => <span>{describeEmpty(empty().query, empty().summary)}</span>}
      </Match>
      <Match when={props.state.kind === "results" ? props.state : null}>
        {(res) => <span>{describeResults(res().summary)}</span>}
      </Match>
    </Switch>
  );
}

function MatchRow(props: { match: SearchMatch; onOpen: () => void }) {
  const before = () => sliceChars(props.match.preview, 0, props.match.previewColumn - 1);
  const hit = () =>
    sliceChars(
      props.match.preview,
      props.match.previewColumn - 1,
      props.match.previewColumn - 1 + props.match.length,
    );
  const after = () =>
    sliceChars(props.match.preview, props.match.previewColumn - 1 + props.match.length);
  return (
    <button
      onClick={props.onOpen}
      title={`${props.match.path}:${props.match.line}:${props.match.column}`}
      class="w-full text-left flex items-baseline gap-2 px-3 py-0.5 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset transition-colors"
    >
      <span class="w-8 shrink-0 text-right font-mono text-micro tabular-nums text-muted-foreground/70">
        {props.match.line}
      </span>
      <span class="min-w-0 truncate font-mono text-label text-foreground/85">
        {before()}
        {/* One highlight colour, the app's own (§11.5). Never a second. */}
        <span class="bg-primary/15 text-primary rounded">{hit()}</span>
        {after()}
      </span>
    </button>
  );
}

function OptionToggle(props: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.active}
      class={`px-2 py-0.5 rounded border text-micro transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        props.active
          ? "bg-primary/15 border-primary/40 text-primary"
          : "bg-transparent border-border text-muted-foreground hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {props.label}
    </button>
  );
}

/// Character-indexed slice. The preview's `previewColumn` counts characters,
/// and JS string indices are UTF-16 code units.
function sliceChars(text: string, start: number, end?: number): string {
  return [...text].slice(start, end).join("");
}

function relativePath(path: string, root: string | null): string {
  if (!root) return path;
  return path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/// The summary of a completed search, or `null` while one is still running —
/// truncation and errors are only meaningful once the walk has ended.
function summaryOf(state: FindState): SearchSummary | null {
  return state.kind === "results" || state.kind === "empty" ? state.summary : null;
}

function truncatedOf(state: FindState): SearchSummary | null {
  const summary = summaryOf(state);
  return summary?.truncated ? summary : null;
}

function errorsOf(state: FindState): SearchError[] | null {
  const summary = summaryOf(state);
  return summary && summary.errors.length ? summary.errors : null;
}
