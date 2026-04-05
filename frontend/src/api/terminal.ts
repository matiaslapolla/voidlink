import { invoke } from "@tauri-apps/api/core";

export const terminalApi = {
  createPty(cwd: string): Promise<string> {
    return invoke<string>("create_pty", { cwd });
  },

  closePty(sessionId: string): Promise<void> {
    return invoke<void>("close_pty", { sessionId });
  },
};
