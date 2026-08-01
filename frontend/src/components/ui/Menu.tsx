/// The menu primitive: one keyboard-navigable, origin-aware popup menu.
///
/// **What it replaces.** `git/ContextMenu.tsx` rendered straight into a Portal
/// with no enter or exit (MOTION-PLAN F6), handled Escape and nothing else —
/// no arrow keys, no roving `tabindex`, no typeahead, no focus moved into the
/// menu (F7) — and dismissed on `click`, deferred by `setTimeout(0)` to dodge
/// the opening click (F8). In an app whose README leads with "your hands never
/// leave the keyboard", the right-click menu was mouse-only.
///
/// Four decisions worth keeping:
///
///   • **Pointer-down dismiss, not click.** It is the native behaviour, it
///     needs no zero-timeout guard to dodge the gesture that opened the menu
///     (the opener's own `pointerdown` has already been and gone by the time
///     this listener attaches), and a drag begun outside the menu closes it
///     like it should.
///   • **Roving `tabindex`, not `tabindex` on every row.** One stop for the
///     whole menu; arrows move focus inside it. Tab leaves.
///   • **Focus goes in on open and back to the trigger on close.** A menu you
///     have to click to reach is a menu a keyboard user cannot use, and focus
///     left in a portal that just unmounted lands on `<body>`.
///   • **`transform-origin` comes from the trigger** (§7.3.7). A context menu
///     grows from where you right-clicked; never from `scale(0)`, never from
///     its own centre. Modals are the stated exception and use `Dialog`.
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { cn } from "./cn";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: JSX.Element;
  danger?: boolean;
  /// Why this row cannot be chosen. Presence is the disabled state, and the
  /// string is the `title` — §7.6 forbids a disabled control that does not say
  /// why, and a menu row is the place users most often meet one.
  disabledReason?: string;
  separatorBefore?: boolean;
}

export interface MenuProps {
  /// Viewport coordinates the menu grows from — the pointer position for a
  /// context menu, the trigger's corner for a dropdown.
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /// Where focus goes when the menu closes. A context menu opened by
  /// right-clicking a row should hand focus back to that row.
  returnFocusTo?: HTMLElement | null;
  /// Accessible name for the menu itself.
  label?: string;
  class?: string;
}

/// How long typeahead accumulates before starting a new search string. The
/// browser's own `<select>` uses ~1s; matching it means the behaviour is
/// already in the user's fingers.
const TYPEAHEAD_RESET_MS = 1000;

const PAD = 8;

export function Menu(props: MenuProps) {
  let ref: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.x, top: props.y });
  /// Which edges the menu ended up growing from, after clamping. A menu pushed
  /// up and left by the viewport must grow from its bottom-right corner, or it
  /// appears to slide *away* from the pointer that opened it.
  const [origin, setOrigin] = createSignal("top left");
  const [active, setActive] = createSignal(0);
  const [entered, setEntered] = createSignal(false);

  /// Rows a keyboard can land on. A disabled row is skipped by the arrows
  /// rather than focused and refused — but it stays in the DOM and stays
  /// readable, because its `title` is the only place its reason lives.
  const enabled = () =>
    props.items.map((item, i) => ({ item, i })).filter(({ item }) => !item.disabledReason);

  function moveActive(delta: number) {
    const list = enabled();
    if (list.length === 0) return;
    const here = list.findIndex(({ i }) => i === active());
    const next = here === -1 ? (delta > 0 ? 0 : list.length - 1) : here + delta;
    // Wrap: a menu is a ring, and Home/End cover the "go to the end" intent.
    const wrapped = ((next % list.length) + list.length) % list.length;
    setActive(list[wrapped].i);
  }

  let typeahead = "";
  let typeaheadTimer: number | undefined;

  function onTypeahead(key: string) {
    if (typeaheadTimer !== undefined) window.clearTimeout(typeaheadTimer);
    typeaheadTimer = window.setTimeout(() => {
      typeahead = "";
      typeaheadTimer = undefined;
    }, TYPEAHEAD_RESET_MS);
    typeahead += key.toLowerCase();
    const list = enabled();
    // Search from *after* the current row so repeated presses of one letter
    // cycle through the rows starting with it — the `<select>` behaviour.
    const start = list.findIndex(({ i }) => i === active());
    for (let n = 1; n <= list.length; n++) {
      const cand = list[(start + n) % list.length];
      if (cand.item.label.toLowerCase().startsWith(typeahead)) {
        setActive(cand.i);
        return;
      }
    }
  }

  function choose(index: number) {
    const item = props.items[index];
    if (!item || item.disabledReason) return;
    // Close first: a handler that opens a dialog must not be racing a menu
    // that is still deciding where to put focus back.
    props.onClose();
    item.onSelect();
  }

  function onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(enabled()[0]?.i ?? 0);
        return;
      case "End": {
        e.preventDefault();
        const list = enabled();
        setActive(list[list.length - 1]?.i ?? 0);
        return;
      }
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active());
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
        return;
      case "Tab":
        // Tab out of a menu closes it; leaving it open behind the focus is how
        // a portal ends up eating clicks in the pane underneath.
        props.onClose();
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          onTypeahead(e.key);
        }
    }
  }

  // Clamp inside the viewport, then derive the growth origin from which way it
  // had to move.
  createEffect(() => {
    const el = ref;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = props.x;
    let top = props.y;
    let originX = "left";
    let originY = "top";
    if (left + rect.width + PAD > window.innerWidth) {
      left = window.innerWidth - rect.width - PAD;
      originX = "right";
    }
    if (top + rect.height + PAD > window.innerHeight) {
      top = window.innerHeight - rect.height - PAD;
      originY = "bottom";
    }
    setPos({ left: Math.max(PAD, left), top: Math.max(PAD, top) });
    setOrigin(`${originY} ${originX}`);
  });

  onMount(() => {
    setActive(enabled()[0]?.i ?? 0);
    // Focus the panel, not a row: rows are `tabindex="-1"` and focus is
    // *tracked* by `active()`, so the panel owns the keyboard and
    // `aria-activedescendant` tells assistive tech which row is current.
    queueMicrotask(() => ref?.focus());
    requestAnimationFrame(() => setEntered(true));

    // Pointer-down, not click (F8): it is the native behaviour, and a drag
    // begun outside the menu closes it, which a `click` listener never sees.
    const onDown = (e: PointerEvent) => {
      if (ref?.contains(e.target as Node)) return;
      props.onClose();
    };
    const onContext = () => props.onClose();

    // Attach on a microtask, not synchronously.
    //
    // A context menu is opened from a `contextmenu` handler, and `onMount` runs
    // inside that same dispatch — so a listener added here would be called by
    // the very event that opened the menu, still bubbling on its way to the
    // window, and the menu would close on the frame it appeared. The old
    // implementation dodged this with `setTimeout(0)`; a microtask is the same
    // dodge without a timer, because DOM event dispatch is synchronous and the
    // microtask therefore cannot run until the whole propagation is over.
    let attached = false;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      attached = true;
      // Capture so a pane that stops propagation on its own pointerdown cannot
      // strand the menu open.
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("contextmenu", onContext);
    });

    onCleanup(() => {
      disposed = true;
      if (attached) {
        window.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("contextmenu", onContext);
      }
      if (typeaheadTimer !== undefined) window.clearTimeout(typeaheadTimer);
      // Focus back to where the menu came from. Guarded on the element still
      // being in the document — the row that opened the menu may have been the
      // thing the chosen action closed.
      const back = props.returnFocusTo;
      if (back && back.isConnected) back.focus();
    });
  });

  return (
    <Portal>
      <div
        ref={ref}
        role="menu"
        aria-label={props.label}
        aria-activedescendant={`menu-item-${active()}`}
        tabIndex={-1}
        data-motion="menu"
        onKeyDown={onKeyDown}
        style={{
          left: `${pos().left}px`,
          top: `${pos().top}px`,
          "transform-origin": origin(),
          opacity: entered() ? 1 : 0,
          // §7.3.7: from the trigger's origin at 0.97, never from `scale(0)`.
          transform: entered() ? "scale(1)" : "scale(0.97)",
        }}
        class={cn(
          "fixed z-[var(--z-menu)] min-w-[180px] max-w-[320px] py-1",
          "bg-popover text-popover-foreground border border-border rounded-md shadow-xl",
          "text-ui focus:outline-none",
          // 5–50×/session (§7.1) — `--dur-short` in, and the exit is the
          // parent unmounting us, which §7.2's 75% rule cannot reach from
          // here. `Menu` is opened and closed by a `<Show>` in the caller; a
          // menu that animated its own exit would have to outlive the state
          // that says it is closed, and the plan does not buy that complexity
          // for a surface that is gone the moment you choose a row.
          "transition-[opacity,transform] duration-[var(--dur-short)] ease-out",
          props.class,
        )}
      >
        <For each={props.items}>
          {(item, index) => (
            <>
              <Show when={item.separatorBefore}>
                <div role="separator" class="my-1 border-t border-border/60" />
              </Show>
              <button
                id={`menu-item-${index()}`}
                role="menuitem"
                type="button"
                tabIndex={-1}
                data-motion="menu-item"
                aria-disabled={item.disabledReason ? "true" : undefined}
                title={item.disabledReason}
                // Hovering a row makes it the active one, so the pointer and
                // the keyboard never disagree about which row Enter would take.
                onPointerEnter={() => {
                  if (!item.disabledReason) setActive(index());
                }}
                onClick={() => choose(index())}
                class={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left",
                  "transition-[background-color,color] duration-[var(--dur-tint)] ease-out",
                  item.danger ? "text-destructive" : "text-foreground",
                  item.disabledReason
                    ? "opacity-40 cursor-not-allowed"
                    : item.danger
                      ? "cursor-pointer"
                      : "cursor-pointer",
                  // Active row, whether reached by arrow or by pointer. One
                  // highlight, not a hover style and a focus style that can
                  // both be on at once.
                  !item.disabledReason && active() === index()
                    ? item.danger
                      ? "bg-destructive/10"
                      : "bg-accent/60"
                    : "",
                )}
              >
                <Show when={item.icon}>
                  <span class="shrink-0 w-3.5 h-3.5 inline-flex items-center justify-center text-muted-foreground/80">
                    {item.icon}
                  </span>
                </Show>
                <span class="flex-1 truncate">{item.label}</span>
              </button>
            </>
          )}
        </For>
      </div>
    </Portal>
  );
}
