/// The "Attach to main window" control every detached window draws in its own
/// chrome.
///
/// One component rather than three copies of a button, for the same reason
/// `SidebarDock` is one module: the panel windows, the editor window and the
/// git window are three windows with one affordance, and three copies would be
/// three labels to keep in step.
///
/// It is a labelled button, not an icon: §7.6 asks a control to say what it
/// does, and an arrow in the corner of a window is a guess. The title says
/// where the content lands and in what state, which is the part a user cannot
/// see before pressing it.
import { createSignal } from "solid-js";
import { PanelsTopLeft } from "lucide-solid";
import {
  ATTACH_HOME_LABEL,
  attachHome,
  attachHomeTitle,
  type DetachedSurface,
} from "@/commands/attachHome";

export function AttachHomeButton(props: { surface: DetachedSurface; class?: string }) {
  // Pending rather than disabled (§7.6): the window is about to go away, and a
  // second press in the gap should be inert without the control jumping out of
  // the tab order.
  const [pending, setPending] = createSignal(false);

  return (
    <button
      onClick={() => {
        if (pending()) return;
        setPending(true);
        void attachHome(props.surface).finally(() => setPending(false));
      }}
      aria-label={ATTACH_HOME_LABEL}
      aria-busy={pending()}
      title={attachHomeTitle(props.surface)}
      class={`flex items-center gap-1.5 px-2 py-0.5 rounded text-body text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${props.class ?? ""}`}
    >
      <PanelsTopLeft class={`w-3.5 h-3.5 shrink-0 ${pending() ? "animate-spin" : ""}`} />
      <span class="truncate">{ATTACH_HOME_LABEL}</span>
    </button>
  );
}
