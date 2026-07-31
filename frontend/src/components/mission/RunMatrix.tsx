/// The fan-out comparison: N legs side by side, by file.
///
/// The reading order is the design. A person choosing between three branches
/// wants, in this order: *did they agree on what to change*, *where do they
/// differ*, and only then *how big is each one*. So the summary line comes
/// first, the divergent files are called out by name, and the matrix — which is
/// the raw material for both — is collapsed by default. Opening with a grid of
/// checkmarks would be showing the evidence before the finding.
///
/// The suggestion is labelled as a suggestion everywhere it appears. It is a
/// heuristic over line counts and file overlap; presenting it as a judgement
/// about which answer is *correct* would be the same lie as unmarked inferred
/// attribution, and this app has already decided how it feels about that.
import { For, Show, createMemo, createSignal } from "solid-js";
import { Check, ChevronDown, ChevronRight, Minus } from "lucide-solid";
import type { FanoutRun, RunLeg } from "@/store/fanout";
import { comparisonSummary, compareRun, suggestedLeg } from "./compareModel";

export function RunMatrix(props: {
  run: FanoutRun;
  /// Open a leg for reading — a compare tab, in practice.
  onInspect?: (leg: RunLeg) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const comparison = createMemo(() => compareRun(props.run));
  const suggestion = createMemo(() => suggestedLeg(comparison()));

  const legById = (id: string) => props.run.legs.find((l) => l.id === id);

  /// Files where the legs disagree — touched by some but not all. The short
  /// list, and the actual reading assignment.
  const divergent = createMemo(() =>
    comparison().rows.filter((r) => !r.shared && r.touchedBy.length < comparison().columns.length),
  );

  return (
    <div class="mt-2 rounded border border-border/60 bg-card/40 px-2 py-1.5 text-[11px]">
      <p class="text-muted-foreground">{comparisonSummary(comparison())}</p>

      <Show when={comparison().comparable}>
        <Show when={suggestion()}>
          {(id) => (
            <p class="mt-1">
              <span class="text-muted-foreground">Worth reading first: </span>
              <span class="text-foreground">{legById(id())?.agentName}</span>
              <span class="text-muted-foreground">
                {" "}
                — the smallest diff that still touches every file most legs
                changed. A guess from counts, not a verdict.
              </span>
            </p>
          )}
        </Show>

        <Show when={divergent().length > 0}>
          <p class="mt-1 text-muted-foreground">
            Only some legs touched:{" "}
            <For each={divergent().slice(0, 6)}>
              {(row, i) => (
                <>
                  <span class="font-mono text-foreground">{row.path}</span>
                  <span class="text-muted-foreground">
                    {" "}
                    ({row.touchedBy.length}/{comparison().columns.length})
                  </span>
                  {i() < Math.min(divergent().length, 6) - 1 ? ", " : ""}
                </>
              )}
            </For>
            <Show when={divergent().length > 6}>
              {` and ${divergent().length - 6} more`}
            </Show>
          </p>
        </Show>

        <button
          type="button"
          onClick={() => setOpen(!open())}
          aria-expanded={open()}
          class="mt-1 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <Show when={open()} fallback={<ChevronRight class="w-3 h-3" />}>
            <ChevronDown class="w-3 h-3" />
          </Show>
          {open() ? "Hide" : "Show"} the file matrix
          <span class="tabular-nums">
            ({comparison().rows.length} file{comparison().rows.length === 1 ? "" : "s"})
          </span>
        </button>

        <Show when={open()}>
          {/* Its own scroll container: a wide matrix must never make the page
              scroll sideways, and N legs is not bounded. */}
          <div class="mt-1 overflow-x-auto">
            <table class="w-full text-left border-collapse">
              <thead>
                <tr class="text-muted-foreground">
                  <th class="font-normal pb-1 pr-2">File</th>
                  <For each={comparison().columns}>
                    {(column) => (
                      <th class="font-normal pb-1 px-1 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => {
                            const leg = legById(column.legId);
                            if (leg) props.onInspect?.(leg);
                          }}
                          disabled={!props.onInspect}
                          title={`${column.branch} — ${column.files} files, +${column.additions} −${column.deletions}`}
                          class="hover:text-foreground disabled:cursor-default rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {column.agentName}
                          <Show when={column.legId === suggestion()}>
                            <span class="ml-0.5 text-primary" title="Suggested">
                              ★
                            </span>
                          </Show>
                        </button>
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={comparison().rows}>
                  {(row) => (
                    <tr class="border-t border-border/40">
                      <td
                        class="pr-2 py-0.5 font-mono truncate max-w-[280px]"
                        classList={{ "text-foreground": row.shared, "text-muted-foreground": !row.shared }}
                        title={row.path}
                      >
                        {row.path}
                      </td>
                      <For each={comparison().columns}>
                        {(column) => (
                          <td class="px-1 text-center">
                            {/* A tick and a dash rather than a tick and a blank:
                                an empty cell is indistinguishable from a cell
                                that failed to render, and this table is read
                                across rows. */}
                            <Show
                              when={row.touchedBy.includes(column.legId)}
                              fallback={
                                <Minus
                                  class="w-3 h-3 inline text-muted-foreground/40"
                                  aria-label="not touched"
                                />
                              }
                            >
                              <Check
                                class="w-3 h-3 inline text-success"
                                aria-label="touched"
                              />
                            </Show>
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
              <tfoot>
                <tr class="border-t border-border text-muted-foreground">
                  <td class="pr-2 pt-1">Total</td>
                  <For each={comparison().columns}>
                    {(column) => (
                      <td class="px-1 pt-1 text-center whitespace-nowrap tabular-nums">
                        <span class="text-success">+{column.additions}</span>{" "}
                        <span class="text-destructive">−{column.deletions}</span>
                      </td>
                    )}
                  </For>
                </tr>
              </tfoot>
            </table>
          </div>
        </Show>
      </Show>

      {/* Legs with nothing to compare are named rather than omitted. A leg that
          silently vanishes from the comparison reads as one that was never
          started. */}
      <Show when={comparison().unmeasured.length > 0}>
        <p class="mt-1 text-muted-foreground">
          Not in the comparison:{" "}
          <For each={comparison().unmeasured}>
            {(u, i) => (
              <>
                {u.agentName} ({u.status})
                {i() < comparison().unmeasured.length - 1 ? ", " : ""}
              </>
            )}
          </For>
        </p>
      </Show>
    </div>
  );
}
