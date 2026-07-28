/// Zen and maximize: the two ways the shell gets out of your way.
///
/// **Neither one touches the pane tree.** They are render filters — zen hides
/// the rail, both sidebars and the tab strips; maximize renders one group
/// instead of the split. That is what makes "restores the exact prior geometry
/// on exit" true by construction rather than by remembering a snapshot: there
/// is nothing to restore, because nothing was changed. Every ratio, every
/// split, every claim survives untouched.
///
/// Not persisted, deliberately. A user who quits in zen and reopens to a
/// chromeless window with no memory of how they got there has been trapped by
/// their layout state; the mode lasts as long as the session that asked for it.
///
/// Both toggles are keyboard-initiated, so per MASTER.md §7.1 neither animates.
/// The panels are gone on the next frame.
import { createSignal } from "solid-js";

const [zen, setZen] = createSignal(false);
const [maximized, setMaximized] = createSignal<string | null>(null);

/// True while the shell is chromeless. The status bar stays — it carries the
/// only exit affordance a zen user can see.
export const isZen = zen;

/// The pane group filling `main`, or `null` when the split is showing.
export const maximizedGroupId = maximized;

export function toggleZen(): void {
  setZen((v) => !v);
}

/// Toggle `groupId` to fill the main area. Passing the group that is already
/// maximized restores the split; passing `null` (no focused group) does
/// nothing rather than maximizing something arbitrary.
export function toggleMaximizedGroup(groupId: string | null): void {
  setMaximized((cur) => {
    if (!groupId) return null;
    return cur === groupId ? null : groupId;
  });
}

/// Which groups are on screen. A maximized group that no longer exists — its
/// last tab closed and it collapsed — falls back to showing everything rather
/// than to an empty main area.
export function visibleGroupIds(allGroupIds: readonly string[]): string[] {
  const only = maximized();
  if (only && allGroupIds.includes(only)) return [only];
  return [...allGroupIds];
}

/// Leave both modes. The status bar's chips call this; so does anything that
/// needs the full shell back (there is nothing yet, but a modal that must not
/// open behind a chromeless window is the obvious future caller).
export function exitFocusModes(): void {
  setZen(false);
  setMaximized(null);
}
