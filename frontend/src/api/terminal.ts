import { invoke } from "@tauri-apps/api/core";

export interface PtyProcessInfo {
  pid: number | null;
  name: string | null;
  cwd: string | null;
  busy: boolean;
}

export const terminalApi = {
  createPty(cwd: string): Promise<string> {
    return invoke<string>("create_pty", { cwd });
  },

  closePty(sessionId: string): Promise<void> {
    return invoke<void>("close_pty", { sessionId });
  },

  processInfo(sessionId: string): Promise<PtyProcessInfo> {
    return invoke<PtyProcessInfo>("pty_process_info", { sessionId });
  },
};
