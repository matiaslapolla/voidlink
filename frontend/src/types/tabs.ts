export interface Page {
  id: string;
  title: string;
  parentId?: string | null;
  workspaceId?: string | null;
}

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

export interface GitTab {
  id: string;
  type: "git";
  title: string;
  repoPath: string;
  view: "status" | "diff" | "log" | "branches" | "worktrees" | "prs" | "review" | "agent";
  diffBase?: string;
  diffHead?: string;
  prNumber?: number;
}

export type Tab = NotionTab | TerminalTab | GitTab;

export interface Workspace {
  id: string;
  name: string;
  rootDir?: string;
  tabs: Tab[];
  activeTabId: string | null;
  splitTabId: string | null;
  focusedPane: "left" | "right";
}
