import { invoke } from "@tauri-apps/api/core";
import type {
  PromptSummary,
  PromptFull,
  SavePromptInput,
  PromptTag,
  PromptVersion,
  PromptExecution,
  ExecutePromptInput,
  OptimizeResult,
  PromptAnalysis,
} from "@/types/prompt-studio";

export const promptStudioApi = {
  list(): Promise<PromptSummary[]> {
    return invoke<PromptSummary[]>("prompt_list");
  },

  get(id: string): Promise<PromptFull> {
    return invoke<PromptFull>("prompt_get", { id });
  },

  save(input: SavePromptInput): Promise<PromptFull> {
    return invoke<PromptFull>("prompt_save", { input });
  },

  delete(id: string): Promise<void> {
    return invoke<void>("prompt_delete", { id });
  },

  toggleFavorite(id: string): Promise<boolean> {
    return invoke<boolean>("prompt_toggle_favorite", { id });
  },

  listTags(): Promise<PromptTag[]> {
    return invoke<PromptTag[]>("prompt_list_tags");
  },

  getVersions(promptId: string): Promise<PromptVersion[]> {
    return invoke<PromptVersion[]>("prompt_get_versions", { promptId });
  },

  getExecutions(promptId: string, limit?: number): Promise<PromptExecution[]> {
    return invoke<PromptExecution[]>("prompt_get_executions", { promptId, limit });
  },

  rateExecution(executionId: string, rating: number): Promise<void> {
    return invoke<void>("prompt_rate_execution", { executionId, rating });
  },

  execute(input: ExecutePromptInput): Promise<PromptExecution> {
    return invoke<PromptExecution>("prompt_execute", { input });
  },

  analyze(content: string, systemPrompt?: string): Promise<PromptAnalysis> {
    return invoke<PromptAnalysis>("prompt_analyze", { content, systemPrompt });
  },

  optimize(content: string, systemPrompt?: string): Promise<OptimizeResult> {
    return invoke<OptimizeResult>("prompt_optimize", { content, systemPrompt });
  },
};
