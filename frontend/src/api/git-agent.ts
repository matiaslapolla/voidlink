import { invoke } from "@tauri-apps/api/core";
import type { AgentTaskInput, AgentTaskState, PrDescription } from "@/types/git";

export const gitAgentApi = {
  start(input: AgentTaskInput): Promise<string> {
    return invoke<string>("git_agent_start", { input });
  },

  status(taskId: string): Promise<AgentTaskState> {
    return invoke<AgentTaskState>("git_agent_status", { taskId });
  },

  cancel(taskId: string): Promise<void> {
    return invoke<void>("git_agent_cancel", { taskId });
  },

  generatePrDescription(repoPath: string, base: string, head: string): Promise<PrDescription> {
    return invoke<PrDescription>("git_generate_pr_description", { repoPath, base, head });
  },

  createPr(
    repoPath: string,
    title: string,
    body: string,
    base: string,
    head: string,
    draft?: boolean,
  ): Promise<string> {
    return invoke<string>("git_create_pr", { repoPath, title, body, base, head, draft });
  },
};
