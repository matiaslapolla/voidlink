export type AgentTool = "claudeCode" | "codex" | "openCode";
export type AgentStatus = "starting" | "running" | "done" | "failed";

export interface AgentSessionInfo {
  sessionId: string;
  tool: AgentTool;
  repoPath: string;
  worktreePath: string;
  worktreeName: string;
  ptyId: string;
  status: AgentStatus;
  createdAt: number;
}

export interface StartSessionInput {
  repoPath: string;
  tool: AgentTool;
  branchName?: string;
}
