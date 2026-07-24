/// Key-chord vocabulary: the data shape, the event comparator, and the
/// accelerator formatter.
///
/// Deliberately free of Solid, Tauri, and DOM globals — the only DOM concept
/// here is the *shape* of a keyboard event, restated as `KeyEventLike` — so
/// this module is unit-testable in plain node. Everything that needs a browser
/// (focus checks, the capture listener) lives in `keybindings.ts`; the binding
/// data itself lives in `keymap.ts`.

/// A single key combination. `meta` means the platform modifier — Cmd on
/// macOS, Ctrl elsewhere — and we accept *either* so muscle memory survives a
/// platform switch. Modifiers that are absent must also be absent on the
/// event: `{ meta: true, key: "b" }` does not match Cmd+Shift+B.
export interface Chord {
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /// The `KeyboardEvent.key` value, compared case-insensitively.
  key: string;
}

/// The subset of `KeyboardEvent` the comparator reads. Keeping the matcher
/// against this instead of the DOM type is what makes it testable.
export interface KeyEventLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}

/// True when `e` is exactly the combination `c` describes.
export function matches(c: Chord, e: KeyEventLike): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if ((c.meta ?? false) !== meta) return false;
  if ((c.shift ?? false) !== e.shiftKey) return false;
  if ((c.alt ?? false) !== e.altKey) return false;
  return e.key.toLowerCase() === c.key.toLowerCase();
}

/// Canonical identity for a chord, used to detect two keymap entries claiming
/// the same combination. Modifier order is fixed so the id is stable.
export function chordId(c: Chord): string {
  const parts: string[] = [];
  if (c.meta) parts.push("meta");
  if (c.alt) parts.push("alt");
  if (c.shift) parts.push("shift");
  parts.push(c.key.toLowerCase());
  return parts.join("+");
}

/// Display names for keys whose `event.key` value is not what you'd print.
/// Shifted punctuation is mapped back to the *physical* key so `⌘⇧/` reads as
/// the keys you actually press rather than `⌘⇧?`.
const KEY_LABELS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  " ": "Space",
  "?": "/",
  "~": "`",
  _: "-",
  "+": "=",
};

const MAC_ENTER = "↩";

function keyLabel(key: string, mac: boolean): string {
  const lower = key.toLowerCase();
  if (lower === "enter") return mac ? MAC_ENTER : "Enter";
  const mapped = KEY_LABELS[lower];
  if (mapped) return mapped;
  return key.length === 1 ? key.toUpperCase() : key;
}

/// Render a chord as an accelerator label. macOS gets glyphs with no
/// separator (`⌘⇧P`); every other platform gets words joined by `+`
/// (`Ctrl+Shift+P`). Modifier order is meta → alt → shift on both, which is
/// what the hand-typed labels in this codebase already used.
export function formatChord(c: Chord, mac: boolean): string {
  const parts: string[] = [];
  if (mac) {
    if (c.meta) parts.push("⌘");
    if (c.alt) parts.push("⌥");
    if (c.shift) parts.push("⇧");
    parts.push(keyLabel(c.key, true));
    return parts.join("");
  }
  if (c.meta) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  parts.push(keyLabel(c.key, false));
  return parts.join("+");
}
