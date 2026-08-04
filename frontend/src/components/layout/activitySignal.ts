/// The activity-signal vocabulary: the closed set, its precedence, its styles
/// and the two pure resolvers over it. `StatusLed.tsx` is the only thing that
/// draws it; this file is the only thing that *defines* it.
///
/// Split out of `StatusLed.tsx` when the shape channel arrived. The component
/// now imports `lucide-solid`, and half the app's stores — `store/activity.ts`
/// most of all — need the vocabulary without needing a DOM, so leaving the
/// tables inside a `.tsx` made every store that ranks a signal transitively
/// depend on an icon set. That is also the separation the rest of the codebase
/// already keeps: derivation in a pure module, rendering in the component.
///
/// MASTER.md §7.5.3 defines the set as *closed*. Adding a member is a
/// design-system change, not a feature change, and `ACTIVITY_SIGNALS` below is
/// what makes adding one halfway a compile error rather than a missing dot.
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
///
/// ## The shape channel
///
/// Agent CLIs added states a dot cannot say. "Claude is asking you for
/// permission" and "this is a plain shell, there is nothing to report" both
/// collapsed into the same 8px circle, and no amount of hue was going to
/// separate them, because hue was already spent.
///
/// So three signals now render a *glyph* rather than a disc — a spinner for
/// `working`, a question mark for `waiting`, a tick for `finished` on roomy
/// surfaces — and rule 1 above gets a second channel that survives greyscale.
/// The glyphs come from `lucide-solid` rather than hand-rolled paths so they
/// carry the same optical weight as every other icon in the app.
///
/// Two things this does *not* do, both on purpose:
///   • It does not grow the compact box. `LedSlot` still reserves 8px, so no
///     strip, row or header reflows; `density="comfortable"` opts a surface
///     into a 14px box, and within either density every signal is the same
///     size (rule 2 holds per density, which is the only place it can be read
///     — an 8px tick is not a tick).
///   • It does not rely on the spin. `index.css` zeroes animation under
///     `prefers-reduced-motion`, so a still spinner has to be legible on its
///     own: an open arc is a different *shape* from a disc, which is the whole
///     reason the spinner is an arc and not a pulsing dot.

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
  /// An agent CLI in this shell is waiting on *you* — a permission prompt, a
  /// question, a plan to approve. Amber question mark, the one signal that
  /// names an action the user owes rather than one the machine is performing.
  ///
  /// Derived in `store/terminalWatch.ts` from the roster in `store/agentCli.ts`
  /// plus silence, not from parsing any CLI's prompt text; see `AGENT_QUIET_MS`
  /// for why silence is the honest observable here.
  | "waiting"
  /// A shell with nothing in flight, in the tab the user is looking at. The
  /// quietest lit state: grey, no glow, no motion. Never escalates — an idle
  /// dot on the header of a group you are not looking at is noise, not activity.
  ///
  /// Grey rather than the green it used to be, now that `finished` can be a
  /// tick: two green discs differing only in a box-shadow was colour doing the
  /// whole job, which rule 1 forbids. Grey/lit and green/tick differ in hue
  /// *and* shape.
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

/// Every member of the union, as a value.
///
/// TypeScript cannot enumerate a union at runtime, so this is the bridge — and
/// it is what lets a test assert *exhaustively* that every signal has a style, a
/// pending ring, a label and a rank, rather than checking the eight somebody
/// remembered. `_AllSignalsListed` below is the other half: adding a member to
/// the type without adding it here is a compile error.
export const ACTIVITY_SIGNALS = [
  "dirty",
  "running",
  "working",
  "waiting",
  "idle",
  "notify",
  "finished",
  "failed",
  "stale",
] as const satisfies readonly ActivitySignal[];

type AssertNever<T extends never> = T;
/// Compile-time proof that `ACTIVITY_SIGNALS` covers `ActivitySignal`. Exported
/// only so it is not an unused local; nothing consumes it.
export type _AllSignalsListed = AssertNever<
  Exclude<ActivitySignal, (typeof ACTIVITY_SIGNALS)[number]>
>;

/// §7.5.3 rule 2. A tab can carry several signals at once; exactly one mark
/// renders and it is the highest here. Ordered most to least urgent.
///
/// `notify` sits above `working`, and that ordering is the point of the whole
/// reshuffle. It used to be below (as `bell`, under `running`), so a
/// notification raised from inside a live TUI — the exact case a user cares
/// about, "claude finished and is asking me something" — could never render: the
/// process is still in the foreground, so the busy signal masked it forever.
///
/// `waiting` sits directly under `failed` and above both `notify` and
/// `working`, for the reason `notify` was moved above `working` in the first
/// place, only sharper. An agent asking for permission keeps its shell in the
/// foreground the entire time it is asking — that is what a blocked TUI *is* —
/// so ranking it below `working` would make it structurally unrenderable: the
/// process being in the foreground would mask the prompt that is the only
/// reason the user is watching the tab. It outranks `notify` too, because "it
/// finished while you were away" is news you can read later and "it is stopped
/// until you answer" is not.
///
/// `idle` is last, because it is the absence of news: anything else a tab is
/// carrying is more interesting than "this shell is fine".
const PRECEDENCE: ActivitySignal[] = [
  "failed",
  "waiting",
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

export interface SignalStyle {
  /// Fill and glow for the disc form. The glow is what reads as "lit" at 8px.
  fill: string;
  /// Stroke colour for the glyph form. Same token as `fill`, as a text colour,
  /// because a glyph is drawn in `currentColor` and a disc in a background.
  tone: string;
  /// Whether the mark pulses. Only `running` does.
  pulse: boolean;
  /// Screen-reader text. §10.10 — a badge that only exists visually is not
  /// proactive for a screen-reader user.
  label: string;
}

export const STYLES: Record<ActivitySignal, SignalStyle> = {
  dirty: {
    fill: "bg-warning",
    tone: "text-warning",
    pulse: false,
    label: "unsaved changes",
  },
  running: {
    fill: "bg-warning shadow-[0_0_6px_var(--warning)]",
    tone: "text-warning",
    pulse: true,
    label: "running",
  },
  working: {
    // Never drawn as a disc except in the `pending` form: `working` is the
    // spinner. The fill is kept so the hollow form has a token to ring in.
    fill: "bg-success shadow-[0_0_6px_var(--success)]",
    tone: "text-success",
    pulse: false,
    label: "working",
  },
  waiting: {
    fill: "bg-warning shadow-[0_0_6px_var(--warning)]",
    tone: "text-warning",
    // Emphatically still. It is not in flight — it is stopped, which is the
    // whole point — and §7.3.9 only lets genuinely-moving work move.
    pulse: false,
    label: "waiting for you",
  },
  idle: {
    // No glow and no hue: the quietest state is also the dimmest one.
    fill: "bg-muted-foreground",
    tone: "text-muted-foreground",
    pulse: false,
    label: "idle",
  },
  finished: {
    fill: "bg-success shadow-[0_0_6px_var(--success)]",
    tone: "text-success",
    pulse: false,
    label: "finished",
  },
  failed: {
    fill: "bg-destructive shadow-[0_0_6px_var(--destructive)]",
    tone: "text-destructive",
    pulse: false,
    label: "failed",
  },
  notify: {
    fill: "bg-notify shadow-[0_0_6px_var(--notify)]",
    tone: "text-notify",
    pulse: false,
    label: "finished, needs attention",
  },
  stale: {
    fill: "bg-muted-foreground/60",
    tone: "text-muted-foreground/60",
    pulse: false,
    label: "out of date",
  },
};

/// How roomy the surface drawing the mark is. Not a style knob — it decides
/// which *form* a signal can take, because a 14px tick is a tick and an 8px
/// tick is a smudge.
///
/// `compact` is every strip, row and header: the 8px box that has always been
/// reserved. `comfortable` is a board or card surface — the agent dashboard —
/// where a completed run earns a tick rather than one more green dot in a
/// column of green dots.
export type LedDensity = "compact" | "comfortable";

/// The box, per density. One size for every signal within a density; this is
/// §7.5.3 rule 3, and `LedSlot` reserves exactly this.
export const BOX: Record<LedDensity, string> = {
  compact: "w-2 h-2",
  comfortable: "w-3.5 h-3.5",
};

/// Glyph stroke weight, per density. Heavier when small, or the arc of the
/// spinner disappears into the background at 8px.
export const STROKE: Record<LedDensity, number> = {
  compact: 3,
  comfortable: 2.25,
};

/// The shape channel. `dot` is the historical disc; the rest are glyphs.
export type LedShape = "dot" | "spinner" | "question" | "check";


/// Which form a signal takes. The whole shape channel is this one function, so
/// there is exactly one place to read to know what any signal looks like.
///
/// `finished` is the only density-dependent entry, and it is the one the brief
/// asks for: a tick on a dashboard, a green dot in a sidebar. `working` and
/// `waiting` are glyphs at both densities because a dot cannot say either of
/// them at any size.
export function ledShape(signal: ActivitySignal, density: LedDensity = "compact"): LedShape {
  if (signal === "working") return "spinner";
  if (signal === "waiting") return "question";
  if (signal === "finished" && density === "comfortable") return "check";
  return "dot";
}

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
export const PENDING_RINGS: Record<ActivitySignal, string> = {
  dirty: "border-warning",
  running: "border-warning",
  working: "border-success",
  waiting: "border-warning",
  idle: "border-muted-foreground",
  finished: "border-success",
  failed: "border-destructive",
  notify: "border-notify",
  stale: "border-muted-foreground/60",
};

/// Everything one signal is drawn with, in one object. A test seam: the tables
/// above stay private so no component can reach past `StatusLed` and render a
/// mark itself, but a test has to be able to prove every member has an entry.
export function signalStyles(signal: ActivitySignal): SignalStyle & {
  pendingRing: string;
  rank: number;
} {
  return {
    ...STYLES[signal],
    pendingRing: PENDING_RINGS[signal],
    rank: PRECEDENCE.indexOf(signal),
  };
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
  /// The foreground process is a recognised agent CLI (`store/agentCli.ts`).
  ///
  /// This is the bit that separates "there is nothing to report" from "there is
  /// nothing happening". A plain shell sitting at its prompt is not idle in any
  /// sense the user cares about — it is *not an agent*, and a dot on it is a
  /// dot on every row in the sidebar, which is the same as no information at
  /// all. Defaults to `false` so a caller that has not been taught about agents
  /// errs toward silence rather than toward a wrong dot.
  agent?: boolean;
  /// The agent has been silent long enough to count as waiting on the user.
  /// Meaningless without `agent`, and ignored without it.
  waiting?: boolean;
  /// This tab is the one the user is looking at.
  focused: boolean;
}): ActivitySignal | undefined {
  // Above `working` for the same reason it is above it in `PRECEDENCE`: the
  // agent's process is still in the foreground while it asks.
  if (state.agent && state.waiting) return "waiting";
  // Reported for any shell, agent or not. A build churning in a background pane
  // is exactly the thing that has to escalate, and it does not become less true
  // because the binary is not on a roster.
  if (state.working) return "working";
  // The plain-shell case: no mark at all, at any focus. Distinct from `idle`,
  // which is a lit-but-quiet *agent*.
  if (!state.agent) return undefined;
  return state.focused ? "idle" : undefined;
}
