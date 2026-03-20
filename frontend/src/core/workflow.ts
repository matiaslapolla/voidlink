export interface WorkflowNode {
  id: string;
  type: 'agent' | 'tool' | 'condition' | 'loop';
  config: Record<string, any>;
  position: { x: number; y: number };
  connections: Connection[];
}

export interface Connection {
  from: string;
  to: string;
  condition?: string;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: WorkflowNode[];
  connections: Connection[];
  startNodeId: string;
}

export interface WorkflowExecution {
  workflowId: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'error';
  currentNodeId: string | null;
  context: Map<string, any>;
  history: ExecutionStep[];
}

export interface ExecutionStep {
  nodeId: string;
  timestamp: number;
  input: any;
  output: any;
  duration: number;
}
