import { createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

export interface BrowserSession {
  id: string;
  url: string;
  status: 'active' | 'idle' | 'error';
}

export interface Snapshot {
  elements: Element[];
  refs: Map<string, Element>;
}

export interface Element {
  tag: string;
  text?: string;
  attributes: Record<string, string>;
  ref?: string;
}

const [sessions, setSessions] = createSignal<BrowserSession[]>([]);
const [currentSession, setCurrentSession] = createSignal<BrowserSession | null>(null);

export async function openBrowser(url: string): Promise<string> {
  const sessionId = await invoke<string>('agent_browser_open', { url });

  const session: BrowserSession = {
    id: sessionId,
    url,
    status: 'idle',
  };

  setSessions([...sessions(), session]);
  setCurrentSession(session);

  return sessionId;
}

export async function clickElement(selector: string): Promise<void> {
  await invoke('agent_browser_click', { selector });
}

export async function fillElement(selector: string, value: string): Promise<void> {
  await invoke('agent_browser_fill', { selector, value });
}

export async function getSnapshot(): Promise<Snapshot> {
  const result = await invoke<any>('agent_browser_snapshot');

  return {
    elements: result.data.snapshot || [],
    refs: new Map(Object.entries(result.data.refs || {})),
  };
}

export async function takeScreenshot(path: string): Promise<void> {
  await invoke('agent_browser_screenshot', { path });
}

export function getCurrentSession(): BrowserSession | null {
  return currentSession();
}

export function closeBrowser(): void {
  setCurrentSession(null);
}
