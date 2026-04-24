import { createStore, produce } from "solid-js/store";
import { createEffect, createMemo } from "solid-js";
import { terminalApi } from "@/api/terminal";
import {
  type PersistedWorkspace,
  type TerminalSession,
  type Workspace,
  makeWorkspace,
} from "@/types/workspace";

const WORKSPACES_KEY = "voidlink-workspaces";
const ACTIVE_WS_KEY = "voidlink-active-workspace";

export type DiffMode = "inline" | "split";
export type GitTab = "changes" | "branches" | "history";

export interface DiffTab {
  id: string;
  filePath: string;
}

export type ActiveItem =
  | { type: "terminal"; id: string }
  | { type: "diff"; id: string };

interface AppStoreState {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  terminalsByWorkspace: Record<string, TerminalSession[]>;
  diffTabsByWorkspace: Record<string, DiffTab[]>;
  activeItemByWorkspace: Record<string, ActiveItem | null>;
  gitSidebarCollapsed: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
}

const GIT_PREFS_KEY = "voidlink-git-prefs";

interface GitPrefs {
  gitSidebarCollapsed: boolean;
  diffMode: DiffMode;
  gitTab: GitTab;
  ignoreWhitespace: boolean;
}

function loadGitPrefs(): GitPrefs {
  try {
    const raw = localStorage.getItem(GIT_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<GitPrefs>;
      return {
        gitSidebarCollapsed: parsed.gitSidebarCollapsed ?? false,
        diffMode: parsed.diffMode === "split" ? "split" : "inline",
        gitTab:
          parsed.gitTab === "branches" || parsed.gitTab === "history"
            ? parsed.gitTab
            : "changes",
        ignoreWhitespace: parsed.ignoreWhitespace ?? false,
      };
    }
  } catch {
    // ignore
  }
  return {
    gitSidebarCollapsed: false,
    diffMode: "inline",
    gitTab: "changes",
    ignoreWhitespace: false,
  };
}

function loadWorkspaces(): { workspaces: Workspace[]; activeId: string } {
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedWorkspace[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        const workspaces = parsed.map((p) => ({
          id: p.id,
          name: p.name,
          repoRoot: p.repoRoot ?? null,
        }));
        const stored = localStorage.getItem(ACTIVE_WS_KEY);
        const activeId =
          stored && workspaces.some((w) => w.id === stored) ? stored : workspaces[0].id;
        return { workspaces, activeId };
      }
    }
  } catch {
    // ignore
  }
  const first = makeWorkspace("Main");
  return { workspaces: [first], activeId: first.id };
}

export function createAppStore() {
  const { workspaces, activeId } = loadWorkspaces();
  const gitPrefs = loadGitPrefs();
  const [state, setState] = createStore<AppStoreState>({
    workspaces,
    activeWorkspaceId: activeId,
    terminalsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    diffTabsByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, []])),
    activeItemByWorkspace: Object.fromEntries(workspaces.map((w) => [w.id, null])),
    gitSidebarCollapsed: gitPrefs.gitSidebarCollapsed,
    diffMode: gitPrefs.diffMode,
    gitTab: gitPrefs.gitTab,
    ignoreWhitespace: gitPrefs.ignoreWhitespace,
  });

  createEffect(() => {
    const serialized: PersistedWorkspace[] = state.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      repoRoot: w.repoRoot,
    }));
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(serialized));
    localStorage.setItem(ACTIVE_WS_KEY, state.activeWorkspaceId);
  });

  createEffect(() => {
    localStorage.setItem(
      GIT_PREFS_KEY,
      JSON.stringify({
        gitSidebarCollapsed: state.gitSidebarCollapsed,
        diffMode: state.diffMode,
        gitTab: state.gitTab,
        ignoreWhitespace: state.ignoreWhitespace,
      } satisfies GitPrefs),
    );
  });

  const activeWorkspace = createMemo(
    () => state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null,
  );
  const activeTerminals = createMemo(
    () => state.terminalsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeDiffTabs = createMemo(
    () => state.diffTabsByWorkspace[state.activeWorkspaceId] ?? [],
  );
  const activeItem = createMemo(
    () => state.activeItemByWorkspace[state.activeWorkspaceId] ?? null,
  );

  // Keep the previous default: a fresh workspace with one terminal focuses it.
  // Items are focused directly by their spawn/select actions below.

  const actions = {
    // ── Workspaces ──────────────────────────────────────────────────────
    addWorkspace(name?: string) {
      const count = state.workspaces.length + 1;
      const ws = makeWorkspace(name ?? `Workspace ${count}`);
      setState(produce((s) => {
        s.workspaces.push(ws);
        s.terminalsByWorkspace[ws.id] = [];
        s.diffTabsByWorkspace[ws.id] = [];
        s.activeItemByWorkspace[ws.id] = null;
        s.activeWorkspaceId = ws.id;
      }));
      return ws.id;
    },

    removeWorkspace(id: string) {
      const terms = state.terminalsByWorkspace[id] ?? [];
      for (const t of terms) void terminalApi.closePty(t.ptyId).catch(() => {});
      setState(produce((s) => {
        s.workspaces = s.workspaces.filter((w) => w.id !== id);
        delete s.terminalsByWorkspace[id];
        delete s.diffTabsByWorkspace[id];
        delete s.activeItemByWorkspace[id];
        if (s.workspaces.length === 0) {
          const fresh = makeWorkspace("Main");
          s.workspaces.push(fresh);
          s.terminalsByWorkspace[fresh.id] = [];
          s.diffTabsByWorkspace[fresh.id] = [];
          s.activeItemByWorkspace[fresh.id] = null;
          s.activeWorkspaceId = fresh.id;
        } else if (s.activeWorkspaceId === id) {
          s.activeWorkspaceId = s.workspaces[s.workspaces.length - 1].id;
        }
      }));
    },

    renameWorkspace(id: string, name: string) {
      setState("workspaces", (w) => w.id === id, "name", name.trim() || "Workspace");
    },

    selectWorkspace(id: string) {
      setState("activeWorkspaceId", id);
    },

    setRepoRoot(id: string, repoRoot: string | null) {
      setState("workspaces", (w) => w.id === id, "repoRoot", repoRoot);
    },

    // ── Terminals ───────────────────────────────────────────────────────
    async spawnTerminal(wsId: string) {
      const ws = state.workspaces.find((w) => w.id === wsId);
      if (!ws?.repoRoot) return null;
      const ptyId = await terminalApi.createPty(ws.repoRoot);
      const count = (state.terminalsByWorkspace[wsId]?.length ?? 0) + 1;
      const term: TerminalSession = {
        id: crypto.randomUUID(),
        ptyId,
        label: `Terminal ${count}`,
        cwd: ws.repoRoot,
      };
      setState(produce((s) => {
        s.terminalsByWorkspace[wsId] = [...(s.terminalsByWorkspace[wsId] ?? []), term];
        s.activeItemByWorkspace[wsId] = { type: "terminal", id: term.id };
      }));
      return term.id;
    },

    removeTerminal(wsId: string, termId: string) {
      const list = state.terminalsByWorkspace[wsId] ?? [];
      const term = list.find((t) => t.id === termId);
      if (term) void terminalApi.closePty(term.ptyId).catch(() => {});
      setState(produce((s) => {
        const arr = s.terminalsByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === termId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "terminal" && active.id === termId) {
          // fall back to another terminal, else a diff tab, else nothing
          const nextTerm = arr[arr.length - 1];
          const diffs = s.diffTabsByWorkspace[wsId] ?? [];
          s.activeItemByWorkspace[wsId] = nextTerm
            ? { type: "terminal", id: nextTerm.id }
            : diffs[0]
              ? { type: "diff", id: diffs[0].id }
              : null;
        }
      }));
    },

    selectTerminal(wsId: string, termId: string) {
      setState("activeItemByWorkspace", wsId, { type: "terminal", id: termId });
    },

    // ── Diff tabs ───────────────────────────────────────────────────────
    openDiffTab(wsId: string, filePath: string) {
      const existing = (state.diffTabsByWorkspace[wsId] ?? []).find((d) => d.filePath === filePath);
      if (existing) {
        setState("activeItemByWorkspace", wsId, { type: "diff", id: existing.id });
        return existing.id;
      }
      const tab: DiffTab = { id: crypto.randomUUID(), filePath };
      setState(produce((s) => {
        s.diffTabsByWorkspace[wsId] = [...(s.diffTabsByWorkspace[wsId] ?? []), tab];
        s.activeItemByWorkspace[wsId] = { type: "diff", id: tab.id };
      }));
      return tab.id;
    },

    closeDiffTab(wsId: string, tabId: string) {
      setState(produce((s) => {
        const arr = s.diffTabsByWorkspace[wsId] ?? [];
        const idx = arr.findIndex((t) => t.id === tabId);
        if (idx === -1) return;
        arr.splice(idx, 1);
        const active = s.activeItemByWorkspace[wsId];
        if (active?.type === "diff" && active.id === tabId) {
          const nextDiff = arr[arr.length - 1];
          const terms = s.terminalsByWorkspace[wsId] ?? [];
          s.activeItemByWorkspace[wsId] = nextDiff
            ? { type: "diff", id: nextDiff.id }
            : terms[0]
              ? { type: "terminal", id: terms[0].id }
              : null;
        }
      }));
    },

    selectDiffTab(wsId: string, tabId: string) {
      setState("activeItemByWorkspace", wsId, { type: "diff", id: tabId });
    },

    // ── Git sidebar ─────────────────────────────────────────────────────
    toggleGitSidebar() {
      setState("gitSidebarCollapsed", (v) => !v);
    },
    setGitTab(tab: GitTab) {
      setState("gitTab", tab);
    },
    setDiffMode(mode: DiffMode) {
      setState("diffMode", mode);
    },
    toggleIgnoreWhitespace() {
      setState("ignoreWhitespace", (v) => !v);
    },
  };

  return {
    state,
    activeWorkspace,
    activeTerminals,
    activeDiffTabs,
    activeItem,
    actions,
  } as const;
}

export type AppStore = ReturnType<typeof createAppStore>;
