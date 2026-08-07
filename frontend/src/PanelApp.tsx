/// Root of a detached sidebar panel's window.
///
/// A fourth root off the same bundle, chosen by window label exactly as
/// `GitApp` and `EditorApp` are — a detached panel is not a new architecture,
/// it is the satellite arrangement `api/windows.ts` already documents applied
/// to one column instead of a whole surface.
///
/// Like every satellite it is a *consumer*: it does not choose the repository
/// (the workbench rail does), and its store is unpersisted, so nothing here can
/// race the workbench for a localStorage key. What it renders is the same
/// component the shell would have rendered in the column, given the whole
/// window instead of 256px.
///
/// Only the file explorer has a window today; see `SIDEBAR_WINDOW_LABEL` for
/// why the git panel reuses the git window and why the workspace rail has none.
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileTree } from "@/components/files/FileTree";
import { DEV_CHROME_CLASS, DevBadge } from "@/components/layout/devChrome";
import { PromptHost } from "@/commands/PromptHost";
import { ToastViewport } from "@/commands/ToastViewport";
import { TooltipLayer } from "@/components/ui/Tooltip";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import {
  bridgeGitRefsAcrossWindows,
  onWindowContext,
  openEditorTab,
  requestSidebarDockBack,
  requestWindowContext,
  type WindowContext,
} from "@/api/windows";

export default function PanelApp(props: { sidebarId: string }) {
  // Hydrates like the workbench, never writes back: two windows persisting the
  // same keys would clobber each other's layout.
  const store = createAppStore({ persist: false });
  const [context, setContext] = createSignal<WindowContext | null>(null);

  onMount(() => {
    const disposeBridge = bridgeGitRefsAcrossWindows();
    let unlistenContext: (() => void) | null = null;
    let unlistenClose: (() => void) | null = null;
    let disposed = false;

    void onWindowContext(setContext).then((fn) => {
      if (disposed) {
        void fn();
        return;
      }
      unlistenContext = fn;
      // We may have opened after the last broadcast. Asked only once the
      // subscription is live, or the workbench's reply could beat it.
      void requestWindowContext();
    });

    // Closing this window *is* docking the panel back — which is why the
    // workbench does not have to watch for the window disappearing to keep its
    // slot honest. Tauri v2 emits the close request to the window itself, so
    // the panel is the one place that can see it without a second channel.
    try {
      void getCurrentWindow()
        .onCloseRequested(() => {
          void requestSidebarDockBack(props.sidebarId);
        })
        .then((fn) => {
          if (disposed) void fn();
          else unlistenClose = fn;
        });
    } catch {
      // Not running under Tauri (a plain browser, a test). There is no window
      // to close and nothing to dock back into.
    }

    onCleanup(() => {
      disposed = true;
      disposeBridge();
      if (unlistenContext) unlistenContext();
      if (unlistenClose) unlistenClose();
    });
  });

  return (
    <AppStoreContext.Provider value={store}>
      <div class="flex flex-col h-screen w-screen overflow-hidden bg-canvas text-foreground">
        <div
          data-tauri-drag-region
          class={`flex items-center h-8 shrink-0 select-none px-3 gap-2 bg-canvas text-body text-muted-foreground ${DEV_CHROME_CLASS}`}
        >
          <span class="font-semibold tracking-wide text-foreground/80 pointer-events-none">
            Files
          </span>
          <DevBadge class="pointer-events-none" />
          <span class="ml-auto truncate pointer-events-none">
            {context()?.worktreeLabel ?? ""}
          </span>
        </div>
        <div class="flex-1 min-h-0 island island-slot m-[var(--island-inset)] mt-0 bg-sidebar flex flex-col">
          <Show
            when={context()?.repoPath}
            fallback={
              <div class="px-3 py-6 text-center text-ui text-muted-foreground">
                Waiting for the workbench…
              </div>
            }
          >
            {(root) => (
              <FileTree
                root={root()}
                onOpenFile={(path) =>
                  void openEditorTab({ kind: "open-file", path }, () => {})
                }
              />
            )}
          </Show>
        </div>
      </div>
      <ToastViewport />
      <TooltipLayer />
      <PromptHost />
    </AppStoreContext.Provider>
  );
}
