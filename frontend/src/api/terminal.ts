import { invoke } from "@tauri-apps/api/core";

export interface PtyProcessInfo {
  pid: number | null;
  name: string | null;
  cwd: string | null;
  busy: boolean;
}

export const terminalApi = {
  /// `size` seeds the PTY's winsize at spawn time. Pass the size the pane
  /// will actually render at when it's known — the shell reads the winsize
  /// before it prints its first prompt, and a wrong one there mis-wraps the
  /// prompt in a way SIGWINCH doesn't undo.
  createPty(cwd: string, size?: { cols: number; rows: number }): Promise<string> {
    return invoke<string>("create_pty", { cwd, cols: size?.cols, rows: size?.rows });
  },

  closePty(sessionId: string): Promise<void> {
    return invoke<void>("close_pty", { sessionId });
  },

  processInfo(sessionId: string): Promise<PtyProcessInfo> {
    return invoke<PtyProcessInfo>("pty_process_info", { sessionId });
  },

  /// Write raw bytes to a PTY's stdin. Used to feed a command into a terminal
  /// the app just opened — the post-create step of the new-worktree wizard
  /// runs this way so its output streams in a real shell instead of a
  /// bespoke channel.
  writePty(sessionId: string, data: string): Promise<void> {
    return invoke<void>("write_pty", { sessionId, data });
  },

  /// Declare which sessions this window is rendering.
  ///
  /// Only a detached workspace window sends this, and only so that closing
  /// `main` does not reap shells a window still on screen is showing — see
  /// `PtyOwners` in `src-tauri/src/lib.rs`. The whole set each time, not a
  /// delta: a lost release would be a shell `main` may no longer collect.
  setPtyOwner(sessionIds: string[], label: string): Promise<void> {
    return invoke<void>("pty_set_owner", { sessionIds, label });
  },
};
