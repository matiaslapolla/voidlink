export interface ScanOptions {
  forceFullRescan?: boolean;
  maxFileSizeBytes?: number;
}

export interface ScanProgress {
  scanJobId: string;
  repoPath: string;
  status: "pending" | "running" | "success" | "failed";
  scannedFiles: number;
  indexedFiles: number;
  indexedChunks: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface SearchQuery {
  repoPath: string;
  text: string;
  path?: string;
  language?: string;
  type?: string;
  maxTokens?: number;
}

export interface SearchOptions {
  limit?: number;
}

export interface SearchWhy {
  matchedTerms: string[];
  semanticScore: number;
  graphProximity: number | null;
}

export interface SearchResult {
  id: string;
  filePath: string;
  anchor: string;
  snippet: string;
  language: string;
  score: number;
  lexicalScore: number;
  semanticScore: number;
  why: SearchWhy;
}

export interface ContextBundle {
  freeText?: string;
  selectedResults: SearchResult[];
  maxTokens?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
}

export interface WorkflowMeta {
  id: string;
  objective: string;
  constraints: string[];
}

export interface WorkflowStep {
  id: string;
  intent: string;
  inputs: Record<string, unknown>;
  tools: string[];
  expectedOutput: string;
  acceptanceChecks: string[];
  retryPolicy: RetryPolicy;
}

export interface WorkflowArtifact {
  id: string;
  name: string;
  kind: string;
  reference: string;
}

export interface WorkflowDsl {
  workflow: WorkflowMeta;
  steps: WorkflowStep[];
  artifacts: WorkflowArtifact[];
}

export interface GenerateWorkflowInput {
  repoPath?: string;
  objective: string;
  constraints?: string[];
  contextBundle?: ContextBundle;
}

export interface RunWorkflowInput {
  workflowId?: string;
  dsl?: WorkflowDsl;
  repoPath?: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  stepId: string | null;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: number;
}

export interface RunStepState {
  stepId: string;
  status: "pending" | "running" | "success" | "failed" | "skipped";
  attempts: number;
  lastMessage: string | null;
}

export interface RunState {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "success" | "failed";
  startedAt: number;
  finishedAt: number | null;
  steps: RunStepState[];
  events: RunEvent[];
}

// ─── Graph types ────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  label: string;
  nodeType: "file" | "directory" | "external";
  language: string | null;
  filePath: string | null;
  sizeBytes: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  edgeType: "import" | "path_parent";
  metadata: Record<string, unknown>;
}

export interface RepoGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Entity identification types ────────────────────────────────────────────

export interface EntityCategory {
  category: string;
  filePaths: string[];
  confidence: number;
  description: string;
}

export interface EntityAnalysisResult {
  categories: EntityCategory[];
  uncategorized: string[];
}

// ─── Data-flow analysis types ───────────────────────────────────────────────

export interface DataFlowStep {
  filePath: string;
  description: string;
  role: "source" | "transform" | "sink" | "middleware";
}

export interface DataPipeline {
  id: string;
  name: string;
  description: string;
  steps: DataFlowStep[];
  confidence: number;
}

export interface DataFlowAnalysisResult {
  pipelines: DataPipeline[];
  summary: string;
}
