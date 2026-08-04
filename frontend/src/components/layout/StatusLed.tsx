/// The single status glyph for the whole app. MASTER.md §7.5.3 defines a
/// *closed* set of activity signals; this primitive is the only place they are
/// drawn, so one more cannot quietly appear in a feature component.
///
/// The set itself, its precedence, its style tables and the resolvers over it
/// live in `activitySignal.ts` — a DOM-free sibling, so a store can rank a
/// signal without importing an icon set. This file draws, and does nothing
/// else. It is re-exported here in full, because every existing consumer
/// imports from `@/components/layout/StatusLed` and the vocabulary is one
/// concept whether you need the value or the pixels.
///
/// Three properties are load-bearing and easy to lose in a refactor; see
/// `activitySignal.ts` for the long version:
///   1. Colour is never the only channel (§7.5.3 rule 4) — hence the *shape*
///      channel below: a spinner for `working`, a question mark for `waiting`,
///      a tick for `finished` on roomy surfaces.
///   2. The box never changes size between signals at a given density, and
///      `<LedSlot>` reserves it even when there is no signal, so a mark
///      arriving causes no reflow (§7.5.3 rule 3).
///   3. Nothing animates when idle, and nothing *depends* on animating:
///      `index.css` zeroes animation under `prefers-reduced-motion`, so a
///      still spinner has to read on its own. An open arc is a different shape
///      from a disc, which is why the spinner is an arc rather than a pulse.
import { Show, splitProps, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Check, CircleQuestionMark, LoaderCircle } from "lucide-solid";
import {
  BOX,
  PENDING_RINGS,
  STROKE,
  STYLES,
  ledLabel,
  ledShape,
  type ActivitySignal,
  type LedDensity,
} from "@/components/layout/activitySignal";

export {
  ACTIVITY_SIGNALS,
  highestSignal,
  ledLabel,
  ledShape,
  signalStyles,
  terminalSignal,
} from "@/components/layout/activitySignal";
export type {
  ActivitySignal,
  LedDensity,
  LedShape,
  SignalStyle,
} from "@/components/layout/activitySignal";

/// The glyph per shape. The only place an icon component is named; `ledShape`
/// decides *which* shape, and it is pure.
const GLYPHS = {
  spinner: LoaderCircle,
  question: CircleQuestionMark,
  check: Check,
} as const;

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
  /// How roomy the surface is. Decides whether `finished` is a tick or a dot;
  /// see `LedDensity`. Defaults to `compact`, the size every existing strip and
  /// row reserves.
  density?: LedDensity;
}

export function StatusLed(props: StatusLedProps) {
  const [own, rest] = splitProps(props, [
    "signal",
    "dim",
    "pending",
    "silent",
    "class",
    "density",
  ]);
  const style = () => STYLES[own.signal];
  const density = () => own.density ?? "compact";
  /// The hollow form is a ring, and a ring is a disc with a hole in it — so
  /// `pending` forces the disc form whatever shape the signal would otherwise
  /// take. It means "the write that clears this mark is in flight", which is an
  /// orthogonal fact to which state is being reported, and a ringed tick would
  /// be two modifiers fighting over one 8px box.
  const shape = () => (own.pending ? "dot" : ledShape(own.signal, density()));
  const glyph = () => {
    const s = shape();
    return s === "dot" ? null : GLYPHS[s];
  };
  return (
    <span
      {...rest}
      /// The box is constant across every signal *and* both forms at a given
      /// density — `box-border` is what keeps the ring inside it, so the
      /// pending form costs no geometry (§7.5.3 rule 3).
      class={[
        BOX[density()],
        "box-border shrink-0 transition-colors",
        shape() === "dot" ? "rounded-full" : "inline-flex items-center justify-center",
        shape() !== "dot"
          ? style().tone
          : own.pending
            ? `border-2 bg-transparent ${PENDING_RINGS[own.signal]}`
            : style().fill,
        own.pending || style().pulse ? "animate-pulse" : "",
        own.dim ? "opacity-60" : "",
        own.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={own.silent ? "true" : undefined}
      aria-label={own.silent ? undefined : ledLabel(own.signal, own.pending)}
      role={own.silent ? undefined : "img"}
    >
      <Show when={glyph()}>
        {(component) => (
          <Dynamic
            component={component()}
            /// `w-full h-full` beats lucide's own `width`/`height` attributes,
            /// so the glyph inherits the density's box rather than setting it.
            class={own.signal === "working" ? "w-full h-full animate-spin" : "w-full h-full"}
            strokeWidth={STROKE[density()]}
            aria-hidden="true"
          />
        )}
      </Show>
    </span>
  );
}

/// Reserves the LED's box whether or not there is a signal, so a mark arriving
/// never reflows the row (§7.5.3 rule 3). Every consumer that shows a *
/// conditional* mark uses this rather than a bare `<Show>`.
export function LedSlot(props: {
  signal?: ActivitySignal;
  dim?: boolean;
  pending?: boolean;
  silent?: boolean;
  density?: LedDensity;
  class?: string;
}) {
  const density = () => props.density ?? "compact";
  return (
    <span
      class={`inline-flex shrink-0 items-center justify-center ${BOX[density()]} ${props.class ?? ""}`}
    >
      <Show when={props.signal}>
        {(s) => (
          <StatusLed
            signal={s()}
            dim={props.dim}
            pending={props.pending}
            silent={props.silent}
            density={density()}
          />
        )}
      </Show>
    </span>
  );
}
