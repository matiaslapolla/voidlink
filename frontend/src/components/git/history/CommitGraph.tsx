import {
  For,
  Show,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { GitCommitHorizontal, Loader2, RefreshCw, GitBranch, Cloud } from "lucide-solid";
import { gitApi } from "@/api/git";
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

function relTime(unixSec: number): string {
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function CommitGraph(props: {
  repoPath: string;
  /// Opening a commit is wired to the existing commit-diff path (a compare
  /// tab of `<oid>^..<oid>`). Left optional so the graph is reusable.
  onOpenCommit?: (oid: string) => void;
}) {
  const [limit, setLimit] = createSignal(200);

  const [commits, { refetch }] = createResource(
    () => ({ repo: props.repoPath, limit: limit() }),
    ({ repo, limit }) => gitApi.commitGraph(repo, limit),
  );

  // Re-fetch on the same global pulse the rest of the git UI listens to
  // (checkout / commit / fetch all broadcast it).
  onMount(() => {
    const handler = () => void refetch();
    window.addEventListener("voidlink:refresh-git", handler);
    onCleanup(() => window.removeEventListener("voidlink:refresh-git", handler));
  });

  const layout = createMemo(() => computeLanes(commits() ?? []));
  const gutterWidth = createMemo(() => PAD_L + layout().maxCols * COL_W + PAD_R);
  const svgHeight = createMemo(() => (commits()?.length ?? 0) * ROW_H);
  const x = (col: number) => PAD_L + col * COL_W + COL_W / 2;

  const [selected, setSelected] = createSignal<string | null>(null);

  function openCommit(c: GraphCommit) {
    setSelected(c.oid);
    props.onOpenCommit?.(c.oid);
  }

  return (
    <div class="flex flex-col h-full bg-background text-foreground">
      {/* Header */}
      <div class="shrink-0 flex items-center gap-2 px-4 h-9 border-b border-border">
        <GitCommitHorizontal class="w-4 h-4 text-primary shrink-0" />
        <span class="text-[13px] font-medium">Commit graph</span>
        <Show when={commits()}>
          <span class="text-[11px] text-muted-foreground tabular-nums">
            {commits()!.length} commit{commits()!.length === 1 ? "" : "s"}
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <Show when={commits()?.length === limit()}>
            <button
              onClick={() => setLimit((l) => l + 200)}
              class="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
              title="Load more history"
            >
              Load more
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
        <Show
          when={!commits.loading}
          fallback={
            <div class="flex items-center justify-center gap-2 py-10 text-muted-foreground text-[12px]">
              <Loader2 class="w-4 h-4 animate-spin" />
              Loading history…
            </div>
          }
        >
          <Show
            when={(commits()?.length ?? 0) > 0}
            fallback={
              <div class="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                <GitCommitHorizontal class="w-6 h-6 opacity-60" />
                <p class="text-[12px]">No commits to graph yet.</p>
              </div>
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
              <div style={{ "padding-left": `${gutterWidth()}px` }}>
                <For each={layout().rows}>
                  {(row) => {
                    const c = row.commit;
                    const isSel = () => selected() === c.oid;
                    return (
                      <div
                        onClick={() => openCommit(c)}
                        class={`group flex items-center gap-2 pr-4 cursor-pointer border-l-2 transition-colors ${
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
                              {(ref) => <RefChip name={ref} isHead={c.isHead} />}
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
                          {relTime(c.authorTime)}
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={commits.error}>
          <div class="px-4 py-3 text-[12px] text-destructive">
            Failed to load commit graph: {String(commits.error)}
          </div>
        </Show>
      </div>
    </div>
  );
}

/// A ref decoration chip. We only get a name from the backend (not a type),
/// so remote-tracking names ("origin/…") are inferred from the slash and
/// styled muted; local/tag names read as branch-ish. See GAPS in the module
/// docs — precise branch-vs-tag typing would need a richer backend payload.
function RefChip(props: { name: string; isHead: boolean }) {
  const isRemote = () => props.name.includes("/");
  return (
    <span
      class={`inline-flex items-center gap-0.5 px-1.5 h-[16px] rounded-full text-[10px] font-medium leading-none border ${
        props.isHead
          ? "bg-primary/15 text-primary border-primary/30"
          : isRemote()
            ? "bg-muted/60 text-muted-foreground border-border"
            : "bg-accent/40 text-accent-foreground border-border"
      }`}
      title={props.name}
    >
      <Show when={isRemote()} fallback={<GitBranch class="w-2.5 h-2.5 shrink-0" />}>
        <Cloud class="w-2.5 h-2.5 shrink-0" />
      </Show>
      <span class="max-w-[120px] truncate">{props.name}</span>
    </span>
  );
}
