export interface PromptVariable {
  id: string;
  name: string;
  varType: string;
  defaultValue: string;
  description: string;
  required: boolean;
  sortOrder: number;
}

export interface PromptTag {
  id: string;
  name: string;
  color: string;
}

export interface PromptSummary {
  id: string;
  name: string;
  description: string;
  isFavorite: boolean;
  updatedAt: number;
  versionCount: number;
  tags: string[];
}

export interface PromptFull {
  id: string;
  name: string;
  description: string;
  content: string;
  systemPrompt: string;
  modelOverride: string | null;
  temperature: number | null;
  maxTokens: number | null;
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
  variables: PromptVariable[];
  tags: string[];
}

export interface SaveVariableInput {
  name: string;
  varType?: string;
  defaultValue?: string;
  description?: string;
  required?: boolean;
}

export interface SavePromptInput {
  id?: string;
  name: string;
  description?: string;
  content?: string;
  systemPrompt?: string;
  modelOverride?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  variables?: SaveVariableInput[];
  tags?: string[];
}

export interface PromptVersion {
  id: string;
  version: number;
  content: string;
  systemPrompt: string;
  variablesJson: string;
  createdAt: number;
}

export interface PromptExecution {
  id: string;
  promptId: string;
  renderedPrompt: string;
  systemPrompt: string;
  variablesJson: string;
  model: string;
  provider: string;
  output: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  rating: number | null;
  createdAt: number;
}

export interface ExecutePromptInput {
  promptId: string;
  variables: Record<string, string>;
}

export interface OptimizeResult {
  original: string;
  optimized: string;
  improvements: string[];
  clarityScoreBefore: number;
  clarityScoreAfter: number;
}

export interface PromptAnalysis {
  tokenCount: number;
  clarityScore: number;
  structureScore: number;
  suggestions: string[];
  detectedVariables: string[];
  riskFlags: string[];
}
