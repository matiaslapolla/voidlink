export interface NotionTab {
  id: string;
  type: "notion";
  title: string;
  pageId: string | null;
  pagesPanelVisible: boolean;
}

export interface TerminalTab {
  id: string;
  type: "terminal";
  title: string;
  sessionId: string;
  cwd: string;
}

export type Tab = NotionTab | TerminalTab;

export interface Workspace {
  id: string;
  name: string;
  rootDir?: string;
  tabs: Tab[];
  activeTabId: string | null;
}
