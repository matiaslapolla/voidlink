/// Find-in-files: the state, separated from the panel that renders it.
///
/// The panel has six states and the interesting ones are not the happy path —
/// searching-with-partial-results, no-matches-naming-the-scope, truncated, and
/// error all have to be distinguishable, and a superseded query must never
/// paint over a newer one. That is a state machine, and a state machine with a
/// `<div>` wrapped around it is untestable, so the machine lives here and takes
/// its transport as an argument.
///
/// Cancellation is the load-bearing part. Every run mints an id; batches
/// arriving with any other id are dropped on the floor. The Rust walk is also
/// told to stop, but that is an optimisation — the walk may already be inside a
/// file read, and correctness cannot depend on it noticing in time.

import { createSignal } from "solid-js";
import type { SearchBatch, SearchMatch, SearchOptions, SearchSummary } from "@/api/fs";

/// The six states of MASTER §7.6 as they apply here. `truncated` is a property
/// of `results`, not a seventh state — the results are real, there are just
/// more of them.
export type FindState =
  /// Nothing asked for yet. The panel shows the query field and nothing else —
  /// specifically *not* a "no results" message, which would be a false
  /// statement about a search that never ran.
  | { kind: "idle" }
  /// Walking. `matches` fills in as batches arrive; the region pulses and the
  /// count updates live rather than waiting for the traversal to end.
  | { kind: "searching"; query: string }
  | { kind: "results"; query: string; summary: SearchSummary }
  | { kind: "empty"; query: string; summary: SearchSummary }
  | { kind: "error"; query: string; message: string };

/// Matches for one file, in the order the walk found them.
export interface FileGroup {
  path: string;
  matches: SearchMatch[];
}

/// The transport, injected so the controller is testable without Tauri.
export interface FindTransport {
  search(
    searchId: string,
    root: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchSummary>;
  cancel(searchId: string): Promise<void>;
}

/// Group matches by file, preserving first-seen order. Pure.
///
/// Grouping here rather than in Rust because batches arrive incrementally and
/// a file's matches can straddle two of them — the grouping has to be over
/// everything received so far, which only the frontend knows.
export function groupByFile(matches: readonly SearchMatch[]): FileGroup[] {
  const byPath = new Map<string, FileGroup>();
  for (const m of matches) {
    let group = byPath.get(m.path);
    if (!group) {
      group = { path: m.path, matches: [] };
      byPath.set(m.path, group);
    }
    group.matches.push(m);
  }
  return [...byPath.values()];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/// The no-match line. MASTER §9.7 forbids a bare "No results": the user needs
/// to know what was searched for and how much was searched, because the usual
/// cause is a scope they did not expect.
export function describeEmpty(query: string, summary: SearchSummary): string {
  return `No matches for "${query}" in ${plural(summary.filesScanned, "file")}`;
}

/// The truncation line, with the real number. Silent truncation reads as
/// "that's all there is", which is the one thing it must not.
export function describeTruncated(summary: SearchSummary): string {
  return `Showing the first ${plural(summary.matches, "match", "matches")} — there are more`;
}

/// Human summary of a completed search, for the results header.
export function describeResults(summary: SearchSummary): string {
  return `${plural(summary.matches, "match", "matches")} in ${plural(
    summary.filesMatched,
    "file",
  )}`;
}

/// Rewrite `text`, replacing each recorded match with `replacement`.
///
/// Matches are applied bottom-up so an earlier replacement of a different
/// length cannot invalidate a later match's column.
///
/// A match whose recorded position no longer holds the text that was found is
/// **skipped**, not force-replaced: the file may have changed between the walk
/// and the click, and rewriting a position blind is how replace-all corrupts a
/// file. The caller reports the skipped count rather than claiming success.
export function applyReplacements(
  text: string,
  matches: readonly SearchMatch[],
  expected: string,
  replacement: string,
): { text: string; applied: number; skipped: number } {
  const lines = text.split("\n");
  let applied = 0;
  let skipped = 0;

  const ordered = [...matches].sort((a, b) => b.line - a.line || b.column - a.column);
  for (const m of ordered) {
    const line = lines[m.line - 1];
    if (line === undefined) {
      skipped += 1;
      continue;
    }
    // Columns are 1-based character offsets; JS string indices are UTF-16 code
    // units, so a line with astral characters needs the array form.
    const chars = [...line];
    const start = m.column - 1;
    const found = chars.slice(start, start + m.length).join("");
    if (found.toLowerCase() !== expected.toLowerCase() || found.length !== expected.length) {
      skipped += 1;
      continue;
    }
    lines[m.line - 1] =
      chars.slice(0, start).join("") + replacement + chars.slice(start + m.length).join("");
    applied += 1;
  }

  return { text: lines.join("\n"), applied, skipped };
}

let idCounter = 0;

export interface FindController {
  state: () => FindState;
  matches: () => SearchMatch[];
  groups: () => FileGroup[];
  /// Live count during a walk; the summary's count once it ends. One accessor
  /// so the header does not have to know which state it is in.
  matchCount: () => number;
  options: () => SearchOptions;
  setOptions: (patch: SearchOptions) => void;
  /// Start a search. Supersedes anything in flight. An empty query returns to
  /// idle rather than searching for nothing.
  run: (root: string, query: string) => Promise<void>;
  /// Re-run the last query — the Retry affordance on the error state.
  retry: () => Promise<void>;
  /// Fold in a streamed batch. Batches for a superseded search are ignored.
  acceptBatch: (batch: SearchBatch) => void;
  /// Back to idle, cancelling anything in flight.
  clear: () => void;
}

export function createFindController(
  transport: FindTransport,
  mintId: () => string = () => `find-${++idCounter}`,
): FindController {
  const [state, setState] = createSignal<FindState>({ kind: "idle" });
  const [matches, setMatches] = createSignal<SearchMatch[]>([]);
  const [options, setOptionsRaw] = createSignal<SearchOptions>({});

  /// The only query whose batches count. `null` means nothing is in flight.
  let activeId: string | null = null;
  let last: { root: string; query: string } | null = null;

  // A plain derivation rather than `createMemo`: the grouping is cheap, and a
  // memo would tie the controller to a reactive owner it does not otherwise
  // need — which is also what lets this be tested outside a component.
  const groups = () => groupByFile(matches());

  const matchCount = () => {
    const s = state();
    if (s.kind === "results" || s.kind === "empty") return s.summary.matches;
    return matches().length;
  };

  function supersede() {
    if (!activeId) return;
    const id = activeId;
    activeId = null;
    void transport.cancel(id).catch(() => {
      // The walk may have finished between the keystroke and this call. Not a
      // failure, and not worth telling the user about.
    });
  }

  async function run(root: string, query: string): Promise<void> {
    supersede();
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches([]);
      setState({ kind: "idle" });
      last = null;
      return;
    }

    last = { root, query: trimmed };
    const id = mintId();
    activeId = id;
    setMatches([]);
    setState({ kind: "searching", query: trimmed });

    try {
      const summary = await transport.search(id, root, trimmed, options());
      // A newer query started while this one was walking. Its results are the
      // ones on screen; this one's summary must not overwrite them.
      if (activeId !== id) return;
      activeId = null;
      if (summary.cancelled) return;
      setState(
        summary.matches === 0
          ? { kind: "empty", query: trimmed, summary }
          : { kind: "results", query: trimmed, summary },
      );
    } catch (e) {
      if (activeId !== id) return;
      activeId = null;
      setState({
        kind: "error",
        query: trimmed,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    state,
    matches,
    groups,
    matchCount,
    options,
    setOptions(patch) {
      setOptionsRaw((cur) => ({ ...cur, ...patch }));
    },
    run,
    retry: () => (last ? run(last.root, last.query) : Promise.resolve()),
    acceptBatch(batch) {
      if (batch.searchId !== activeId) return;
      setMatches((cur) => [...cur, ...batch.matches]);
    },
    clear() {
      supersede();
      setMatches([]);
      setState({ kind: "idle" });
      last = null;
    },
  };
}
