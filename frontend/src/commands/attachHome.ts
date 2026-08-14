/// "Attach to the main window", from inside a detached window.
///
/// Every window this app detaches into already knows how to hand its content
/// back: it registers `onCloseRequested` and emits a dock-back as it goes, so
/// **closing is re-attaching**. This module is that same path reached
/// deliberately rather than by way of a traffic light, which is the whole
/// affordance: a user who has the editor on a second display should not have to
/// remember that the way to get it back is to close it.
///
/// So it is one function, not a second lifecycle. It destroys this window; the
/// `onCloseRequested` handler the window already has does the emitting, and the
/// workbench's existing listeners do the re-homing. Nothing new crosses the
/// gap, and there is exactly one description of what "come home" means.
///
/// ## Why `destroy()` and not `close()`
///
/// `close()` only *requests* a close, and tauri prevents that request outright
/// for any window carrying a JS `tauri://close-requested` listener — which
/// every one of these windows does, for the reason above. `destroy()` is the
/// unconditional form. See `close_satellite` in `src-tauri/src/window.rs` for
/// the full diagnosis; it is the same fix on the other side of the boundary.
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  focusMainWindow,
  requestEditorDockBack,
  requestSidebarDockBack,
  requestWorkspaceDockBack,
} from "@/api/windows";
import { pushToast } from "@/commands/toast";

/// What this window is, from its own point of view. A panel knows which sidebar
/// it hosts; the editor and git windows are singletons.
export type DetachedSurface =
  | { kind: "panel"; sidebarId: string }
  | { kind: "editor" }
  | { kind: "git" }
  /// A whole workbench scoped to one workspace. The only surface here that the
  /// user *works in* rather than reads, which is why its title says the
  /// workspace becomes active again rather than that it comes back collapsed.
  | { kind: "workspace"; workspaceId: string };

/// The label the control carries, per MASTER §7.6 — it says what it does, and
/// it says where the content is going, because "attach" alone does not answer
/// "attach to what".
export const ATTACH_HOME_LABEL = "Attach to main window";

export function attachHomeTitle(surface: DetachedSurface): string {
  switch (surface.kind) {
    case "editor":
      return "Attach to main window\nCloses this window and brings the editor tab back into the workbench";
    case "git":
      return "Attach to main window\nCloses this window and brings the git panel back into the workbench, collapsed";
    case "panel":
      return "Attach to main window\nCloses this window and brings the panel back into the workbench, collapsed";
    case "workspace":
      return "Attach to main window\nCloses this window and makes this workspace active in the workbench again. Terminals keep running.";
  }
}

/// Send this window's content home and close it.
///
/// The dock-back is emitted here rather than left to `onCloseRequested`,
/// because `destroy()` raises no close request — that is exactly why it can be
/// relied on to close. So this is the one path that has to say it out loud, and
/// it awaits the emit before destroying: a webview that is torn down mid-IPC
/// never delivers the message, and the workbench would keep a collapsed slot
/// for a window that no longer exists.
export async function attachHome(surface: DetachedSurface): Promise<void> {
  try {
    if (surface.kind === "editor") await requestEditorDockBack();
    else if (surface.kind === "git") await requestSidebarDockBack("git");
    else if (surface.kind === "workspace")
      await requestWorkspaceDockBack(surface.workspaceId);
    else await requestSidebarDockBack(surface.sidebarId);

    await focusMainWindow();
    await getCurrentWindow().destroy();
  } catch (e) {
    // Reachable when this build's capability file is missing
    // `core:window:allow-destroy` — the failure that made these windows
    // unclosable in the first place. Said out loud rather than swallowed: the
    // content is already home, and a window that will not go away is something
    // the user needs told, not something to leave them guessing at.
    pushToast(
      `Attached, but this window would not close: ${e instanceof Error ? e.message : String(e)}`,
      "error",
    );
  }
}
