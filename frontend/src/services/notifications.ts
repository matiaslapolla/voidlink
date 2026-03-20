import { createSignal, createEffect } from 'solid-js';
import { listen, emit } from '@tauri-apps/api/event';

export interface Notification {
  id: string;
  type: 'agent' | 'git' | 'system' | 'error';
  level: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  workspaceId: string;
  timestamp: number;
  unread: boolean;
  action?: NotificationAction;
}

export interface NotificationAction {
  label: string;
  handler: () => Promise<void>;
}

const [notifications, setNotifications] = createSignal<Notification[]>([]);
const [unreadCount, setUnreadCount] = createSignal(0);

listen<string>('terminal-osc-sequence', async (event) => {
  const sequence = event.payload;
  const notification = parseOscSequence(sequence);

  if (notification) {
    await addNotification(notification);

    emit('workspace-highlight', { workspaceId: notification.workspaceId });
  }
});

export async function addNotification(notification: Partial<Notification>): Promise<void> {
  const fullNotification: Notification = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    unread: true,
    ...notification,
  };

  setNotifications([fullNotification, ...notifications()]);
  updateUnreadCount();

  emit('notification-add', fullNotification);
}

export async function markAsRead(notificationId: string): Promise<void> {
  setNotifications(notifications().map(n =>
    n.id === notificationId ? { ...n, unread: false } : n
  ));
  updateUnreadCount();
}

export async function markAllAsRead(workspaceId: string): Promise<void> {
  setNotifications(notifications().map(n =>
    n.workspaceId === workspaceId ? { ...n, unread: false } : n
  ));
  updateUnreadCount();
}

function updateUnreadCount() {
  setUnreadCount(notifications().filter(n => n.unread).length);
}

function parseOscSequence(sequence: string): Notification | null {
  const match = sequence.match(/^\]99;([^\x07]+)\x07$/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]);
    return {
      type: data.type || 'info',
      level: data.level || 'info',
      title: data.title || 'Notification',
      body: data.body || '',
      workspaceId: data.workspaceId || '',
    };
  } catch {
    return null;
  }
}
