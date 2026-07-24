import { onCleanup, onMount } from "solid-js";
import { matches, type Chord } from "@/commands/keys";
import { KEYMAP, chordsOf, type BindingScope } from "@/commands/keymap";
import { getAction } from "@/commands/registry";

export type { Chord };
export { matches };

export interface KeyBinding extends Chord {
  /// See `BindingScope` in `keymap.ts`. Defaults to `"global"`.
  scope?: BindingScope;
  /// Run when the binding matches. Return true to allow event default,
  /// otherwise the default + propagation are prevented.
  run: (e: KeyboardEvent) => void | boolean | Promise<void | boolean>;
}

/// Selectors for the two surfaces that own their own keyboard handling.
/// Monaco renders into `.monaco-editor`; xterm renders into `.xterm`. Both put
/// focus on a hidden textarea *inside* that container, so `closest()` finds it.
const TERMINAL_SELECTOR = ".xterm";
const EDITOR_SELECTOR = ".monaco-editor";

function focusIsWithin(selector: string): boolean {
  const el = document.activeElement;
  return el instanceof Element && !!el.closest(selector);
}

/// Whether a binding is live given where focus currently is.
function scopeAllows(scope: BindingScope | undefined): boolean {
  switch (scope) {
    case "outside-terminal":
      return !focusIsWithin(TERMINAL_SELECTOR);
    case "outside-text-surfaces":
      return !focusIsWithin(TERMINAL_SELECTOR) && !focusIsWithin(EDITOR_SELECTOR);
    default:
      return true;
  }
}

/// Installs a global keydown listener for the given bindings. Bindings are
/// checked in order; first match wins. Inputs are intentionally allowed to
/// match — Cmd+K should work even when the commit textarea has focus. A
/// binding whose scope excludes the current focus is skipped, so the key falls
/// through to the editor or the shell untouched.
export function useKeybindings(bindings: () => KeyBinding[]) {
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      for (const b of bindings()) {
        if (!matches(b, e)) continue;
        if (!scopeAllows(b.scope)) continue;
        const result = b.run(e);
        // Default: swallow unless the handler explicitly returns true.
        // Async handlers therefore always swallow — they cannot answer in
        // time, and every async action in this app wants the key consumed.
        if (result !== true) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
}

/// The keymap, flattened into runnable bindings.
///
/// Each binding resolves its action at press time rather than at build time,
/// so the catalog in `App.tsx` is free to re-register whenever the active
/// workspace changes without the keymap needing to be rebuilt. An id with no
/// registered action returns `true` (let the browser default through) instead
/// of silently eating the key — the dev-mode assertion in `App.tsx` is what
/// turns that into a visible error.
export function keymapBindings(): KeyBinding[] {
  const out: KeyBinding[] = [];
  for (const entry of KEYMAP) {
    for (const chord of chordsOf(entry)) {
      out.push({
        meta: chord.meta,
        shift: chord.shift,
        alt: chord.alt,
        key: chord.key,
        scope: chord.scope,
        run: () => {
          const action = getAction(entry.actionId);
          if (!action) return true;
          void action.run();
        },
      });
    }
  }
  return out;
}
