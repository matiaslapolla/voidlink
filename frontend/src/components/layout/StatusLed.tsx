/// The single status glyph for the whole app. MASTER.md §7.5.3 defines a
/// *closed* set of activity signals; this primitive is the only place they are
/// drawn, so one more cannot quietly appear in a feature component.
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
///   3. `running` and `working` are the only pulsing states, and they pulse
///      because work is genuinely in flight (§7.3.9). Nothing here animates
///      when idle — `idle` itself is a still, glow-less dot.
import { Show, splitProps, type JSX } from "solid-js";

/// The closed set. Adding a member here is a design-system change, not a
/// feature change — see MASTER.md §7.5.3 before touching it.
export type ActivitySignal =
  /// Unsaved buffer. Filled dot, replaces the close affordance. Clears on save.
  | "dirty"
  /// VoidLink is fetching something for this tab — a diff, a stack, an AI
  /// draft. Chrome work, in the app's own warning hue. Pulsing.
  | "running"
  /// A foreground process in this shell is *actively* working: busy **and**
  /// producing output. Green and pulsing. See `store/terminalWatch.ts` for why
  /// output rate rather than `busy` alone decides this — `busy` is true for the
  /// whole lifetime of any TUI, so it cannot tell "claude is thinking" from
  /// "claude is sitting at its prompt".
  | "working"
  /// A shell with nothing in flight, in the tab the user is looking at. The
  /// quietest lit state: green, no glow, no motion. Never escalates — an idle
  /// dot on the header of a group you are not looking at is noise, not activity.
  | "idle"
  /// Something the user was waiting for finished while they were looking
  /// elsewhere, or a program asked for attention (BEL, OSC 9, OSC 777). Cyan,
  /// so it reads as neither "it worked" (green) nor chrome (blue). Clears on
  /// focus.
  | "notify"
  /// Work completed while the user was looking elsewhere — today, a buffer
  /// reloaded from disk. Clears on focus.
  | "finished"
  /// Work failed. Never clears on focus alone — it must be acknowledged.
  | "failed"
  /// The value shown is known to be out of date (§7.5.4).
  | "stale";

/// §7.5.3 rule 2. A tab can carry several signals at once; exactly one mark
/// renders and it is the highest here. Ordered most to least urgent.
///
/// `notify` sits above `working`, and that ordering is the point of the whole
/// reshuffle. It used to be below (as `bell`, under `running`), so a
/// notification raised from inside a live TUI — the exact case a user cares
/// about, "claude finished and is asking me something" — could never render: the
/// process is still in the foreground, so the busy signal masked it forever.
///
/// `idle` is last, because it is the absence of news: anything else a tab is
/// carrying is more interesting than "this shell is fine".
const PRECEDENCE: ActivitySignal[] = [
  "failed",
  "notify",
  "working",
  "running",
  "finished",
  "dirty",
  "stale",
  "idle",
];

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
  working: {
    fill: "bg-success shadow-[0_0_6px_var(--success)]",
    pulse: true,
    label: "working",
  },
  idle: {
    // No glow, so it differs from `working` and `finished` in more than motion:
    // the quietest state is also the dimmest one.
    fill: "bg-success",
    pulse: false,
    label: "idle",
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
  notify: {
    fill: "bg-notify shadow-[0_0_6px_var(--notify)]",
    pulse: false,
    label: "finished, needs attention",
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
  working: "border-success",
  idle: "border-success",
  finished: "border-success",
  failed: "border-destructive",
  notify: "border-notify",
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

/// What a terminal tab's own dot shows, given what its shell is doing and
/// whether the user is looking at it. The one mapping; the tab strip and the
/// terminal sidebar both read it.
///
/// Returns `undefined` — genuinely off — for an idle shell nobody is watching.
/// The old two-bit version could never be off: `busy` meant `running` (orange,
/// pulsing) whether a TUI was working or merely *open*, and idle meant
/// `finished` on a shell where nothing had finished, or a grey `stale` dot
/// claiming the value was out of date when it was exactly current. Four states,
/// none of them "there is nothing to say".
///
/// Only two of the five terminal states are decided here. `notify` and `failed`
/// come from `store/activity.ts`, because they have to survive the user looking
/// away and escalate to a group header or the status bar; `idle` must *not*
/// escalate, which is exactly why it is computed at the render site from local
/// focus rather than stored.
export function terminalSignal(state: {
  /// A foreground process is busy **and** producing output. Not `busy` alone —
  /// see the `working` member of `ActivitySignal`.
  working: boolean;
  /// This tab is the one the user is looking at.
  focused: boolean;
}): ActivitySignal | undefined {
  if (state.working) return "working";
  return state.focused ? "idle" : undefined;
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
