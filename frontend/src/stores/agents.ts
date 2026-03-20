import { createSignal, createResource, Resource } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

export interface Agent {
  id: string;
  name: string;
  model: string;
  status: 'idle' | 'running' | 'error';
}

export const [agents, setAgents] = createSignal<Agent[]>([]);

export async function createAgent(config: Omit<Agent, 'status'>) {
  const id = await invoke<string>('agent_create', { config });
  setAgents([...agents(), { ...config, id, status: 'idle' }]);
}

export async function executeAgent(agentId: string, input: string) {
  const agent = agents().find(a => a.id === agentId);
  if (!agent) return;
  
  agent.status = 'running';
  const result = await invoke<string>('agent_execute', { agentId, input });
  agent.status = 'idle';
  return result;
}

export async function streamAgent(agentId: string, input: string, onChunk: (chunk: string) => void) {
  const agent = agents().find(a => a.id === agentId);
  if (!agent) return;
  
  agent.status = 'running';
  
  try {
    await invoke('agent_stream', { agentId, input });
    agent.status = 'idle';
  } catch (error) {
    agent.status = 'error';
    throw error;
  }
}

export async function getAgents() {
  return agents();
}
