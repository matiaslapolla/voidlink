import { createSignal } from 'solid-js';
import { invoke, listen } from '@tauri-apps/api/core';

export interface SocketMessage {
  command: string;
  args: Record<string, any>;
  id: string;
}

const [connected, setConnected] = createSignal(false);
let ws: WebSocket | null = null;

export async function connectSocket(port: number = 7676): Promise<void> {
  ws = new WebSocket(`ws://localhost:${port}`);

  ws.onopen = () => {
    setConnected(true);
    console.log('Socket connected');
  };

  ws.onmessage = (event) => {
    const message: SocketMessage = JSON.parse(event.data);
    handleSocketCommand(message);
  };

  ws.onerror = (error) => {
    console.error('Socket error:', error);
    setConnected(false);
  };

  ws.onclose = () => {
    setConnected(false);
    setTimeout(() => connectSocket(port), 5000);
  };
}

async function handleSocketCommand(message: SocketMessage): Promise<void> {
  switch (message.command) {
    case 'workspace.create':
      await createWorkspace(message.args.path);
      break;

    case 'workspace.set_active':
      setActiveWorkspaceId(message.args.id);
      break;

    case 'agent.create':
      await invoke('agent_create', message.args.config);
      break;

    case 'agent.execute':
      await invoke('agent_execute', message.args);
      break;

    case 'notification.add':
      await addNotification(message.args);
      break;

    default:
      console.warn('Unknown command:', message.command);
  }
}

export function sendSocketCommand(command: string, args: Record<string, any>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Socket not connected');
  }

  const message: SocketMessage = {
    command,
    args,
    id: crypto.randomUUID(),
  };

  ws.send(JSON.stringify(message));
}

export function isConnected(): boolean {
  return connected();
}
