import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { Check, Copy } from "lucide-solid";
import { journalApi } from "@/api/journal";
import {
  WINDOW_LABELS,
  checkinProse,
  describeLine,
  summarizeCheckin,
  windowStart,
  type WindowKind,
} from "./checkinModel";

/// The check-in — what happened, in a window, across every repository.
///
/// Basecamp's automatic check-in, answered from the log rather than from
/// people. The question it exists for is "what did the agent do while I was
/// asleep", and it is answerable only because Rust records commits it
/// *observed* rather than commits VoidLink performed.
///
/// It reports and does not summarise. Every line is a count of things that were
/// recorded and every commit subject is quoted verbatim — a check-in that
/// paraphrased would be inventing history, and the copy button exists precisely
/// so a human (or an agent, on request) can do the summarising downstream with
/// the raw material in hand.
interface CheckinSectionProps {
  /// Limit to one workspace. Unset means every workspace, which is the default
  /// and the more useful reading of "what happened".
  workspace?: string;
}

const WINDOWS: WindowKind[] = ["today", "since-yesterday", "week", "cycle"];

export function CheckinSection(props: CheckinSectionProps) {
  const [window, setWindow] = createSignal<WindowKind>("since-yesterday");
  const [copied, setCopied] = createSignal(false);

  const [events] = createResource(
    () => ({ window: window(), workspace: props.workspace }),
    async ({ window: kind, workspace }) => {
      const since = windowStart(kind, Date.now());
      return await journalApi.query({ since, workspace, limit: 5000 });
    },
  );

  const report = createMemo(() =>
    summarizeCheckin(events() ?? [], windowStart(window(), Date.now()), Date.now()),
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(checkinProse(report(), WINDOW_LABELS[window()]));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard permission, or no clipboard. The prose is on screen; a
      // failed copy is not worth a toast that interrupts reading it.
    }
  };

  return (
    <div class="flex flex-col flex-1 min-h-0">
      <div class="flex items-center gap-2 px-3 py-2 shrink-0">
        <div
          class="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5"
          role="group"
          aria-label="Check-in window"
        >
          <For each={WINDOWS}>
            {(kind) => (
              <button
                type="button"
                aria-pressed={window() === kind}
                onClick={() => setWindow(kind)}
                class="px-2 py-1 text-xs rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                classList={{
                  "bg-background text-foreground shadow-sm": window() === kind,
                  "text-muted-foreground hover:text-foreground": window() !== kind,
                }}
              >
                {WINDOW_LABELS[kind]}
              </button>
            )}
          </For>
        </div>
        <div class="flex-1" />
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy this check-in"
          class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Show when={copied()} fallback={<Copy class="w-3 h-3" aria-hidden="true" />}>
            <Check class="w-3 h-3 text-success" aria-hidden="true" />
          </Show>
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        {/* `events.loading` is true for refetches too; this is the only state
            that means "nothing to show yet". Switching windows keeps the
            previous report on screen while the next one loads. */}
        <Show
          when={events() !== undefined}
          fallback={<p class="py-2 text-xs text-muted-foreground">Reading the log…</p>}
        >
          <Show
            when={report().total > 0}
            fallback={
              <p class="py-2 text-xs text-muted-foreground">
                Nothing was recorded in this window. That is an answer, not an error — if you
                expected activity here, check that the repository is open in a workspace.
              </p>
            }
          >
            <For each={report().repos}>
              {(digest) => (
                <section class="py-2">
                  <h3 class="flex items-baseline gap-2 text-xs font-medium text-foreground">
                    <span title={digest.repo}>{digest.label}</span>
                    <Show when={digest.workspace}>
                      <span class="text-[11px] text-muted-foreground">{digest.workspace}</span>
                    </Show>
                  </h3>
                  <ul class="mt-1 space-y-1">
                    <For each={digest.lines}>
                      {(line) => (
                        <li class="text-xs">
                          <span
                            classList={{
                              "text-info": line.actor === "agent",
                              "text-foreground": line.actor !== "agent",
                            }}
                          >
                            {line.name}
                          </span>
                          <span class="text-muted-foreground"> — {describeLine(line)}</span>
                          <Show when={line.commits.length > 0}>
                            <ul class="mt-0.5 ml-3 space-y-0.5">
                              {/* Verbatim. A check-in that paraphrased what was
                                  committed would be inventing history. */}
                              <For each={line.commits}>
                                {(commit) => (
                                  <li class="text-[11px] text-muted-foreground truncate">
                                    “{commit}”
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  );
}
