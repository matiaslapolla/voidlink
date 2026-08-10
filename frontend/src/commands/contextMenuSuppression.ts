/// The predicate behind `main.tsx`'s document-level `contextmenu` listener,
/// pulled out so it is testable without bootstrapping a window root. See
/// `main.tsx` for the convention this is one half of — this decides *whether*
/// the browser's native menu is suppressed; every feature surface still
/// decides what (if anything) replaces it.

/// Real text-editing surfaces the OS's own menu (spelling, cut/copy/paste)
/// stays useful for. `contenteditable=""` is the attribute's valid-but-empty
/// form and still means "editable".
const TEXT_INPUT_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

/// Whether the global listener should call `preventDefault` for a `contextmenu`
/// event with this target, in a build where `isDev` is `false`. Dev builds
/// never suppress — Inspect Element is how this app is developed on itself —
/// so callers check `isDev` before even reaching for a target.
export function shouldSuppressContextMenu(target: Element | null): boolean {
  return !target?.closest(TEXT_INPUT_SELECTOR);
}
