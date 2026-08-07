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
import { onCleanup, onMount } from "solid-js";
import {
  SIDEBAR_WINDOW_LABEL,
  closeSidebarWindow,
  isSidebarWindowOpen,
  onSidebarDockBack,
  openSidebarWindow,
} from "@/api/windows";
import { pushToast } from "@/commands/toast";
import type { AppStore, SidebarId } from "@/store/layout";

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

/// Put a detached panel back in the shell, at the edge and width it had —
/// neither was ever thrown away, so there is nothing to restore beyond the flag.
export async function dockSidebarBack(store: AppStore, id: SidebarId): Promise<void> {
  store.actions.setSidebarDetached(id, false);
  try {
    await closeSidebarWindow(id);
  } catch {
    // The window is already gone, or this environment has none. The panel is
    // back either way, which is what the user asked for.
  }
}

/// Wire a workbench window to its detached panels. Call once, from the root.
///
/// Two jobs, and the second is what makes a relaunch honest: a persisted
/// detachment describes a window that no longer exists after a restart, so the
/// workbench reopens it. A panel whose window cannot be reopened is docked back
/// rather than left as a slot that is collapsed for a window nobody can see.
export function useSidebarWindows(store: AppStore): void {
  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void onSidebarDockBack((id) => {
      if (typeof id === "string") store.actions.setSidebarDetached(id as SidebarId, false);
    }).then((fn) => {
      if (disposed) void fn();
      else unlisten = fn;
    });

    // Reopen on boot. `state.detachedSidebars` is read once rather than in an
    // effect: this is hydration, and an effect here would reopen a window every
    // time the *list* changed, including the change `detachSidebar` just made.
    for (const id of [...store.state.detachedSidebars]) {
      void (async () => {
        try {
          if (await isSidebarWindowOpen(id)) return;
          await openSidebarWindow(id);
        } catch {
          store.actions.setSidebarDetached(id, false);
        }
      })();
    }

    onCleanup(() => {
      disposed = true;
      if (unlisten) unlisten();
    });
  });
}
