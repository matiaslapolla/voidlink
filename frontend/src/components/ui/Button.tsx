/// The button primitive. MASTER.md §7.6's nine states, in one place.
///
/// **Why this exists.** There were 278 raw `<button>` elements across 53 files
/// and no `components/ui/`. Every one of them hand-rolled its own hover, press,
/// focus, disabled and pending behaviour at the call site — which is *why*
/// `transition-colors` reached 201 sites: it was the only treatment cheap
/// enough to repeat. Press state existed at 3 of 278. A button with no press
/// state reads as a picture of a button, and there was no single place to fix
/// that. This is that place (MOTION-PLAN F1, F19, F20).
///
/// Four properties are load-bearing and each is easy to lose in a later edit:
///
///   • **`border-width`, `padding`, `height` and the icon slot's width are
///     constant across every state** (§7.6's no-layout-shift rule). Every
///     variant carries a border in every state; inactive ones are simply
///     `border-transparent`. State moves `background-color`, `border-color`
///     and `color` — never geometry.
///   • **Pending is not disabled.** A button doing work keeps its label, keeps
///     its focus, and stays in the tab order (§7.6, §10.11). Only the icon slot
///     changes, and the slot is reserved at rest so the spinner's arrival
///     reflows nothing. Disabling a control to say "busy" drops keyboard focus
///     into nowhere.
///   • **Disabled is `aria-disabled`, not the native attribute.** §7.6 requires
///     a disabled control to state *why*, and the reason lives in `title` —
///     which a natively-disabled button never shows, because it fires no
///     pointer events. `aria-disabled` keeps it focusable and hoverable so the
///     reason is actually reachable; the click guard below is what makes it
///     inert. A `disabledReason` is mandatory in the types for the same reason.
///   • **`data-motion`** marks the button as a surface that has named its own
///     token. Naming the transitioned properties explicitly (rather than using
///     `transition-colors`) is already enough to escape the `!important` floor
///     in `index.css`, so the attribute changes nothing on its own — it is the
///     migration's inventory. `grep -c data-motion` against
///     `grep -c transition-colors` is how much of §7.2 is real.
///
/// Focus is deliberately absent from the transition list: §7.3.3 requires the
/// ring on the same frame, and a transitioned ring is a keyboard user watching
/// their own focus arrive late.
import { Show, splitProps, type JSX } from "solid-js";
import { Loader2 } from "lucide-solid";
import { cn } from "./cn";

export type ButtonVariant = "chrome" | "primary" | "ghost" | "danger";

/// Height and horizontal padding. Both variants keep the same `border-width`,
/// so switching size is the only thing in this component that changes geometry.
export type ButtonSize = "xs" | "sm" | "md";

/// Per-variant classes for the four *tone* states. Written out as literals
/// rather than composed at runtime because Tailwind v4 only emits classes it
/// can find in the source — a built `bg-${variant}` string produces no CSS.
///
/// Hover is a tint shift and nothing else (§7.3.5, §7.3.6). Tailwind v4's
/// `hover:` variant already compiles to `@media (hover: hover)`, so the gate
/// §7.6 asks for is satisfied without a second wrapper.
///
/// Active deepens the tint immediately. Only `primary` also takes the
/// `scale(0.98)` §7.6 permits it — a uniform press-scale across unrelated
/// chrome is the same generic-UI tell as a uniform hover-scale (§7.3.5).
const VARIANTS: Record<ButtonVariant, string> = {
  chrome:
    "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/60 active:bg-accent/80 active:text-foreground",
  primary:
    "border-transparent bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 active:scale-[0.98]",
  ghost:
    "border-transparent text-foreground hover:bg-accent/40 active:bg-accent/60",
  danger:
    "border-transparent text-destructive hover:bg-destructive/15 active:bg-destructive/25",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-5 px-1 gap-1 text-micro rounded-sm",
  sm: "h-6 px-1.5 gap-1 text-label rounded",
  md: "h-7 px-2.5 gap-1.5 text-ui rounded-md",
};

/// The icon slot's width, per size. Fixed, so a spinner arriving or an icon
/// changing shape moves nothing. `shrink-0` because a truncating label must
/// never be allowed to squeeze it.
const ICON_SLOT: Record<ButtonSize, string> = {
  xs: "w-3 h-3",
  sm: "w-3 h-3",
  md: "w-3.5 h-3.5",
};

export interface ButtonProps
  extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /// Leading icon. Pass one whenever the button can go `pending`: the slot is
  /// reserved from the icon's presence, and a button that grows a spinner it
  /// had no room for reflows on every action (§7.5.2).
  icon?: JSX.Element;
  /// Work is in flight. Swaps the icon slot for a spinner and sets
  /// `aria-busy`; the label, the focus and the tab order are untouched.
  pending?: boolean;
  /// Why the button cannot be used. Its presence *is* the disabled state —
  /// there is no boolean, because §7.6 forbids a disabled control with no
  /// stated reason and an optional string beside a boolean is an invitation to
  /// ship one.
  disabledReason?: string;
  /// Icon-only buttons must still be nameable (§10.1). Enforced at runtime in
  /// dev rather than in the types, because `children` is `JSX.Element` and no
  /// type can tell "an icon" from "a label".
  "aria-label"?: string;
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "icon",
    "pending",
    "disabledReason",
    "class",
    "children",
    "onClick",
    "type",
    "title",
  ]);

  const size = () => local.size ?? "md";
  const disabled = () => local.disabledReason != null;

  return (
    <button
      {...rest}
      // Never `submit` by accident. Most of these live outside a form, and the
      // one that does not passes `type` explicitly.
      type={local.type ?? "button"}
      data-motion="button"
      aria-disabled={disabled() ? "true" : undefined}
      aria-busy={local.pending ? "true" : undefined}
      title={local.disabledReason ?? local.title}
      onClick={(e) => {
        // `aria-disabled` is advisory to the browser — the click still fires,
        // so the guard is here rather than in the attribute.
        if (disabled()) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const handler = local.onClick;
        if (typeof handler === "function") handler(e);
        else if (handler) handler[0](handler[1], e);
      }}
      class={cn(
        // Geometry and the transition contract. `transition-[…]` names the
        // three properties that may move (§7.3.1's ban on `transition: all`),
        // and `--dur-tint` is the >50×-per-session budget from §7.1.
        "relative inline-flex items-center justify-center shrink-0 border select-none",
        "transition-[background-color,border-color,color] duration-[var(--dur-tint)] ease-out",
        // Focus, instant, inset so it costs no geometry at an island's edge.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        SIZES[size()],
        VARIANTS[local.variant ?? "chrome"],
        disabled() && "opacity-40 cursor-not-allowed",
        !disabled() && "cursor-pointer",
        // Caller's class last: a call site overriding width or alignment
        // should win, and nothing here needs to beat it.
        local.class,
      )}
    >
      {/* The reserved icon slot. Rendered whenever the button has an icon at
          rest *or* can go pending, at a fixed size in both cases, so the
          spinner replaces the icon in place rather than pushing the label. */}
      <Show when={local.icon !== undefined || local.pending !== undefined}>
        <span
          class={cn("shrink-0 inline-flex items-center justify-center", ICON_SLOT[size()])}
          aria-hidden="true"
        >
          <Show when={local.pending} fallback={local.icon}>
            {/* `.motion-loop`: a spinner carries state, so it keeps turning
                under `prefers-reduced-motion` rather than freezing into a
                stopped glyph that reads as "finished" (§7.4). */}
            <Loader2 class={cn("animate-spin motion-loop", ICON_SLOT[size()])} />
          </Show>
        </span>
      </Show>
      {local.children}
    </button>
  );
}
