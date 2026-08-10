/// Detaching a sidebar into its own window, and getting it back.
///
/// The store knows *that* a sidebar is detached (`detachedSidebars`) and
/// nothing else — no IPC, no window labels, no awareness that windows exist.
/// This module is the other half: it opens and closes the window, and it keeps
/// the flag and the window agreeing in both directions.
///
///   detach   → mark detached, then open the window
///   dock back→ close the window, then clear the flag
///   window closed by the user → the panel emits, the workbench clears the flag
///
/// The flag is written *before* the window opens on purpose. The shell's slot
/// collapses the moment the user asks, rather than a beat later when Tauri
/// finishes building a webview — and if the open fails, the catch puts the
/// panel straight back, which is a visible undo rather than a panel that is
/// gone with no window to show for it.
///
/// ## Coming home collapsed
///
/// Every route back — the traffic light, the detached window's own "Attach to
/// main window", the palette row — lands in `dockSidebarBack`, and all of them
/// return the panel to its **icon rail**, not to full width. A window the user
/// just dismissed should not seize a column of the workbench they were using;
/// the panel is visibly there at `SIDEBAR_RAIL_WIDTH` and one click expands it.
/// The edge and the width are untouched, so that one click restores exactly
/// what they had.
///
/// That it is one rule for all three routes is the point. "Closed by the OS" and
/// "closed by our control" differing in outcome is precisely the class of
/// inconsistency that makes a window feel unsafe to close.
import { onCleanup, onMount } from "solid-js";
import {
  SIDEBAR_WINDOW_LABEL,
  closeSidebarWindow,
  isSidebarWindowOpen,
  onEditorDockBack,
  onSidebarDockBack,
  openSidebarWindow,
} from "@/api/windows";
import { pushToast } from "@/commands/toast";
import { normalizeSidebarId, type AppStore, type SidebarId } from "@/store/layout";

/// Whether this build can put `id` in a window at all. The affordance is absent
/// for the rest rather than disabled: there is no state in which the workspace
/// rail becomes detachable, so a greyed row would be a promise, not a reason.
export function canDetachSidebar(id: SidebarId): boolean {
  return SIDEBAR_WINDOW_LABEL[id] != null;
}

export async function detachSidebar(store: AppStore, id: SidebarId): Promise<void> {
  if (!canDetachSidebar(id)) return;
  store.actions.setSidebarDetached(id, true);
  try {
    await openSidebarWindow(id);
  } catch (e) {
    store.actions.setSidebarDetached(id, false);
    pushToast(
      `Could not detach that panel: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
  }
}

/// Put a detached panel back in the shell, collapsed to its icon rail.
///
/// The edge and the width were never thrown away, so there is nothing to
/// restore beyond the two flags — see this file's header for why the collapse
/// is one of them.
export async function dockSidebarBack(store: AppStore, id: SidebarId): Promise<void> {
  homeSidebar(store, id);
  try {
    await closeSidebarWindow(id);
  } catch {
    // The window is already gone, or this environment has none. The panel is
    // back either way, which is what the user asked for.
  }
}

/// The store half of docking back: the flags, and nothing else.
///
/// Split out from `dockSidebarBack` because the two callers arrive from
/// opposite directions. One is closing the window itself and then updating the
/// store; the other *is* the window's closing message, and there is no window
/// left to close by the time it lands. Calling `closeSidebarWindow` from the
/// listener would be the re-entrant close the Rust side documents.
/// The collapse is conditional on the panel having actually been detached, and
/// that guard is load-bearing rather than defensive. The git window is the one
/// window a user can open *without* detaching anything — "Open git window"
/// beside the sidebar is a different intent from moving the sidebar out — and
/// it emits a dock-back on close either way, because it cannot know which of
/// the two it was opened for. Collapsing unconditionally would mean closing the
/// git client quietly folded away a sidebar the user never moved.
function homeSidebar(store: AppStore, id: SidebarId): void {
  const wasDetached = store.state.detachedSidebars.includes(id);
  store.actions.setSidebarDetached(id, false);
  if (wasDetached) store.actions.setSidebarCollapsed(id, true);
}

/// Wire a workbench window to its detached parts. Call once, from the root.
///
/// Three jobs:
///
///   1. A panel's window closed → dock it back, collapsed.
///   2. The editor's window closed → re-home its focused tab, via the callback
///      the workbench passes (the tab collections and which one the editor had
///      focused are both already in its store; see `requestEditorDockBack`).
///   3. Reopen on boot, which is what makes a relaunch honest: a persisted
///      detachment describes a window that no longer exists after a restart. A
///      panel whose window *cannot* be reopened — a build that dropped it, a
///      label with no spec — is docked back rather than left as a slot that is
///      collapsed for a window nobody can see.
export function useSidebarWindows(
  store: AppStore,
  opts: { onEditorHome?: () => void } = {},
): void {
  onMount(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (disposed) void fn();
        else unlisteners.push(fn);
      });

    track(
      onSidebarDockBack((id) => {
        // Normalized rather than cast: this is a payload off the wire, and a
        // window from another build could name a sidebar this one has never
        // heard of — or the pre-rename `files`. Same repair the persisted blob
        // gets, so an old window's panel still finds its slot.
        const sidebar = normalizeSidebarId(id);
        if (sidebar) homeSidebar(store, sidebar);
      }),
    );

    track(onEditorDockBack(() => opts.onEditorHome?.()));

    // Reopen on boot. `state.detachedSidebars` is read once rather than in an
    // effect: this is hydration, and an effect here would reopen a window every
    // time the *list* changed, including the change `detachSidebar` just made.
    for (const id of [...store.state.detachedSidebars]) {
      void (async () => {
        try {
          if (await isSidebarWindowOpen(id)) return;
          await openSidebarWindow(id);
        } catch {
          // No window this build can open. Dock it back *expanded* — this is
          // not a window the user just closed, it is a detachment that never
          // materialised, and collapsing it would hide a panel they never
          // asked to put away.
          store.actions.setSidebarDetached(id, false);
        }
      })();
    }

    onCleanup(() => {
      disposed = true;
      for (const fn of unlisteners) fn();
    });
  });
}
