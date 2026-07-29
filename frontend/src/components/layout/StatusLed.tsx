/// The single status glyph for the whole app. MASTER.md §7.5.3 defines a
/// *closed* set of six activity signals; this primitive is the only place they
/// are drawn, so a seventh cannot quietly appear in a feature component.
///
/// It is extracted from `TerminalSidebar`'s `LedDot`, which had two states
/// (busy / active) and no vocabulary. §7.5.3 rule 5 says to promote the LED
/// once it generalises past two uses — tab activity, the group header, the LSP
/// indicator and the status bar are four, so here it is.
///
/// Three properties are load-bearing and easy to lose in a refactor:
///   1. Colour is never the only channel (§7.5.3 rule 4). Every signal differs
///      in fill *and* motion, so it survives reduced motion, colourblindness
///      and the eight named themes.
///   2. The glyph never changes size between signals, and `<LedSlot>` reserves
///      the box even when there is no signal, so a mark arriving causes no
///      reflow (§7.5.3 rule 3).
///   3. `running` is the only pulsing state, and it pulses because work is
///      genuinely in flight (§7.3.9). Nothing here animates when idle.
import { Show, splitProps, type JSX } from "solid-js";

/// The closed set. Adding a member here is a design-system change, not a
/// feature change — see MASTER.md §7.5.3 before touching it.
export type ActivitySignal =
  /// Unsaved buffer. Filled dot, replaces the close affordance. Clears on save.
  | "dirty"
  /// A process is running. Pulsing. Clears when the process exits.
  | "running"
  /// Work completed while the user was looking elsewhere. Clears on focus.
  | "finished"
  /// Work failed. Never clears on focus alone — it must be acknowledged.
  | "failed"
  /// Terminal bell / attention requested. Clears on focus.
  | "bell"
  /// The value shown is known to be out of date (§7.5.4).
  | "stale";

/// §7.5.3 rule 2. A tab can carry several signals at once; exactly one mark
/// renders and it is the highest here. Ordered most to least urgent.
const PRECEDENCE: ActivitySignal[] = ["failed", "running", "bell", "finished", "dirty", "stale"];

/// Picks the mark to render from everything a tab is currently signalling.
/// Returns `undefined` for an empty set so callers can `<Show>` on it.
export function highestSignal(
  signals: Iterable<ActivitySignal | null | undefined>,
): ActivitySignal | undefined {
  const present = new Set(signals);
  return PRECEDENCE.find((s) => present.has(s));
}

interface SignalStyle {
  /// Fill and glow. The glow is what reads as "lit" at 8px.
  fill: string;
  /// Whether the mark pulses. Only `running` does.
  pulse: boolean;
  /// Screen-reader text. §10.10 — a badge that only exists visually is not
  /// proactive for a screen-reader user.
  label: string;
}

const STYLES: Record<ActivitySignal, SignalStyle> = {
  dirty: {
    fill: "bg-warning",
    pulse: false,
    label: "unsaved changes",
  },
  running: {
    fill: "bg-warning shadow-[0_0_6px_var(--warning)]",
    pulse: true,
    label: "running",
  },
  finished: {
    fill: "bg-success shadow-[0_0_6px_var(--success)]",
    pulse: false,
    label: "finished",
  },
  failed: {
    fill: "bg-destructive shadow-[0_0_6px_var(--destructive)]",
    pulse: false,
    label: "failed",
  },
  bell: {
    fill: "bg-info shadow-[0_0_6px_var(--info)]",
    pulse: false,
    label: "attention requested",
  },
  stale: {
    fill: "bg-muted-foreground/60",
    pulse: false,
    label: "out of date",
  },
};

/// The hollow form. `pending` keeps the signal's *token* and swaps the fill
/// for a ring of the same colour, so a mark that is mid-write differs from a
/// resting one in fill as well as motion.
///
/// This exists because `animate-pulse` alone is not a channel: `index.css`
/// zeroes every animation under `prefers-reduced-motion`, at which point a
/// pulsing dirty dot and a still one are the same pixels — exactly the failure
/// MASTER §7.5.3 rule 4 and §10.9 forbid. It is a modifier, not a seventh
/// signal: the shape, the box and the token are unchanged, so the LED stays
/// singular (§7.5.3 rule 5, §11.5.2).
const PENDING_RINGS: Record<ActivitySignal, string> = {
  dirty: "border-warning",
  running: "border-warning",
  finished: "border-success",
  failed: "border-destructive",
  bell: "border-info",
  stale: "border-muted-foreground/60",
};

export interface StatusLedProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  signal: ActivitySignal;
  /// The idle terminal LED is dimmed when its tab isn't active. Purely a
  /// de-emphasis knob; it never changes which signal is being reported.
  dim?: boolean;
  /// The work that clears this signal is in flight. Renders the mark hollow
  /// (and pulsing) rather than solid — see `PENDING_RINGS`.
  pending?: boolean;
  /// Suppresses the `aria-label`. Set it when the surrounding control already
  /// names the state in its own accessible name, so a screen reader doesn't
  /// hear "failed failed".
  silent?: boolean;
}

export function StatusLed(props: StatusLedProps) {
  const [own, rest] = splitProps(props, ["signal", "dim", "pending", "silent", "class"]);
  const style = () => STYLES[own.signal];
  return (
    <span
      {...rest}
      /// `w-2 h-2` is constant across every signal and both forms — `box-border`
      /// is what keeps the ring inside the same 8px box, so the pending form
      /// costs no geometry (§7.5.3 rule 3).
      class={[
        "w-2 h-2 box-border rounded-full shrink-0 transition-colors",
        own.pending ? `border-2 bg-transparent ${PENDING_RINGS[own.signal]}` : style().fill,
        own.pending || style().pulse ? "animate-pulse" : "",
        own.dim ? "opacity-60" : "",
        own.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={own.silent ? "true" : undefined}
      aria-label={own.silent ? undefined : ledLabel(own.signal, own.pending)}
      role={own.silent ? undefined : "img"}
    />
  );
}

/// Screen-reader text for a mark. The pending form says so — a hollow dot is
/// no more visible to a screen reader than a pulse is (§10.10).
export function ledLabel(signal: ActivitySignal, pending?: boolean): string {
  const base = STYLES[signal].label;
  return pending ? `${base}, write in flight` : base;
}

/// The terminal LED's two-bit state (`busy`, `active`) expressed in the §7.5.3
/// vocabulary. Both the tab strip and the terminal sidebar had their own copy
/// of this mapping; this is the one.
export function terminalSignal(busy: boolean, active: boolean): ActivitySignal {
  if (busy) return "running";
  return active ? "finished" : "stale";
}

/// Reserves the LED's box whether or not there is a signal, so a mark arriving
/// never reflows the row (§7.5.3 rule 3). Every consumer that shows a *
/// conditional* mark uses this rather than a bare `<Show>`.
export function LedSlot(props: {
  signal?: ActivitySignal;
  dim?: boolean;
  pending?: boolean;
  silent?: boolean;
  class?: string;
}) {
  return (
    <span class={`inline-flex w-2 h-2 shrink-0 items-center justify-center ${props.class ?? ""}`}>
      <Show when={props.signal}>
        {(s) => (
          <StatusLed
            signal={s()}
            dim={props.dim}
            pending={props.pending}
            silent={props.silent}
          />
        )}
      </Show>
    </span>
  );
}
