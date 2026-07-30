import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import {
  AlertTriangle,
  GitCommitHorizontal,
  Loader2,
  RefreshCw,
  GitBranch,
  Cloud,
  Tag,
} from "lucide-solid";
import { gitApi } from "@/api/git";
import { onGitRefsChanged } from "@/commands/gitEvents";
import type { GraphCommit } from "@/types/history";
import { computeLanes } from "./lanes";

/// Fixed row geometry. Kept dense per MASTER.md — one commit reads as a
/// single tight line with its dot aligned to the row's vertical centre.
const ROW_H = 30;
const COL_W = 16;
const DOT_R = 4;
const PAD_L = 10;
const PAD_R = 10;

/// Lane colours cycle the theme's chart tokens so adjacent lanes stay
/// visually distinct in both light and dark, all from semantic tokens.
const LANE_TOKENS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];
const laneColor = (i: number) => LANE_TOKENS[((i % LANE_TOKENS.length) + LANE_TOKENS.length) % LANE_TOKENS.length];

/// `now` is passed in rather than read from `Date.now()` so the label is a
/// function of a signal and re-renders. Read at render time it was captured
/// once: a graph left open for an hour still said "just now" about everything.
export function relTime(unixSec: number, nowMs: number): string {
  const diff = nowMs / 1000 - unixSec;
  // A commit from the future is a real thing — a skewed clock on a colleague's
  // machine, or a rebase that stamped ahead — and calling it "just now" hid it.
  if (diff < -60) {
    const ahead = Math.round(-diff / 60);
    return ahead < 60 ? `in ${ahead}m` : `in ${Math.round(ahead / 60)}h`;
  }
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  // Calendar-accurate enough for a relative label: 30-day months and 360-day
  // years drifted five days a year, so "11mo ago" could outlive the anniversary.
  const mo = Math.floor(d / 30.44);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365.25)}y ago`;
}

export function CommitGraph(props: {
  repoPath: string;
  /// Opening a commit is wired to the existing commit-diff path (a compare
  /// tab of `<oid>^..<oid>`). Left optional so the graph is reusable.
  /// `parentOids` comes along because the caller needs it to pick a diff base:
  /// a root commit has no `<oid>^` to resolve, and passing only the oid left
  /// every caller to guess.
  onOpenCommit?: (oid: string, parentOids: string[]) => void;
}) {
  const [limit, setLimit] = createSignal(200);

  /// A coarse clock so "3m ago" becomes "4m ago" without a refetch. One
  /// interval for the whole list; the labels are minute-resolution, so a
  /// 30-second tick is already finer than anything it can show.
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(id));
  });

  const [commits, { refetch }] = createResource(
    () => ({ repo: props.repoPath, limit: limit() }),
    ({ repo, limit }) => gitApi.commitGraph(repo, limit),
  );

  // Re-fetch on the same global pulse the rest of the git UI listens to
  // (checkout / commit / fetch all broadcast it), through the shared helper
  // rather than a raw listener — the helper coalesces bursts and carries the
  // `remote` flag that stops cross-window pulses ping-ponging.
  onMount(() => onCleanup(onGitRefsChanged(() => void refetch())));

  /// The rows, or `undefined` — never a throw.
  ///
  /// A Solid resource *rethrows* the fetcher's rejection from `commits()` (and
  /// from `commits.latest`) once it settles. `layout` below reads it inside a
  /// memo, so a repository that moved out from under us, or a single corrupt
  /// ref, threw from inside a reactive computation with no `ErrorBoundary`
  /// above this component anywhere in the tree — and took the whole window to a
  /// white rectangle. The irony is that the "Failed to load commit graph"
  /// branch at the bottom of this file was correct all along and simply
  /// unreachable: the throw happened before anything could render it.
  ///
  /// `commits.error` and `commits.state` are plain signal reads and never
  /// throw. Going through this accessor keeps every read on that safe path.
  const settled = () => (commits.state === "errored" ? undefined : commits());

  const layout = createMemo(() => computeLanes(settled() ?? []));
  /// Uncapped, a history with thirty concurrent lanes produced ~500px of
  /// gutter and squeezed the summary — the thing you actually read — down to
  /// nothing. Beyond this the lanes overlap, which is worse for the graph and
  /// much better for the list.
  const MAX_GUTTER = 180;
  const gutterWidth = createMemo(() =>
    Math.min(MAX_GUTTER, PAD_L + layout().maxCols * COL_W + PAD_R),
  );
  /// Room for the truncation stubs below the last row.
  const svgHeight = createMemo(() => (settled()?.length ?? 0) * ROW_H + ROW_H / 2);
  const x = (col: number) => PAD_L + col * COL_W + COL_W / 2;

  const [selected, setSelected] = createSignal<string | null>(null);

  /// Drop a selection whose commit is gone.
  ///
  /// After an amend, rebase or reset the selected oid no longer exists in the
  /// list. Nothing highlighted, but the signal still held it — so the state was
  /// silently dead, and "which commit am I looking at" had no answer the UI
  /// agreed with.
  createEffect(() => {
    const rows = settled();
    const current = untrack(selected);
    if (!rows || !current) return;
    if (!rows.some((c) => c.oid === current)) setSelected(null);
  });

  function openCommit(c: GraphCommit) {
    setSelected(c.oid);
    props.onOpenCommit?.(c.oid, c.parentOids);
  }

  return (
    <div class="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div class="shrink-0 flex items-center gap-2 px-4 h-9 border-b border-border">
        <GitCommitHorizontal class="w-4 h-4 text-primary shrink-0" />
        <span class="text-[13px] font-medium">Commit graph</span>
        <Show when={settled()}>
          {(rows) => (
            <span class="text-[11px] text-muted-foreground tabular-nums">
              {rows().length} commit{rows().length === 1 ? "" : "s"}
              {/* "of N" is not available — counting the total would mean a
                  second full walk — but saying the window is partial costs
                  nothing and is the part that matters. */}
              <Show when={layout().truncatedLanes.length > 0}>
                <span class="ml-1 opacity-70">(more history below)</span>
              </Show>
            </span>
          )}
        </Show>
        <div class="ml-auto flex items-center gap-1">
          {/* Stays mounted while the larger page loads. Gated on the count
              alone, it vanished the instant the refetch started and came back
              when it finished, flickering on every click. */}
          <Show when={settled()?.length === limit() || (commits.loading && !!settled())}>
            <button
              onClick={() => setLimit((l) => l + 200)}
              disabled={commits.loading}
              class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50 disabled:cursor-default"
              title="Load more history"
            >
              {commits.loading ? "Loading…" : "Load more"}
            </button>
          </Show>
          <button
            onClick={() => void refetch()}
            class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title="Refresh"
            aria-label="Refresh commit graph"
          >
            <RefreshCw class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div class="flex-1 overflow-auto scrollbar-thin">
        {/* `commits.loading` is true for *every* refetch, not just the first
            load — Solid sets the state to "refreshing" and `loading` reports
            it. Gating the whole graph on it meant that clicking "Load more",
            or any `voidlink:refresh-git` pulse from anywhere in the app,
            unmounted the rows, collapsed the container's height, and clamped
            the scroll position to 0. Scrolled to row 380, you were returned to
            the top. Only blank it when there is genuinely nothing to show. */}
        <Show
          when={!commits.loading || settled()}
          fallback={
            <div class="flex items-center justify-center gap-2 py-10 text-muted-foreground text-[12px]">
              <Loader2 class="w-4 h-4 animate-spin" />
              Loading history…
            </div>
          }
        >
          <Show
            when={(settled()?.length ?? 0) > 0}
            fallback={
              // Not the empty state when the fetch failed: an unreadable
              // repository and a repository with no commits are different
              // facts, and until the guard above made this branch reachable at
              // all they would have rendered as the same sentence with a red
              // line under it.
              <Show
                when={!commits.error}
                fallback={
                  <div class="flex flex-col items-center justify-center gap-2 py-16 px-6 text-center">
                    <AlertTriangle class="w-6 h-6 text-destructive opacity-80" />
                    <p class="text-[12px] text-destructive">
                      Failed to load commit graph
                    </p>
                    <p class="text-[11px] font-mono text-muted-foreground break-words">
                      {commits.error instanceof Error
                        ? commits.error.message
                        : String(commits.error)}
                    </p>
                    <button
                      onClick={() => void refetch()}
                      class="mt-1 text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                    >
                      Try again
                    </button>
                  </div>
                }
              >
                <div class="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                  <GitCommitHorizontal class="w-6 h-6 opacity-60" />
                  <p class="text-[12px]">No commits to graph yet.</p>
                </div>
              </Show>
            }
          >
            <div class="relative" style={{ "min-width": "100%" }}>
              {/* Gutter overlay: dots + edges drawn once behind the rows. */}
              <svg
                class="absolute top-0 left-0 pointer-events-none"
                width={gutterWidth()}
                height={svgHeight()}
                style={{ overflow: "visible" }}
              >
                {/* Edges first so dots paint on top. */}
                <For each={layout().rows}>
                  {(row, i) => (
                    <For each={row.segments}>
                      {(seg) => {
                        const y1 = i() * ROW_H + ROW_H / 2;
                        const y2 = (i() + 1) * ROW_H + ROW_H / 2;
                        const xt = x(seg.top);
                        const xb = x(seg.bottom);
                        // Straight verticals stay crisp; shifts use a smooth
                        // S-curve between the two columns.
                        const d =
                          xt === xb
                            ? `M ${xt} ${y1} L ${xb} ${y2}`
                            : `M ${xt} ${y1} C ${xt} ${y1 + ROW_H / 2}, ${xb} ${y2 - ROW_H / 2}, ${xb} ${y2}`;
                        return (
                          <path
                            d={d}
                            fill="none"
                            stroke={laneColor(seg.lane)}
                            stroke-width="1.5"
                            stroke-opacity="0.55"
                          />
                        );
                      }}
                    </For>
                  )}
                </For>
                {/* Lanes that continue into history we did not fetch. Faded
                    to the bottom edge, so a cut-off window looks cut off
                    rather than looking like the history ended. */}
                <For each={layout().truncatedLanes}>
                  {(lane) => {
                    const rows = layout().rows.length;
                    const y1 = (rows - 1) * ROW_H + ROW_H / 2;
                    return (
                      <path
                        d={`M ${x(lane)} ${y1} L ${x(lane)} ${y1 + ROW_H / 2}`}
                        fill="none"
                        stroke={laneColor(lane)}
                        stroke-width="1.5"
                        stroke-opacity="0.25"
                        stroke-dasharray="2 2"
                      />
                    );
                  }}
                </For>
                {/* Dots. */}
                <For each={layout().rows}>
                  {(row, i) => {
                    const cy = i() * ROW_H + ROW_H / 2;
                    const cx = x(row.col);
                    return (
                      <>
                        <Show when={row.commit.isHead}>
                          <circle
                            cx={cx}
                            cy={cy}
                            r={DOT_R + 3}
                            fill="none"
                            stroke="var(--color-primary)"
                            stroke-width="1.5"
                            stroke-opacity="0.5"
                          />
                        </Show>
                        <circle
                          cx={cx}
                          cy={cy}
                          r={DOT_R}
                          fill={row.commit.isHead ? "var(--color-primary)" : laneColor(row.col)}
                          stroke="var(--color-background)"
                          stroke-width="1.5"
                        />
                      </>
                    );
                  }}
                </For>
              </svg>

              {/* Rows: dense one-liners offset past the gutter. */}
              <div role="listbox" aria-label="Commits" style={{ "padding-left": `${gutterWidth()}px` }}>
                <For each={layout().rows}>
                  {(row) => {
                    const c = row.commit;
                    const isSel = () => selected() === c.oid;
                    return (
                      <div
                        role="option"
                        tabindex={0}
                        aria-selected={isSel()}
                        onClick={() => openCommit(c)}
                        // A div with an onClick was unreachable without a
                        // mouse: no role, no tab stop, no key handler.
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openCommit(c);
                          }
                        }}
                        class={`group flex items-center gap-2 pr-4 cursor-pointer border-l-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${
                          isSel()
                            ? "bg-accent/50 border-primary"
                            : "border-transparent hover:bg-accent/30"
                        }`}
                        style={{ height: `${ROW_H}px` }}
                        title={`${c.shortOid} · ${c.summary}`}
                      >
                        <span class="font-mono text-[11px] text-muted-foreground tabular-nums shrink-0 w-[52px]">
                          {c.shortOid}
                        </span>
                        {/* Ref decoration chips. */}
                        <Show when={c.refs.length > 0}>
                          <span class="flex items-center gap-1 shrink-0">
                            <For each={c.refs}>
                              {(ref) => (
                                <RefChip
                                  name={ref.name}
                                  kind={ref.kind}
                                  // Only the chip naming the ref HEAD is on.
                                  // Passing `c.isHead` to every chip painted
                                  // `main`, `origin/main` and `v2.0`
                                  // identically on the HEAD commit, erasing
                                  // the distinction exactly where the user
                                  // most needs it.
                                  isHead={ref.isHead}
                                />
                              )}
                            </For>
                          </span>
                        </Show>
                        <span
                          class={`flex-1 min-w-0 truncate text-[13px] ${
                            isSel() ? "text-foreground" : "text-foreground/90"
                          }`}
                        >
                          {c.summary || <span class="text-muted-foreground italic">(no message)</span>}
                        </span>
                        <span class="shrink-0 text-[11px] text-muted-foreground truncate max-w-[140px] hidden sm:inline">
                          {c.authorName}
                        </span>
                        <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums w-[64px] text-right">
                          {relTime(c.commitTime, now())}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

/// A ref decoration chip.
///
/// The kind now comes from the backend. It used to be guessed with
/// `name.includes("/")`, which made every local `feature/x` a remote and left
/// tags looking exactly like branches — the two things a decoration chip
/// exists to tell apart.
function RefChip(props: {
  name: string;
  kind: "branch" | "remote" | "tag" | "detached";
  isHead: boolean;
}) {
  const tone = () => {
    if (props.isHead) return "bg-primary/15 text-primary border-primary/30";
    if (props.kind === "remote") return "bg-muted/60 text-muted-foreground border-border";
    if (props.kind === "tag") return "bg-warning/10 text-warning border-warning/30";
    return "bg-accent/40 text-accent-foreground border-border";
  };
  return (
    <span
      class={`inline-flex items-center gap-0.5 px-1.5 h-[16px] rounded-full text-[10px] font-medium leading-none border ${tone()}`}
      title={
        props.kind === "detached"
          ? "HEAD is detached at this commit"
          : `${props.kind === "tag" ? "tag" : props.kind === "remote" ? "remote branch" : "branch"} ${props.name}`
      }
    >
      <Show when={props.kind === "remote"} fallback={
        <Show when={props.kind === "tag"} fallback={<GitBranch class="w-2.5 h-2.5 shrink-0" />}>
          <Tag class="w-2.5 h-2.5 shrink-0" />
        </Show>
      }>
        <Cloud class="w-2.5 h-2.5 shrink-0" />
      </Show>
      <span class="max-w-[120px] truncate">{props.name}</span>
    </span>
  );
}
