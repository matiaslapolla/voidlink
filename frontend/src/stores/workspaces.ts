import { createSignal, createEffect } from 'solid-js';
import { listen, invoke } from '@tauri-apps/api/core';

export interface Workspace {
  id: string;
  name: string;
  path: string;
  gitBranch: string | null;
  gitStatus: string;
  prNumber: number | null;
  lastActivity: number;
  notifications: WorkspaceNotification[];
  activeAgents: string[];
}

export interface WorkspaceNotification {
  id: string;
  agentId: string;
  title: string;
  body: string;
  timestamp: number;
  unread: boolean;
}

const [workspaces, setWorkspaces] = createSignal<Workspace[]>([]);
const [activeWorkspaceId, setActiveWorkspaceId] = createSignal<string | null>(null);

createEffect(async () => {
  const saved = await invoke<Workspace[]>('workspace_list');
  if (saved) setWorkspaces(saved);

  const unlisten = await listen<Workspace>('workspace-updated', (event) => {
    setWorkspaces(workspaces().map(w =>
      w.id === event.payload.id ? event.payload : w
    ));
  });

  return unlisten;
});

export async function createWorkspace(path: string): Promise<Workspace> {
  const workspace = await invoke<Workspace>('workspace_create', { path });
  setWorkspaces([...workspaces(), workspace]);
  return workspace;
}

export async function setActiveWorkspace(id: string): Promise<void> {
  setActiveWorkspaceId(id);
  await invoke('workspace_set_active', { id });
}

export function activeWorkspace(): Workspace | undefined {
  return workspaces().find(w => w.id === activeWorkspaceId());
}

export function getWorkspace(id: string): Workspace | undefined {
  return workspaces().find(w => w.id === id);
}
