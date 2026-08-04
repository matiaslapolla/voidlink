/// Publishes the agent board to every other window. Renders nothing.
///
/// The workbench is the sole writer, on the same one-directional model
/// `api/windows.ts` already uses for the editor's tab list: it is the only
/// window that can see every worktree's terminals and the only one running the
/// PTY poll that derives their signals, so a satellite that computed its own
/// board would be computing it from nothing.
///
/// A component rather than a call in `App.tsx` because it must not exist at all
/// when the experiment is off — `useAgentSessions` is what subscribes a poll to
/// terminals outside the active worktree, and a hook cannot be called
/// conditionally. `<Show>` around this is the gate.
///
/// It is mounted next to the workbench rather than inside `TerminalSidebar`
/// because zen and the vertical-tabs layout both remove that sidebar, and a
/// board that stops broadcasting when the user hides a panel is exactly the
/// failure `terminalWatch.ts`'s header describes for the old per-strip poll.
///
/// The two `useAgentSessions` callers (this and `AgentDashboard`) share one
/// `processInfo` poll per shell — the watcher is refcounted by `ptyId` — and
/// pay for one extra wall-clock interval each, which does no IPC.
import { createEffect, onCleanup, onMount, untrack } from "solid-js";
import { onAgentBoardRequest, publishAgentBoard, type AgentBoardSnapshot } from "@/api/windows";
import { useSettings } from "@/store/settings";
import { useAgentSessions } from "@/store/agentSessions";

export function AgentBoardBroadcast() {
  const { settings } = useSettings();
  const sessions = useAgentSessions();

  const snapshot = (): AgentBoardSnapshot => ({
    sessions: sessions(),
    showIdle: settings.experimental.showIdleAgents,
  });

  createEffect(() => void publishAgentBoard(snapshot()));

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    // A window that opened after our last broadcast has no board yet and asks
    // for one. `untrack` for the same reason `onEditorTabsRequest` uses it: the
    // reply must read the current value without subscribing the listener to it.
    void onAgentBoardRequest(() => {
      void publishAgentBoard(untrack(snapshot));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return null;
}
