import { For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-solid";
import { dismissToast, useToasts, type Toast } from "@/commands/toast";

export function ToastViewport() {
  const { toasts } = useToasts();
  /// MASTER §10.10: everything the app surfaces unprompted needs a live region,
  /// or "proactive" only works for sighted users.
  ///
  /// Two regions, not one, because the level is a property of the *toast* and
  /// `aria-live` is a property of the *container*: flipping one region's
  /// politeness as toasts arrive is unreliable in every screen reader, so
  /// failures land in the assertive region and everything else in the polite
  /// one. Both stay mounted and empty at rest — a live region announced only
  /// from the moment it appears is a live region that never announces its first
  /// message.
  const byLevel = (assertive: boolean) =>
    toasts().filter((t) => (t.kind === "error") === assertive);
  return (
    <Portal>
      <div class="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none">
        <div aria-live="polite" aria-atomic="false" class="flex flex-col gap-2">
          <For each={byLevel(false)}>{(t) => <ToastRow toast={t} />}</For>
        </div>
        <div aria-live="assertive" aria-atomic="false" class="flex flex-col gap-2">
          <For each={byLevel(true)}>{(t) => <ToastRow toast={t} />}</For>
        </div>
      </div>
    </Portal>
  );
}

function ToastRow(props: { toast: Toast }) {
  const Icon = () => {
    switch (props.toast.kind) {
      case "success":
        return <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" />;
      case "warning":
        return <AlertTriangle class="w-3.5 h-3.5 text-warning shrink-0" />;
      case "error":
        return <XCircle class="w-3.5 h-3.5 text-destructive shrink-0" />;
      default:
        return <Info class="w-3.5 h-3.5 text-info shrink-0" />;
    }
  };
  // §10.10: anything the app surfaces unprompted needs a live region, and a
  // failure is the one case that may interrupt — `assertive` for errors,
  // `polite` for everything else. A toast that only exists visually is not a
  // notification for a screen-reader user.
  const isFailure = () => props.toast.kind === "error";
  return (
    <div
      role={isFailure() ? "alert" : "status"}
      aria-live={isFailure() ? "assertive" : "polite"}
      class="pointer-events-auto min-w-[240px] max-w-[420px] bg-popover border border-border rounded-md shadow-lg px-3 py-2 flex items-start gap-2 text-xs"
    >
      <Icon />
      <span class="flex-1 leading-snug">{props.toast.message}</span>
      {/* How many times this source has shouted. Rendered only above one, so a
          normal toast is unchanged, and inside the same live region as the
          message so the count is announced with it rather than as a second
          bare number. */}
      <Show when={props.toast.count > 1}>
        <span
          class="shrink-0 self-center px-1 rounded bg-accent/50 text-[10px] font-mono tabular-nums text-muted-foreground"
          aria-label={`${props.toast.count} times`}
        >
          ×{props.toast.count}
        </span>
      </Show>
      <Show when={props.toast.action}>
        {(action) => (
          <button
            onClick={() => {
              dismissToast(props.toast.id);
              action().run();
            }}
            class="shrink-0 px-1.5 py-0.5 rounded border border-border text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {action().label}
          </button>
        )}
      </Show>
      <button
        onClick={() => dismissToast(props.toast.id)}
        aria-label="Dismiss"
        class="p-0.5 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-colors"
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  );
}
