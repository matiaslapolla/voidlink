/// The language server's output log.
///
/// What the status segment's `log` click opens, for four of the five states.
/// Deliberately plain: a scrolling list of the lines the server wrote to
/// stderr, newest last, with the binary that produced them named at the top —
/// "which rust-analyzer is this" is the first question anyone asks when
/// completions are wrong, and it is otherwise unanswerable without a terminal.
///
/// No motion. It is opened from a keyboard-adjacent affordance and MASTER §7.1
/// budgets those at 0ms; the only thing it does on open is scroll to the end.

import { For, Show, createEffect, onCleanup, onMount } from "solid-js";

export interface LspLogDialogProps {
  log: () => { server: string; binary: string; lines: string[] } | null;
  onClose: () => void;
}

export function LspLogDialog(props: LspLogDialogProps) {
  let scrollRef: HTMLDivElement | undefined;
  let closeRef: HTMLButtonElement | undefined;

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
    // The dialog opens with focus inside it or the Escape above is the only
    // way out for a keyboard user, and nothing announces it opened.
    closeRef?.focus();
  });

  // Newest lines are the interesting ones; a log that opens at line 1 of 500
  // is a log nobody reads.
  createEffect(() => {
    props.log();
    if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
  });

  return (
    <Show when={props.log()}>
      {(log) => (
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-background/70"
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`${log().server} output log`}
            class="w-[min(52rem,90vw)] h-[min(28rem,80vh)] flex flex-col rounded border border-border bg-elev-3 shadow-lg"
          >
            <div class="flex items-baseline gap-2 px-3 py-2 border-b border-border/60 shrink-0">
              <span class="text-[11px] text-foreground">{log().server}</span>
              <span class="flex-1 truncate font-mono text-[10px] text-muted-foreground/70">
                {log().binary}
              </span>
              <button
                ref={closeRef}
                onClick={props.onClose}
                aria-label="Close the output log"
                class="rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <div ref={scrollRef} class="flex-1 overflow-y-auto scrollbar-thin px-3 py-2">
              <Show
                when={log().lines.length > 0}
                fallback={
                  // Not a bare "No output" (MASTER §9.7): a quiet server is the
                  // healthy case and the line should say so.
                  <p class="text-[11px] text-muted-foreground/70">
                    {log().server} has written nothing to its log. That is the normal
                    state for a server that started cleanly.
                  </p>
                }
              >
                <For each={log().lines}>
                  {(line) => (
                    <p class="font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                      {line}
                    </p>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}
