/// Detaching a workspace into its own window, and getting it back.
///
/// Shaped after `commands/sidebarWindows.ts`, which is its sibling and which
/// this file follows deliberately rather than by coincidence:
///
///   detach    → mark detached, then open the window
///   dock back → home the workspace, then close the window
///   window closed by the user → it emits, the workbench homes the workspace
///
/// The flag is written *before* the window opens, and the catch puts it back, for
/// the same reason: the rail changes the moment the user asks rather than a beat
/// later when Tauri finishes building a webview, and a failed open is a visible
/// undo instead of a workspace that is gone with no window to show for it. Every
/// route home — the traffic light, the window's own "Attach to main window", the
/// palette row — lands in `homeWorkspace`, because "closed by the OS" and
/// "closed by our control" differing in outcome is what makes a window feel
/// unsafe to close.
///
/// ## The ownership rule: hand-off, not mirror
///
/// **A workspace is interactive in exactly one window at a time.** While it is
/// detached, `main` does not render it: the rail draws its row as a window to go
/// to rather than a workspace to select, and the selection moves off it.
///
/// This is not a simplification of something richer — it is the only model the
/// layer underneath supports. `PtySink` in `src-tauri/src/lib.rs` holds **one**
/// channel per session, so a second window subscribing to a live terminal does
/// not join it, it *takes* it: the first window goes silent mid-command. Two
/// windows over one workspace would mean two tab strips, two pane trees and two
/// terminals of which only one is ever wired up, and no way for the user to tell
/// which. Hand-off is the arrangement in which that is never asked for, and the
/// single-channel sink is then exactly right rather than a limitation.
///
/// ## Who writes to disk
///
/// **`main` remains the sole writer of `localStorage`, without exception.** The
/// detached window's store is created with `persist: false`, like `GitApp`'s and
/// `PanelApp`'s, and for the reason `CreateAppStoreOptions.persist` gives: every
/// tab collection lives in one blob per *kind*, keyed by worktree id across all
/// workspaces at once, so a second writer would not be writing "its" workspace —
/// it would be rewriting the whole blob from a store that only ever hydrated one
/// of them, silently deleting every other workspace's tabs on its first save.
/// There is no key to split off; the editor window's `editorTabs`/`editorPrefs`
/// pair works because those *are* separable, and a workspace's state is not.
///
/// So a detached window hydrates the tab state `main` wrote — it opens on the
/// real tabs — attaches to the live PTYs from the handoff, and keeps everything
/// the user does inside it for the life of the window. The stated cost: tabs
/// opened *while* detached do not survive docking back, because nothing wrote
/// them down. Terminals are the exception and the one that matters — they are
/// live processes rather than records, `main` never dropped their sessions from
/// its own store, and the shells are still running when the workspace comes
/// home, so the panes reattach with their scrollback intact.
import { onCleanup, onMount } from "solid-js";
import {
  closeWorkspaceWindow,
  currentWindowLabel,
  isWorkspaceWindowOpen,
  onWorkspaceDockBack,
  onWorkspaceHandoff,
  onWorkspaceHandoffRequest,
  openWorkspaceWindow,
  publishWorkspaceHandoff,
  requestWorkspaceHandoff,
  type WorkspaceHandoff,
} from "@/api/windows";
import { terminalApi } from "@/api/terminal";
import { pushToast } from "@/commands/toast";
import type { AppStore } from "@/store/layout";

/// Whether `workspaceId` may be put in a window at all.
///
/// Every workspace may, which is why this is one line — but it is a function
/// rather than a `true` at the call sites so the rail and the palette ask the
/// same question, and so the answer has somewhere to live if a kind of workspace
/// ever turns out not to (the way `canDetachSidebar` already carries that for
/// the panels).
export function canDetachWorkspace(store: AppStore, workspaceId: string): boolean {
  return store.state.workspaces.some((w) => w.id === workspaceId);
}

export async function detachWorkspace(store: AppStore, workspaceId: string): Promise<void> {
  const name = store.state.workspaces.find((w) => w.id === workspaceId)?.name;
  if (!canDetachWorkspace(store, workspaceId)) return;
  store.actions.setWorkspaceDetached(workspaceId, true);
  try {
    await openWorkspaceWindow(workspaceId, name);
    // The window mounts with an empty terminal list and asks for the handoff
    // itself; this covers the other order, where it subscribed before we
    // published. Publishing twice is free — the second one is the same value.
    await publishWorkspaceHandoff(handoffFor(store, workspaceId));
  } catch (e) {
    store.actions.setWorkspaceDetached(workspaceId, false);
    pushToast(
      `Could not detach that workspace: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
  }
}

/// Bring a workspace back into the workbench and close its window.
export async function dockWorkspaceBack(store: AppStore, workspaceId: string): Promise<void> {
  homeWorkspace(store, workspaceId);
  try {
    await closeWorkspaceWindow(workspaceId);
  } catch {
    // The window is already gone, or this environment has none. The workspace
    // is back either way, which is what the user asked for.
  }
}

/// The store half of docking back: the flag, and the selection.
///
/// Split out from `dockWorkspaceBack` for the reason `homeSidebar` is: the two
/// callers arrive from opposite directions. One is closing the window and then
/// updating the store; the other *is* the window's closing message, and calling
/// `closeWorkspaceWindow` from that listener would be the re-entrant close
/// `close_satellite` in `src-tauri/src/window.rs` documents.
///
/// A returning workspace is **selected**, where a returning sidebar comes back
/// collapsed. The two look inconsistent and are not: a panel coming home would
/// seize a column of a workbench the user was already using, while a workspace
/// coming home is the thing they were just working in — leaving it unselected
/// would put them somewhere they did not ask to be, with their window gone.
export function homeWorkspace(store: AppStore, workspaceId: string): void {
  const wasDetached = store.state.detachedWorkspaces.includes(workspaceId);
  store.actions.setWorkspaceDetached(workspaceId, false);
  if (!wasDetached) return;
  if (store.state.workspaces.some((w) => w.id === workspaceId)) {
    store.actions.selectWorkspace(workspaceId);
  }
}

/// Everything running in `workspaceId` right now, as the receiving window needs
/// it. Terminals only — see `WorkspaceHandoff` for why nothing else crosses.
export function handoffFor(store: AppStore, workspaceId: string): WorkspaceHandoff {
  const workspace = store.state.workspaces.find((w) => w.id === workspaceId);
  const terminals: WorkspaceHandoff["terminals"] = {};
  for (const wt of workspace?.worktrees ?? []) {
    terminals[wt.id] = (store.state.terminalsByWorktree[wt.id] ?? []).map((t) => ({
      id: t.id,
      ptyId: t.ptyId,
      label: t.label,
      cwd: t.cwd,
    }));
  }
  return { workspaceId, terminals };
}

/// Take a handoff: put the live sessions in this window's store, and tell Rust
/// this window is the one rendering them.
///
/// The claim is what keeps `main` from reaping these shells when it closes (see
/// `PtyOwners` in `src-tauri/src/lib.rs`). It is best-effort: a rejected claim
/// costs the guarantee that the shells outlive `main`, not the reattach, and the
/// window in front of the user should not fail to show its terminals because a
/// bookkeeping call did.
export async function adoptWorkspaceHandoff(
  store: AppStore,
  handoff: WorkspaceHandoff,
): Promise<void> {
  const ptyIds: string[] = [];
  for (const [wtId, sessions] of Object.entries(handoff.terminals)) {
    store.actions.adoptTerminalSessions(
      wtId,
      sessions.map((s) => ({
        id: s.id,
        ptyId: s.ptyId,
        label: s.label,
        cwd: s.cwd,
        // Not `restored`. That flag means "the scrollback is gone, this is a
        // fresh shell wearing the old tab's name", and it is the opposite of
        // what happened here: the process is the same one, and `pty_subscribe`
        // replays everything it has produced.
      })),
    );
    for (const s of sessions) ptyIds.push(s.ptyId);
  }
  try {
    await terminalApi.setPtyOwner(ptyIds, currentWindowLabel());
  } catch (e) {
    console.error("[workspace-window] could not claim its PTY sessions:", e);
  }
}

/// Wire the workbench to its detached workspaces. Call once, from the root.
///
/// Three jobs, the same three `useSidebarWindows` has:
///
///   1. A workspace window closed → home its workspace.
///   2. A workspace window asked for the handoff → publish it. `main` is the
///      only window that can answer, because it is the only one that knows which
///      PTYs are alive.
///   3. Reopen on boot — and reconcile. A persisted detachment describes a
///      window that no longer exists after a relaunch, and it may describe a
///      *workspace* that no longer exists either. An id with nothing behind it
///      is dropped rather than left as a flag nobody can act on, which is the
///      repair-don't-reject rule applied to the one field here that is read back
///      off disk.
export function useWorkspaceWindows(store: AppStore): void {
  onMount(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const track = (p: Promise<() => void>) =>
      void p.then((fn) => {
        if (disposed) void fn();
        else unlisteners.push(fn);
      });

    track(onWorkspaceDockBack((id) => homeWorkspace(store, id)));

    track(
      onWorkspaceHandoffRequest((id) => {
        void publishWorkspaceHandoff(handoffFor(store, id));
      }),
    );

    // Read once rather than in an effect: this is hydration, and an effect here
    // would reopen a window every time the list changed — including the change
    // `detachWorkspace` just made.
    for (const id of [...store.state.detachedWorkspaces]) {
      if (!store.state.workspaces.some((w) => w.id === id)) {
        // The workspace was removed while this detachment was on disk. There is
        // nothing to put in a window and nothing to dock back to, so the flag
        // goes rather than the boot.
        store.actions.setWorkspaceDetached(id, false);
        continue;
      }
      const name = store.state.workspaces.find((w) => w.id === id)?.name;
      void (async () => {
        try {
          if (await isWorkspaceWindowOpen(id)) return;
          await openWorkspaceWindow(id, name);
        } catch {
          // No window this build (or this environment) can open. The workspace
          // comes back into the workbench rather than staying a row pointing at
          // a window nobody can see.
          homeWorkspace(store, id);
        }
      })();
    }

    onCleanup(() => {
      disposed = true;
      for (const fn of unlisteners) fn();
    });
  });
}

/// Wire a *workspace window* to the workbench: ask for the handoff, and take
/// every one that names this workspace.
///
/// The request goes out only once the subscription is live, for the reason
/// `EditorApp` documents — asking first races the reply. Later handoffs are
/// applied too, not only the first: `main` republishes whenever it is asked, and
/// a window that reloads mid-session has to be able to find its shells again.
export function useWorkspaceHandoff(store: AppStore, workspaceId: string): void {
  onMount(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];

    void onWorkspaceHandoff((handoff) => {
      // A broadcast, so a user with two workspaces out hears both.
      if (handoff.workspaceId !== workspaceId) return;
      void adoptWorkspaceHandoff(store, handoff);
    }).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlisteners.push(fn);
      void requestWorkspaceHandoff(workspaceId);
    });

    onCleanup(() => {
      disposed = true;
      for (const fn of unlisteners) fn();
    });
  });
}
