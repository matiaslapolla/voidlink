import { invoke } from "@tauri-apps/api/core";
import type { AgentSessionInfo, StartSessionInput } from "@/types/agent-runner";

export const agentRunnerApi = {
  detectTools(): Promise<string[]> {
    return invoke<string[]>("agent_detect_tools");
  },

  listSessions(): Promise<AgentSessionInfo[]> {
    return invoke<AgentSessionInfo[]>("agent_list_sessions");
  },

  startSession(input: StartSessionInput): Promise<AgentSessionInfo> {
    return invoke<AgentSessionInfo>("agent_start_session", { input });
  },

  killSession(sessionId: string): Promise<void> {
    return invoke<void>("agent_kill_session", { sessionId });
  },

  getScrollback(ptyId: string): Promise<number[]> {
    return invoke<number[]>("agent_get_scrollback", { ptyId });
  },

  cleanupSession(sessionId: string): Promise<void> {
    return invoke<void>("agent_cleanup_session", { sessionId });
  },
};
