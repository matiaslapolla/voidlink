/// The modal primitive, over the native `<dialog>` element.
///
/// **Why native.** Eight dialogs — `SettingsDialog`, `SnapshotManager`,
/// `BrainOverlay`, `GoToSymbol`, `LspLogDialog`, `NewWorktreeWizard`,
/// `ShortcutsCheatSheet`, `QuickPick` — each put `role="dialog"` on a div and
/// then hand-rolled (or skipped) the four things `showModal()` gives for free
/// (MOTION-PLAN F9): a real focus trap, `inert` on everything behind it,
/// Escape, and a `::backdrop` pseudo-element that is genuinely behind the
/// dialog and in front of everything else without entering the z-index scale
/// at all. Every hand-rolled focus trap in the world has the same bug — it
/// traps `Tab` and not the browser's own focus moves — and MASTER §11 lists
/// "modal without focus trap" as a do-not-ship.
///
/// **The exit is why this is not ten lines.** `close()` removes the element
/// from the top layer on the same frame, so an exit transition on a natively
/// closed dialog never renders. The close path therefore runs the transition
/// first and calls `close()` from its `transitionend` — and `onCancel`
/// (Escape, and the browser's own dismiss) is intercepted for the same reason.
///
/// **Origin is `center`, deliberately.** §7.3.7 makes popovers grow from their
/// trigger and names modals as the one exception: a modal is not *about* the
/// thing that opened it, and growing it from a corner of the screen reads as a
/// panel sliding rather than a surface arriving. §7.1 grants this the full
/// 240ms budget — it is the one surface in the app under 5×/session.
import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { cn } from "./cn";

export interface DialogProps {
  open: boolean;
  /// Called when the dialog wants to close — Escape, the backdrop, or the
  /// close button. The parent owns `open`; this never closes itself, so a
  /// dialog with unsaved work can refuse.
  onClose: () => void;
  /// The accessible name. Rendered into the header, and pointed at by
  /// `aria-labelledby` (§10.5) — passing a title is not optional.
  title: string;
  /// Optional line under the title.
  description?: string;
  /// Rendered at the right of the header row — a search box, a mode toggle.
  headerActions?: JSX.Element;
  /// Rendered as the footer. Omit for dialogs whose only exit is the ×.
  footer?: JSX.Element;
  /// Tailwind width class. `max-w-*` rather than `w-*` so a narrow window
  /// shrinks the dialog instead of clipping it.
  width?: string;
  /// Clicking the backdrop closes. Off for dialogs holding unsaved input,
  /// where a stray click outside would discard it.
  dismissOnBackdrop?: boolean;
  children: JSX.Element;
  class?: string;
  /// Body padding. Panes that scroll their own content pass `"p-0"` and own it.
  bodyClass?: string;
}

/// Kept in sync with `--dur-long-out` in `index.css`. Read from the cascade
/// rather than hardcoded: it is the fallback for a browser that fires no
/// `transitionend` (a dialog closed while its tab was backgrounded, mainly),
/// and a stale literal here would leave a dialog in the top layer forever.
function exitMs(el: Element): number {
  const raw = getComputedStyle(el).getPropertyValue("--dur-long-out").trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 180;
}

export function Dialog(props: DialogProps) {
  let ref: HTMLDialogElement | undefined;
  let closeTimer: number | undefined;
  /// Whether the body is in the DOM. Trails `props.open` by the length of the
  /// exit: unmounting the children the moment `open` goes false would animate
  /// an empty box away, which is worse than not animating at all.
  const [mounted, setMounted] = createSignal(props.open);

  /// Run the exit transition, then actually leave the top layer.
  function startClose(el: HTMLDialogElement) {
    if (!el.open || el.hasAttribute("data-closing")) return;
    el.setAttribute("data-closing", "");
    const finish = () => {
      el.removeAttribute("data-closing");
      if (el.open) el.close();
      setMounted(false);
      if (closeTimer !== undefined) {
        window.clearTimeout(closeTimer);
        closeTimer = undefined;
      }
    };
    el.addEventListener("transitionend", finish, { once: true });
    // Belt and braces. `transitionend` does not fire under
    // `prefers-reduced-motion` (the duration is zeroed to 0ms, and a zero-length
    // transition fires nothing), and it does not fire in a backgrounded tab.
    closeTimer = window.setTimeout(finish, exitMs(el) + 40);
  }

  createEffect(() => {
    const el = ref;
    if (!el) return;
    if (props.open) {
      el.removeAttribute("data-closing");
      setMounted(true);
      if (!el.open) {
        // Two frames, not `@starting-style`. `showModal()` takes the element
        // from `display: none` to `block`, and a transition cannot start from
        // a value that was never computed — `@starting-style` is the CSS
        // answer, but its WebKit floor is higher than this app's stated
        // deployment floor (see MOTION-PLAN §7 on the same problem for View
        // Transitions). Painting one frame at the entry values and clearing
        // the attribute on the next gives the transition its two values with
        // no version gate.
        el.setAttribute("data-entering", "");
        el.showModal();
        requestAnimationFrame(() => el.removeAttribute("data-entering"));
      }
    } else if (el.open) {
      startClose(el);
    }
  });

  onCleanup(() => {
    if (closeTimer !== undefined) window.clearTimeout(closeTimer);
    // A dialog unmounted while open leaves the document `inert` behind it.
    if (ref?.open) ref.close();
  });

  const titleId = `dialog-title-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-motion="dialog"
      // Escape and the browser's own dismiss both arrive as `cancel`. Prevented
      // so the parent decides, and so the exit transition gets to run.
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      // The backdrop is the dialog element's own box outside the panel, so a
      // click that lands on the `<dialog>` rather than on a child is a backdrop
      // click. Pointer-down rather than click, for the same reason `Menu` uses
      // it: a drag that started inside the panel and ended outside is not a
      // dismiss.
      onPointerDown={(e) => {
        if (props.dismissOnBackdrop === false) return;
        if (e.target === ref) props.onClose();
      }}
      class={cn(
        // A `<dialog>` is `position: fixed` with `margin: auto` by default,
        // which centres it — but it also has a UA `max-height` and a border we
        // do not want. Everything below is the reset plus the panel.
        "m-auto max-h-[85vh] w-[92vw] overflow-visible p-0",
        // The heavier weight: a modal is the largest floating surface in the app,
        // and §7.4 asks a bigger surface to read as thicker.
        "border border-border rounded-lg material-structural text-foreground shadow-xl",
        "backdrop:bg-black/50",
        // §7.1's <5×/session budget. `--dur-long` in, `--dur-long-out` (75%)
        // out — a modal that closes as slowly as it opens feels stuck (§7.2).
        "transition-[opacity,transform] duration-[var(--dur-long)] ease-out",
        "backdrop:transition-opacity backdrop:duration-[var(--dur-long)]",
        // Entry values, held for exactly one frame — see `data-entering` above.
        "data-entering:opacity-0 data-entering:scale-[0.96]",
        "data-entering:backdrop:opacity-0",
        // Exit runs the same path in reverse at 75% of the enter (§7.2).
        "data-closing:opacity-0 data-closing:scale-[0.96] data-closing:ease-in",
        "data-closing:duration-[var(--dur-long-out)]",
        "data-closing:backdrop:opacity-0",
        props.width ?? "max-w-[720px]",
        props.class,
      )}
    >
      {/* Mounted only while open — plus the length of the exit — so the body is
          not live in a closed dialog. A settings pane polling git inside a
          dialog nobody opened is the kind of thing that only shows up in a
          profiler. */}
      <Show when={mounted()}>
        <div class="flex flex-col max-h-[85vh]">
          <header class="flex items-start gap-3 px-4 py-3 border-b border-border shrink-0">
            <div class="min-w-0 flex-1">
              <h2 id={titleId} class="text-ui font-semibold truncate">
                {props.title}
              </h2>
              <Show when={props.description}>
                <p class="text-label text-muted-foreground mt-0.5">{props.description}</p>
              </Show>
            </div>
            {props.headerActions}
          </header>
          <div class={cn("flex-1 min-h-0 overflow-y-auto scrollbar-thin", props.bodyClass ?? "p-4")}>
            {props.children}
          </div>
          <Show when={props.footer}>
            <footer class="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
              {props.footer}
            </footer>
          </Show>
        </div>
      </Show>
    </dialog>
  );
}
