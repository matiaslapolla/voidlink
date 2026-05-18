import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { AlertTriangle, X } from "lucide-solid";
import type { SecretFinding } from "@/commands/secretScan";

export function SecretScanDialog(props: {
  findings: SecretFinding[];
  onCancel: () => void;
  onCommitAnyway: () => void;
}) {
  return (
    <Show when={props.findings.length > 0}>
      <Portal>
        <div
          class="fixed inset-0 z-[90] flex items-center justify-center bg-black/60"
          onClick={props.onCancel}
        >
          <div
            class="w-[560px] max-w-[92vw] bg-popover border border-destructive/40 rounded-lg shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
              <div class="flex items-start gap-2.5 min-w-0">
                <AlertTriangle class="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div class="min-w-0">
                  <h2 class="text-sm font-semibold">Possible secrets in staged changes</h2>
                  <p class="text-xs text-muted-foreground mt-0.5">
                    Review before committing. Once pushed, treat any exposed value as
                    compromised — rotate it immediately.
                  </p>
                </div>
              </div>
              <button
                onClick={props.onCancel}
                aria-label="Cancel"
                class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X class="w-3.5 h-3.5" />
              </button>
            </div>
            <div class="max-h-[48vh] overflow-y-auto scrollbar-thin px-4 py-3 space-y-2">
              <For each={props.findings}>
                {(f) => (
                  <div class="text-xs border border-border/60 rounded-md p-2.5 bg-muted/20">
                    <div class="flex items-center gap-2">
                      <span class="text-destructive font-medium">{f.rule}</span>
                      <span class="text-muted-foreground/70 truncate">
                        {f.file}:{f.line}
                      </span>
                    </div>
                    <pre class="mt-1.5 font-mono text-[11px] text-foreground/85 whitespace-pre-wrap break-all">
                      {f.preview}
                    </pre>
                  </div>
                )}
              </For>
            </div>
            <div class="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
              <button
                onClick={props.onCancel}
                class="px-3 py-1.5 rounded text-xs font-medium border border-border hover:bg-accent/40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={props.onCommitAnyway}
                class="px-3 py-1.5 rounded text-xs font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                Commit anyway
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
