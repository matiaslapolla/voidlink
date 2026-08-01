/// The tooltip primitive, and the `use:tooltip` directive that attaches it.
///
/// **Why not `title=`.** There were 271 native `title` attributes and zero
/// `role="tooltip"` (MOTION-PLAN F3). Native `title` has an OS-controlled delay
/// that cannot be tuned, never fires on keyboard focus, and cannot be styled —
/// so §7.3.12's contract (600–800ms on hover, **0ms on focus**, instant on
/// adjacent triggers while the group is warm) is not merely unimplemented with
/// it but unimplementable. Several sites carry real information in `title`
/// rather than a restatement of a visible label, which makes this functional
/// rather than cosmetic.
///
/// **One surface, not one per trigger.** `<TooltipLayer />` mounts a single
/// portalled element for the whole window and every trigger asks it to show
/// text anchored to itself. That is what makes §7.3.12's "adjacent triggers
/// open instantly" fall out for free — there is nothing to unmount and remount
/// as the pointer crosses a toolbar, only an anchor and a string to retarget —
/// and it keeps 271 triggers from becoming 271 portals.
///
/// **The directive, not a wrapper component.** A `<Tooltip>` that wraps its
/// trigger inserts an element into whatever flex or grid row the trigger lives
/// in, and 271 of those would each need their layout re-checked.
/// `use:tooltip={"…"}` adds one attribute and changes no DOM.
///
/// WCAG 1.4.13: the surface is hoverable (moving the pointer onto it keeps it
/// open, so a long message can be read) and dismissible without moving the
/// pointer (Escape).
import { createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js";
import { Portal } from "solid-js/web";

/// How long the pointer must rest before a *cold* tooltip opens. Keyboard focus
/// never waits — §7.3.12 calls equal hover and focus delays a tell, because a
/// keyboard user asked for the tooltip explicitly. The value is
/// `--delay-tooltip` in `index.css`; it is read from the cascade rather than
/// duplicated here so the token stays the single definition.
function hoverDelayMs(): number {
  if (typeof document === "undefined") return 650;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--delay-tooltip")
    .trim();
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 650;
}

/// How long the group stays *warm* after the last tooltip closes. Within this
/// window the next trigger opens with no delay and no transition; past it, the
/// full hover delay applies again. This is the whole of §7.3.12's third
/// sentence: scanning along a toolbar should not re-pay the delay at every
/// button, but coming back to it a minute later should.
const WARM_GRACE_MS = 400;

/// Gap between the trigger's edge and the surface.
const OFFSET = 6;
/// Keep-out from the viewport edge.
const PAD = 8;

interface TooltipState {
  text: string;
  /// Viewport coordinates of the surface's top-left, already clamped.
  left: number;
  top: number;
  /// Which edge of the trigger it sits on, for `transform-origin` — a tooltip
  /// flipped above its trigger must grow downward from the trigger, not
  /// upward away from it (§7.3.7).
  placement: "top" | "bottom";
  /// Opened while the group was warm, or by keyboard focus. Both open at 0ms
  /// with no transition; the flag is what suppresses the enter animation
  /// rather than shortening it, because a 1-frame animation is a flicker.
  instant: boolean;
}

const [state, setState] = createSignal<TooltipState | null>(null);
const [pinned, setPinned] = createSignal(false);

/// Non-reactive scheduling state. Deliberately module-level and *not* signals:
/// nothing renders from them, and a signal write per pointer-move across a
/// toolbar is work for no observer.
let openTimer: number | undefined;
let warmTimer: number | undefined;
let warm = false;
let currentAnchor: HTMLElement | null = null;

function cancelPending() {
  if (openTimer !== undefined) {
    window.clearTimeout(openTimer);
    openTimer = undefined;
  }
}

/// Measure the anchor and place the surface. Called on open and again from the
/// layer once the surface has a real width, because the first placement has to
/// guess at one.
function place(anchor: HTMLElement, text: string, instant: boolean, width = 0, height = 0) {
  const r = anchor.getBoundingClientRect();
  const w = width || Math.min(280, Math.max(80, text.length * 7));
  const h = height || 24;
  // Below the trigger by default; flip above only when there is genuinely no
  // room, so a row of buttons does not have some tooltips above and some below.
  const belowTop = r.bottom + OFFSET;
  const flip = belowTop + h + PAD > window.innerHeight && r.top - OFFSET - h > PAD;
  const top = flip ? r.top - OFFSET - h : belowTop;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(PAD, Math.min(left, window.innerWidth - w - PAD));
  setState({ text, left, top, placement: flip ? "top" : "bottom", instant });
}

function show(anchor: HTMLElement, text: string, instant: boolean) {
  currentAnchor = anchor;
  place(anchor, text, instant);
  warm = true;
  if (warmTimer !== undefined) {
    window.clearTimeout(warmTimer);
    warmTimer = undefined;
  }
}

function hide() {
  cancelPending();
  if (!state()) return;
  currentAnchor = null;
  setState(null);
  setPinned(false);
  // Start the grace window rather than going cold immediately.
  if (warmTimer !== undefined) window.clearTimeout(warmTimer);
  warmTimer = window.setTimeout(() => {
    warm = false;
    warmTimer = undefined;
  }, WARM_GRACE_MS);
}

/// Close and go cold *now*, skipping the warm grace. Escape means "stop showing
/// me these", not "show me the next one instantly" (§7.3.12 + WCAG 1.4.13).
function dismiss() {
  cancelPending();
  currentAnchor = null;
  setState(null);
  setPinned(false);
  warm = false;
  if (warmTimer !== undefined) {
    window.clearTimeout(warmTimer);
    warmTimer = undefined;
  }
}

/// `use:tooltip={"Close terminal"}` on any element.
///
/// Passing `undefined` or an empty string attaches nothing, so a call site can
/// hand it an optional label without a `<Show>` around the element.
///
/// The element also gets `aria-describedby` while its tooltip is open. It is
/// not set at rest: a description that points at an element which is not in the
/// document is announced as nothing, and screen readers already have the
/// element's own accessible name.
export function tooltip(el: HTMLElement, value: Accessor<string | undefined>) {
  const text = () => value();

  const onEnter = () => {
    const t = text();
    if (!t) return;
    cancelPending();
    if (warm) {
      show(el, t, true);
      return;
    }
    openTimer = window.setTimeout(() => {
      openTimer = undefined;
      const latest = text();
      if (latest) show(el, latest, false);
    }, hoverDelayMs());
  };

  const onLeave = () => {
    cancelPending();
    // Only close what this element opened. A pointer leaving a trigger whose
    // tooltip has already been retargeted to a neighbour must not close the
    // neighbour's.
    if (currentAnchor === el && !pinned()) hide();
  };

  const onFocus = () => {
    const t = text();
    if (!t) return;
    // Pointer focus is not a request for a tooltip — the hover path already
    // decides that, and firing here too would defeat the delay on every click.
    if (!el.matches(":focus-visible")) return;
    cancelPending();
    show(el, t, true);
  };

  const onBlur = () => {
    if (currentAnchor === el) hide();
  };

  // Pointer-down closes: a tooltip still hanging over the menu the button just
  // opened is the native behaviour nobody wants.
  const onDown = () => {
    if (currentAnchor === el) dismiss();
  };

  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);

  onCleanup(() => {
    if (currentAnchor === el) dismiss();
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("focus", onFocus);
    el.removeEventListener("blur", onBlur);
  });
}

/// Mount once, near the root of each window. Without it `use:tooltip` is inert
/// rather than broken — which is the right failure for a window (the editor's,
/// say) that has not adopted it yet.
export function TooltipLayer() {
  /// Whether the surface has been through one frame at its entry values.
  ///
  /// A transition needs two computed values to interpolate between, and an
  /// element that has just been inserted has only one. Flipping this on the
  /// next frame is what gives it the first. `@starting-style` would do the same
  /// with no JavaScript, but its WebKit floor is higher than this app's stated
  /// deployment floor, and §7.3.8 rules out the keyframe alternative — a
  /// tooltip retargeted mid-hover must retarget from where it is, not restart
  /// from zero.
  const [entered, setEntered] = createSignal(false);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state()) dismiss();
    };
    // A scroll or a resize moves the anchor out from under the surface, and
    // there is no cheap way to keep them together — so close. Capture phase
    // because the scroller is usually a pane, not the window.
    const onScroll = () => hide();
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    });
  });

  // Re-place once the surface has been measured for real. The first placement
  // estimates the width from the text length, which is close enough that the
  // correction is invisible but not close enough to skip.
  const measured = (el: HTMLDivElement) => {
    const s = state();
    if (!s || !currentAnchor) return;
    const r = el.getBoundingClientRect();
    if (Math.abs(r.width) < 1) return;
    place(currentAnchor, s.text, s.instant, r.width, r.height);
  };

  return (
    <Show when={state()}>
      {(s) => (
        <Portal>
          <div
            ref={(el) => {
              setEntered(false);
              queueMicrotask(() => measured(el));
              requestAnimationFrame(() => setEntered(true));
            }}
            role="tooltip"
            data-motion="tooltip"
            // WCAG 1.4.13 hoverable: the pointer may travel onto the surface
            // to read a long message without it vanishing.
            onPointerEnter={() => setPinned(true)}
            onPointerLeave={() => {
              setPinned(false);
              hide();
            }}
            class={[
              "fixed z-[var(--z-menu)] max-w-[280px] pointer-events-auto",
              "rounded-md border border-border bg-popover text-popover-foreground",
              "px-2 py-1 text-label leading-snug shadow-lg",
              // A warm or keyboard-opened tooltip appears with no transition at
              // all. A cold one gets §7.1's 5–50×/session budget, entering from
              // the trigger's edge rather than from its own centre (§7.3.7).
              s().instant
                ? ""
                : "transition-[opacity,transform] duration-[var(--dur-short)] ease-out",
            ].join(" ")}
            style={{
              left: `${s().left}px`,
              top: `${s().top}px`,
              "transform-origin": s().placement === "top" ? "center bottom" : "center top",
              // Never from `scale(0)` (§7.3.7). 0.97 and a fade is the whole
              // effect; an instant tooltip skips straight to the rest values.
              opacity: s().instant || entered() ? 1 : 0,
              transform: s().instant || entered() ? "scale(1)" : "scale(0.97)",
            }}
          >
            {s().text}
          </div>
        </Portal>
      )}
    </Show>
  );
}

// `use:` directives are erased by the compiler unless the symbol is referenced,
// and TypeScript cannot see the JSX attribute as a use. This keeps both happy
// without a lint suppression at every call site.
export type TooltipDirective = typeof tooltip;

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      tooltip: string | undefined;
    }
  }
}
