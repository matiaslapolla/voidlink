import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import type { Workflow, WorkflowExecution, WorkflowNode, ExecutionStep } from '../core/workflow';

export class WorkflowEngine {
  private [executions, setExecutions] = createSignal<Map<string, WorkflowExecution>>(new Map());

  async execute(workflow: Workflow, initialInput: any): Promise<void> {
    const execution: WorkflowExecution = {
      workflowId: workflow.id,
      status: 'running',
      currentNodeId: workflow.startNodeId,
      context: new Map([['input', initialInput]]),
      history: [],
    };

    setExecutions(new Map(this.executions()).set(workflow.id, execution));

    let currentNodeId = workflow.startNodeId;
    let iterations = 0;
    const MAX_ITERATIONS = 100;

    while (currentNodeId && iterations < MAX_ITERATIONS) {
      const node = workflow.nodes.find(n => n.id === currentNodeId);
      if (!node) break;

      const startTime = Date.now();
      const output = await this.executeNode(node, execution.context);
      const duration = Date.now() - startTime;

      execution.history.push({
        nodeId: currentNodeId,
        timestamp: startTime,
        input: execution.context.get('input'),
        output,
        duration,
      });

      execution.currentNodeId = currentNodeId;

      currentNodeId = this.findNextNode(workflow, currentNodeId, output);
      iterations++;
    }

    execution.status = 'completed';
    this.emitComplete(execution);
  }

  private async executeNode(node: WorkflowNode, context: Map<string, any>): Promise<any> {
    switch (node.type) {
      case 'agent':
        return invoke('agent_execute', {
          agentId: node.config.agentId,
          input: this.renderTemplate(node.config.inputTemplate, context),
        });

      case 'tool':
        return invoke('tool_execute', {
          toolId: node.config.toolId,
          args: this.renderTemplate(node.config.argsTemplate, context),
        });

      case 'condition':
        return this.evaluateCondition(node.config.expression, context);

      case 'loop':
        return this.handleLoop(node, context);

      default:
        throw new Error(`Unknown node type: ${node.type}`);
    }
  }

  private findNextNode(workflow: Workflow, fromNodeId: string, output: any): string | null {
    const connections = workflow.connections.filter(c => c.from === fromNodeId);

    for (const conn of connections) {
      if (!conn.condition) return conn.to;
      if (this.evaluateCondition(conn.condition, new Map(Object.entries({ output })))) {
        return conn.to;
      }
    }

    return null;
  }

  private renderTemplate(template: string, context: Map<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return String(context.get(key) ?? '');
    });
  }

  private evaluateCondition(expression: string, context: Map<string, any>): boolean {
    const safeContext = Object.fromEntries(context);
    try {
      return new Function('ctx', `with(ctx) { return ${expression} }`)(safeContext);
    } catch {
      return false;
    }
  }

  private handleLoop(node: WorkflowNode, context: Map<string, any>): any {
    // Simple loop implementation
    return { loopResult: 'executed' };
  }

  private emitComplete(execution: WorkflowExecution): void {
    console.log('Workflow completed:', execution);
  }

  getExecution(workflowId: string): WorkflowExecution | undefined {
    return this.executions().get(workflowId);
  }

  getExecutionHistory(workflowId: string): ExecutionStep[] {
    return this.executions().get(workflowId)?.history || [];
  }
}
