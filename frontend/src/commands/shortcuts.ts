/// Platform-aware rendering of keymap chords.
///
/// The seam between the pure layers (`keys.ts` formatter, `keymap.ts` data)
/// and the UI: this is the only place that couples an accelerator label to
/// which OS we're on, so the formatter itself stays testable without stubbing
/// a platform.

import { isMac } from "@/api/platform";
import { formatChord, type Chord } from "@/commands/keys";
import { chordsOf, entryFor } from "@/commands/keymap";

/// One chord, as this platform writes it.
export function formatForPlatform(chord: Chord): string {
  return formatChord(chord, isMac());
}

/// An action's accelerator, or `undefined` when it has no chord. Palette-only
/// actions are normal — most of the catalog has no shortcut.
export function shortcutLabel(actionId: string): string | undefined {
  const entry = entryFor(actionId);
  return entry ? formatForPlatform(entry.binding) : undefined;
}

/// Every distinct label for an action, primary first. Alternates that render
/// identically to the primary (a layout fallback like `⌘⇧?` vs `⌘⇧/`) collapse
/// into one — showing the same label twice would just look like a bug.
export function shortcutLabels(actionId: string): string[] {
  const entry = entryFor(actionId);
  if (!entry) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chord of chordsOf(entry)) {
    const label = formatForPlatform(chord);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}
