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
/// Two sidebars have a window: the file explorer and the agent board. Both are
/// pure consumers — the tree reads the filesystem through stateless Rust
/// commands, the board renders a broadcast snapshot. The terminals list has
/// none, and `SIDEBAR_WINDOW_LABEL` says why: its every control writes state
/// only the workbench owns.
import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileTree } from "@/components/files/FileTree";
import { AgentBoardView } from "@/components/agent/AgentDashboard";
import type { AgentSession } from "@/components/agent/agentBoard";
import { AttachHomeButton } from "@/components/layout/AttachHomeButton";
import { DEV_CHROME_CLASS, DevBadge } from "@/components/layout/devChrome";
import { SIDEBAR_LABEL } from "@/components/layout/SidebarDock";
import { PromptHost } from "@/commands/PromptHost";
import { ToastViewport } from "@/commands/ToastViewport";
import { TooltipLayer } from "@/components/ui/Tooltip";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, isSidebarId } from "@/store/layout";
import {
  bridgeGitRefsAcrossWindows,
  onAgentBoard,
  onWindowContext,
  openEditorTab,
  requestAgentBoard,
  requestSidebarDockBack,
  requestWindowContext,
  type WindowContext,
} from "@/api/windows";

export default function PanelApp(props: { sidebarId: string }) {
  // Hydrates like the workbench, never writes back: two windows persisting the
  // same keys would clobber each other's layout.
  const store = createAppStore({ persist: false });
  const [context, setContext] = createSignal<WindowContext | null>(null);
  const [sessions, setSessions] = createSignal<AgentSession[]>([]);
  const [showIdle, setShowIdle] = createSignal(false);

  const title = () =>
    isSidebarId(props.sidebarId) ? SIDEBAR_LABEL[props.sidebarId] : props.sidebarId;

  onMount(() => {
    const disposeBridge = bridgeGitRefsAcrossWindows();
    const unlisteners: (() => void)[] = [];
    let disposed = false;
    const track = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (disposed) void fn();
        else unlisteners.push(fn);
      });

    void track(onWindowContext(setContext)).then(() => {
      // We may have opened after the last broadcast. Asked only once the
      // subscription is live, or the workbench's reply could beat it.
      if (!disposed) void requestWindowContext();
    });

    if (props.sidebarId === "agents") {
      void track(
        onAgentBoard((snap) => {
          setSessions(snap.sessions);
          setShowIdle(snap.showIdle);
        }),
      ).then(() => {
        if (!disposed) void requestAgentBoard();
      });
    }

    // Closing this window *is* docking the panel back — which is why the
    // workbench does not have to watch for the window disappearing to keep its
    // slot honest. Tauri v2 emits the close request to the window itself, so
    // the panel is the one place that can see it without a second channel.
    //
    // The handler is **async and its emit is awaited**, and that is
    // load-bearing rather than tidy. Tauri's `onCloseRequested` wrapper awaits
    // the handler and then calls `destroy()`; when this returned `undefined`
    // synchronously, the webview was torn down in the same turn the emit was
    // posted in, and the dock-back was lost often enough that the workbench
    // kept a collapsed slot for a window that no longer existed. Awaiting is
    // what makes "closed by the traffic light" and "closed by our own control"
    // reach the same place.
    try {
      void track(
        getCurrentWindow().onCloseRequested(async () => {
          await requestSidebarDockBack(props.sidebarId);
        }),
      );
    } catch {
      // Not running under Tauri (a plain browser, a test). There is no window
      // to close and nothing to dock back into.
    }

    onCleanup(() => {
      disposed = true;
      disposeBridge();
      for (const fn of unlisteners) fn();
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
            {title()}
          </span>
          <DevBadge class="pointer-events-none" />
          <span class="ml-auto truncate pointer-events-none">
            {context()?.worktreeLabel ?? ""}
          </span>
          {/* The way back that does not require knowing that closing the
              window is the way back. Same action either way. */}
          <AttachHomeButton surface={{ kind: "panel", sidebarId: props.sidebarId }} />
        </div>
        <div class="flex-1 min-h-0 island island-slot m-[var(--island-inset)] mt-0 bg-sidebar flex flex-col">
          <Switch>
            <Match when={props.sidebarId === "agents"}>
              <AgentBoardView
                class="flex-1 min-h-0"
                sessions={sessions}
                showIdle={showIdle}
              />
            </Match>
            <Match when={props.sidebarId === "explorer"}>
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
            </Match>
          </Switch>
        </div>
      </div>
      <ToastViewport />
      <TooltipLayer />
      <PromptHost />
    </AppStoreContext.Provider>
  );
}
