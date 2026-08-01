import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from "lucide-solid";
import { dismissToast, useToasts, type Toast } from "@/commands/toast";

/// How long a departing row stays mounted so its exit can render. Must not be
/// shorter than `--dur-short-out`, and is deliberately a little longer so the
/// unmount never truncates the last frames.
const EXIT_HOLD_MS = 200;

/// The toast stack, with the enter and exit MOTION-PLAN F21 found missing.
///
/// **Why the viewport keeps its own list.** `commands/toast.ts` removes a toast
/// from its signal the instant it expires or is dismissed, which is correct —
/// the store's job is what is *true*, and a dismissed toast is not. But a row
/// cannot animate its own departure after it has been unmounted, so the
/// viewport keeps a mirror that retains departed rows for the length of the
/// exit and marks them `leaving`. Nothing about the store changes, and no other
/// consumer of `useToasts()` sees the retained rows.
///
/// **Enter and exit run the same path** (§7.3.11): in from below, out to below.
/// That is not only symmetry for its own sake — it is what makes a future
/// swipe-to-dismiss legible, because the direction the user pushes is already
/// the direction the toast leaves.
///
/// **Transitions, not keyframes** (§7.3.8). Toasts coalesce and retrigger; a
/// keyframe restarts from zero on every retrigger, which is exactly the flicker
/// a coalescing stack must not have.
///
/// The collapse of the vacated slot is a `grid-template-rows: 1fr → 0fr` track
/// (§7.3.2) rather than an animated height, so the rows below slide up instead
/// of jumping when the departing row finally unmounts.
export function ToastViewport() {
  const { toasts } = useToasts();

  /// The mirror: every live toast, plus rows on their way out.
  const [rows, setRows] = createSignal<{ toast: Toast; leaving: boolean }[]>([]);
  const exitTimers = new Map<number, ReturnType<typeof setTimeout>>();

  createEffect(() => {
    const live = toasts();
    const liveIds = new Set(live.map((t) => t.id));
    setRows((prev) => {
      const next: { toast: Toast; leaving: boolean }[] = [];
      // Keep departed rows in their original position — a leaving toast that
      // jumps to the end of the stack on its way out is worse than no exit.
      for (const row of prev) {
        if (liveIds.has(row.toast.id)) continue;
        if (row.leaving) {
          next.push(row);
          continue;
        }
        next.push({ toast: row.toast, leaving: true });
        const handle = setTimeout(() => {
          exitTimers.delete(row.toast.id);
          setRows((cur) => cur.filter((r) => r.toast.id !== row.toast.id));
        }, EXIT_HOLD_MS);
        exitTimers.set(row.toast.id, handle);
      }
      for (const toast of live) {
        // A toast that was leaving and came back (same id, re-pushed) stops
        // leaving. Rare, but the alternative is a row stuck at opacity 0.
        const handle = exitTimers.get(toast.id);
        if (handle !== undefined) {
          clearTimeout(handle);
          exitTimers.delete(toast.id);
        }
        next.push({ toast, leaving: false });
      }
      return next;
    });
  });

  onCleanup(() => {
    for (const handle of exitTimers.values()) clearTimeout(handle);
    exitTimers.clear();
  });

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
  ///
  /// A row on its way out is `aria-hidden`: it has already been announced, and
  /// re-announcing it as the stack settles would say everything twice.
  const byLevel = (assertive: boolean) =>
    rows().filter((r) => (r.toast.kind === "error") === assertive);

  return (
    <Portal>
      <div class="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 pointer-events-none">
        <div aria-live="polite" aria-atomic="false" class="flex flex-col gap-2">
          <For each={byLevel(false)}>
            {(r) => <ToastRow toast={r.toast} leaving={r.leaving} />}
          </For>
        </div>
        <div aria-live="assertive" aria-atomic="false" class="flex flex-col gap-2">
          <For each={byLevel(true)}>
            {(r) => <ToastRow toast={r.toast} leaving={r.leaving} />}
          </For>
        </div>
      </div>
    </Portal>
  );
}

function ToastRow(props: { toast: Toast; leaving: boolean }) {
  /// One frame at the entry values, so the transition has two values to
  /// interpolate between. See `ui/Dialog.tsx` for why this is JavaScript and
  /// not `@starting-style`.
  const [entered, setEntered] = createSignal(false);

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
  /// Off-position: on the way in, and on the way out. One expression, because
  /// §7.3.11's "same path" is exactly the claim that these two are one state.
  const away = () => !entered() || props.leaving;

  return (
    // The collapsing track. Separate from the card because the card is what
    // translates and fades, and one element cannot be both the grid container
    // and the grid item.
    <div
      data-motion="toast-slot"
      class="grid transition-[grid-template-rows] duration-[var(--dur-short-out)] ease-in"
      style={{ "grid-template-rows": props.leaving ? "0fr" : "1fr" }}
      aria-hidden={props.leaving ? "true" : undefined}
    >
      <div class="min-h-0 overflow-hidden">
        <div
          ref={() => requestAnimationFrame(() => setEntered(true))}
          role={isFailure() ? "alert" : "status"}
          aria-live={isFailure() ? "assertive" : "polite"}
          data-motion="toast"
          class={[
            "pointer-events-auto min-w-[240px] max-w-[420px]",
            "bg-popover border border-border rounded-md shadow-lg px-3 py-2",
            "flex items-start gap-2 text-body",
            // §7.1 grants a toast the 5–50×/session budget. In on `--ease-out`
            // at `--dur-short`; out on `--ease-in` at 75% of it (§7.2), because
            // a notice that leaves as slowly as it arrived feels stuck.
            "transition-[opacity,transform]",
            props.leaving
              ? "duration-[var(--dur-short-out)] ease-in"
              : "duration-[var(--dur-short)] ease-out",
          ].join(" ")}
          style={{
            opacity: away() ? 0 : 1,
            // The stack lives in the bottom-right corner, so "the same path"
            // (§7.3.11) is downward at both ends.
            transform: away() ? "translateY(100%)" : "translateY(0)",
          }}
        >
          <Icon />
          <span class="flex-1 leading-snug">{props.toast.message}</span>
          {/* How many times this source has shouted. Rendered only above one, so a
              normal toast is unchanged, and inside the same live region as the
              message so the count is announced with it rather than as a second
              bare number. */}
          <Show when={props.toast.count > 1}>
            <span
              class="shrink-0 self-center px-1 rounded bg-accent/50 text-micro font-mono tabular-nums text-muted-foreground"
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
                data-motion="toast-action"
                class="shrink-0 px-1.5 py-0.5 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-[background-color,color] duration-[var(--dur-tint)] ease-out focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {action().label}
              </button>
            )}
          </Show>
          <button
            onClick={() => dismissToast(props.toast.id)}
            aria-label="Dismiss"
            data-motion="toast-dismiss"
            class="p-0.5 rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
          >
            <X class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
