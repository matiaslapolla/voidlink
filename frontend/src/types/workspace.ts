export interface Workspace {
  id: string;
  name: string;
  repoRoot: string | null;
}

export interface PersistedWorkspace {
  id: string;
  name: string;
  repoRoot: string | null;
}

export interface TerminalSession {
  id: string;
  ptyId: string;
  label: string;
  cwd: string;
}

export function makeWorkspace(name: string, repoRoot: string | null = null): Workspace {
  return {
    id: crypto.randomUUID(),
    name,
    repoRoot,
  };
}
