import { createSignal } from "solid-js";

/// Tracks whether *any* modal surface is on screen.
///
/// This exists solely because of embedded browser tabs. A Tauri child webview
/// composites above the entire DOM — there is no z-index that puts a dialog,
/// popover or context menu over it. So every overlay has to actively push the
/// browser webview out of the way while it is open, and the browser pane
/// subscribes to this signal to know when.
///
/// Counted rather than boolean: overlays stack (the palette can open the
/// prompt, which can open a confirm), and the last one to close is the one
/// that should bring the webview back.

const [count, setCount] = createSignal(0);

/// True while at least one modal surface is open.
export function isOverlayOpen(): boolean {
  return count() > 0;
}

/// Register an overlay as open/closed. Idempotent per caller: pass the same
/// `open` value repeatedly and the count only moves on a transition. Callers
/// that own a boolean signal should drive this from a `createEffect`.
export function setOverlayOpen(key: string, open: boolean): void {
  const wasOpen = openKeys.has(key);
  if (open === wasOpen) return;
  if (open) openKeys.add(key);
  else openKeys.delete(key);
  setCount(openKeys.size);
}

const openKeys = new Set<string>();
