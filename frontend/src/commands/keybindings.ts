import { onCleanup, onMount } from "solid-js";

export interface KeyBinding {
  /// True when the binding requires the platform meta key (Cmd on macOS,
  /// Ctrl elsewhere). We accept either to keep cross-platform muscle memory.
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /// The `event.key` value (case-insensitive).
  key: string;
  /// Run when the binding matches. Return true to allow event default,
  /// otherwise the default + propagation are prevented.
  run: (e: KeyboardEvent) => void | boolean | Promise<void | boolean>;
}

function matches(b: KeyBinding, e: KeyboardEvent): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if ((b.meta ?? false) !== meta) return false;
  if ((b.shift ?? false) !== e.shiftKey) return false;
  if ((b.alt ?? false) !== e.altKey) return false;
  return e.key.toLowerCase() === b.key.toLowerCase();
}

/// Installs a global keydown listener for the given bindings. Bindings are
/// checked in order; first match wins. Inputs are intentionally allowed to
/// match — Cmd+K should work even when the commit textarea has focus.
export function useKeybindings(bindings: () => KeyBinding[]) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const b of bindings()) {
        if (matches(b, e)) {
          const result = b.run(e);
          // Default: swallow unless the handler explicitly returns true.
          Promise.resolve(result).then((r) => {
            if (r === true) return;
          });
          if (result !== true) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
}
