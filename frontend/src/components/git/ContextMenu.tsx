import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/// A lightweight right-click menu. Render conditionally with a `<Show>` keyed
/// on the menu state in the parent; pass the cursor position and an `onClose`.
/// Reuses the same viewport-clamping idea as the commit hover popover so the
/// menu never spills off-screen near a window edge.
export function ContextMenu(props: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  let ref: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: props.x, top: props.y });

  createEffect(() => {
    const el = ref;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let left = props.x;
    let top = props.y;
    if (left + rect.width + pad > window.innerWidth) left = window.innerWidth - rect.width - pad;
    if (top + rect.height + pad > window.innerHeight) top = window.innerHeight - rect.height - pad;
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) });
  });

  onMount(() => {
    const close = () => props.onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    // Defer attaching so the opening click doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("contextmenu", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    onCleanup(() => {
      window.clearTimeout(id);
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    });
  });

  return (
    <Portal>
      <div
        ref={ref}
        class="fixed z-[9999] min-w-[180px] bg-popover border border-border rounded-md shadow-xl py-1 text-xs"
        style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <For each={props.items}>
          {(item) => (
            <>
              <Show when={item.separatorBefore}>
                <div class="my-1 border-t border-border/60" />
              </Show>
              <button
                disabled={item.disabled}
                onClick={() => {
                  props.onClose();
                  item.onSelect();
                }}
                class={`w-full text-left px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  item.danger
                    ? "text-destructive hover:bg-destructive/10"
                    : "text-foreground hover:bg-accent/60"
                }`}
              >
                {item.label}
              </button>
            </>
          )}
        </For>
      </div>
    </Portal>
  );
}
