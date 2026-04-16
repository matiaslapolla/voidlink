import { createStore, produce } from "solid-js/store";
import { createEffect } from "solid-js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ColumnId = "left" | "center" | "right";
export type ColumnOrder = [ColumnId, ColumnId, ColumnId];

export type CenterTabType =
  | "repository"
  | "contextBuilder"
  | "workflow"
  | "aiAgent"
  | "promptStudio"
  | "terminal"
  | "file"
  | "image"
  | "svg"
  | "diff";

/** Kept for backward compat in NavTree tabTarget */
export type CenterTabId = CenterTabType;

export type BottomTabId = "terminal" | "git" | "logs" | "agentOutput";

export interface TabMeta {
  filePath?: string;
  cwd?: string;
  ptyId?: string;
  scrollToLine?: number;
}

export interface TabInstance {
  id: string;
  type: CenterTabType;
  label: string;
  meta: TabMeta;
  pinned?: boolean;
  /** Preview tabs are replaced when another file is single-clicked */
  preview?: boolean;
}

export interface CenterTabState {
  tabs: TabInstance[];
  activeTabId: string;
}

export interface LayoutStoreState {
  columnOrder: ColumnOrder;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;

  bottomPaneOpen: boolean;
  bottomPaneHeight: number;
  activeBottomTab: BottomTabId;

  centerTabsByWorkspace: Record<string, CenterTabState>;

  leftTreeExpanded: Record<string, boolean>;
}

export interface LayoutStoreActions {
  setColumnOrder: (order: ColumnOrder) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;

  /** Open or focus a tab instance. For singletons, focuses existing. */
  openTab: (wsId: string, tab: TabInstance) => void;
  closeTab: (wsId: string, tabId: string) => void;
  setActiveTab: (wsId: string, tabId: string) => void;
  reorderTabs: (wsId: string, tabIds: string[]) => void;
  initWorkspaceTabs: (wsId: string, defaultType?: CenterTabType) => void;
  removeWorkspaceTabs: (wsId: string) => void;

  /** Open a file as a preview tab (single-click). Replaces any existing preview tab. */
  openFile: (wsId: string, filePath: string) => void;

  /** Open a file as a pinned tab (double-click). Promotes preview if it matches. */
  openFilePinned: (wsId: string, filePath: string) => void;

  /** Open a file and scroll to a specific line. */
  openFileAtLine: (wsId: string, filePath: string, line: number) => void;

  /** Pin a tab (convert from preview to permanent). */
  pinTab: (wsId: string, tabId: string) => void;

  /** Convenience: open a singleton tab (repository, workflow, etc.) */
  openSingleton: (wsId: string, type: CenterTabType, label?: string) => void;

  toggleBottomPane: (tabId: BottomTabId) => void;
  setBottomPaneHeight: (h: number) => void;
  setActiveBottomTab: (tabId: BottomTabId) => void;
  closeBottomPane: () => void;

  toggleLeftTreeNode: (nodeId: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const SINGLETON_TYPES = new Set<CenterTabType>([
  "repository", "contextBuilder", "workflow", "aiAgent", "promptStudio",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

function singletonId(type: CenterTabType): string {
  return `singleton:${type}`;
}

function labelForType(type: CenterTabType): string {
  const map: Record<CenterTabType, string> = {
    repository: "Repository",
    contextBuilder: "Context Builder",
    workflow: "Workflow",
    aiAgent: "AI Agent",
    promptStudio: "Prompt Studio",
    terminal: "Terminal",
    file: "File",
    image: "Image",
    svg: "SVG",
    diff: "Diff",
  };
  return map[type] || type;
}

function makeSingletonTab(type: CenterTabType, label?: string): TabInstance {
  return {
    id: singletonId(type),
    type,
    label: label ?? labelForType(type),
    meta: {},
    pinned: true,
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_LEFT_WIDTH = 264;
const DEFAULT_RIGHT_WIDTH = 280;
const DEFAULT_BOTTOM_HEIGHT = 240;

const DEFAULT_LAYOUT: LayoutStoreState = {
  columnOrder: ["left", "center", "right"],
  leftCollapsed: false,
  rightCollapsed: false,
  leftWidth: DEFAULT_LEFT_WIDTH,
  rightWidth: DEFAULT_RIGHT_WIDTH,
  bottomPaneOpen: false,
  bottomPaneHeight: DEFAULT_BOTTOM_HEIGHT,
  activeBottomTab: "terminal",
  centerTabsByWorkspace: {},
  leftTreeExpanded: {},
};

// ─── Persistence ─────────────────────────────────────────────────────────────

const LAYOUT_STORAGE_KEY = "voidlink-layout-v2";
const LAYOUT_STORAGE_KEY_V1 = "voidlink-layout-v1";

function migrateV1(raw: any): LayoutStoreState {
  const state = { ...DEFAULT_LAYOUT, ...raw };
  // Convert old CenterTabId[] format to TabInstance[]
  if (state.centerTabsByWorkspace) {
    const migrated: Record<string, CenterTabState> = {};
    for (const [wsId, entry] of Object.entries(state.centerTabsByWorkspace)) {
      const old = entry as any;
      if (Array.isArray(old.tabs) && typeof old.tabs[0] === "string") {
        // Old format: tabs is string[]
        const tabs: TabInstance[] = (old.tabs as string[])
          .filter((t: string) => t !== "editor" && t !== "promptStudio")
          .map((t: string) => makeSingletonTab(t as CenterTabType));
        const activeType = old.activeTab === "editor" || old.activeTab === "promptStudio"
          ? "repository" : old.activeTab;
        migrated[wsId] = {
          tabs: tabs.length > 0 ? tabs : [makeSingletonTab("repository")],
          activeTabId: singletonId(activeType),
        };
      } else {
        // Already new format or unknown
        migrated[wsId] = old;
      }
    }
    state.centerTabsByWorkspace = migrated;
  }
  // Remove deprecated fields
  delete state.editorFilePath;
  return state;
}

function loadPersistedLayout(): LayoutStoreState {
  try {
    // Try v2 first
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_LAYOUT, ...parsed };
    }
    // Migrate from v1
    const v1 = localStorage.getItem(LAYOUT_STORAGE_KEY_V1);
    if (v1) {
      const parsed = JSON.parse(v1);
      const migrated = migrateV1(parsed);
      localStorage.removeItem(LAYOUT_STORAGE_KEY_V1);
      return migrated;
    }
  } catch {
    // ignore corrupted data
  }
  return { ...DEFAULT_LAYOUT };
}

// ─── Store factory ───────────────────────────────────────────────────────────

export function createLayoutStore() {
  const initial = loadPersistedLayout();
  const [store, setStore] = createStore<LayoutStoreState>(initial);

  // Persist on change (debounced to avoid blocking during rapid resize/drag)
  let persistTimer: ReturnType<typeof setTimeout>;
  createEffect(() => {
    const snapshot = {
      columnOrder: store.columnOrder,
      leftCollapsed: store.leftCollapsed,
      rightCollapsed: store.rightCollapsed,
      leftWidth: store.leftWidth,
      rightWidth: store.rightWidth,
      bottomPaneOpen: store.bottomPaneOpen,
      bottomPaneHeight: store.bottomPaneHeight,
      activeBottomTab: store.activeBottomTab,
      centerTabsByWorkspace: store.centerTabsByWorkspace,
      leftTreeExpanded: store.leftTreeExpanded,
    };
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(snapshot));
    }, 300);
  });

  const actions: LayoutStoreActions = {
    setColumnOrder: (order) => setStore("columnOrder", order),

    toggleLeft: () => setStore("leftCollapsed", (v) => !v),
    toggleRight: () => setStore("rightCollapsed", (v) => !v),
    setLeftWidth: (w) => setStore("leftWidth", w),
    setRightWidth: (w) => setStore("rightWidth", w),

    openTab: (wsId, tab) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) {
            s.centerTabsByWorkspace[wsId] = { tabs: [tab], activeTabId: tab.id };
            return;
          }
          const entry = s.centerTabsByWorkspace[wsId];
          const existing = entry.tabs.find((t) => t.id === tab.id);
          if (!existing) entry.tabs.push(tab);
          entry.activeTabId = tab.id;
        }),
      );
    },

    closeTab: (wsId, tabId) => {
      setStore(
        produce((s) => {
          const entry = s.centerTabsByWorkspace[wsId];
          if (!entry) return;
          const idx = entry.tabs.findIndex((t) => t.id === tabId);
          if (idx === -1) return;
          entry.tabs.splice(idx, 1);
          if (entry.activeTabId === tabId) {
            const newIdx = Math.min(idx, entry.tabs.length - 1);
            entry.activeTabId = entry.tabs[newIdx]?.id ?? "";
            if (entry.tabs.length === 0) {
              const repo = makeSingletonTab("repository");
              entry.tabs.push(repo);
              entry.activeTabId = repo.id;
            }
          }
        }),
      );
    },

    setActiveTab: (wsId, tabId) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) return;
          s.centerTabsByWorkspace[wsId].activeTabId = tabId;
        }),
      );
    },

    reorderTabs: (wsId, tabIds) => {
      setStore(
        produce((s) => {
          const entry = s.centerTabsByWorkspace[wsId];
          if (!entry) return;
          const tabMap = new Map(entry.tabs.map((t) => [t.id, t]));
          entry.tabs = tabIds.map((id) => tabMap.get(id)!).filter(Boolean);
        }),
      );
    },

    initWorkspaceTabs: (wsId, defaultType) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) {
            const type = defaultType ?? "repository";
            const tab = SINGLETON_TYPES.has(type)
              ? makeSingletonTab(type)
              : makeSingletonTab("repository");
            s.centerTabsByWorkspace[wsId] = {
              tabs: [tab],
              activeTabId: tab.id,
            };
          }
        }),
      );
    },

    removeWorkspaceTabs: (wsId) => {
      setStore(
        produce((s) => {
          delete s.centerTabsByWorkspace[wsId];
        }),
      );
    },

    openFile: (wsId, filePath) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) {
            s.centerTabsByWorkspace[wsId] = { tabs: [], activeTabId: "" };
          }
          const entry = s.centerTabsByWorkspace[wsId];
          // If there's already a pinned tab for this file, just activate it
          const existing = entry.tabs.find(
            (t) => (t.type === "file" || t.type === "image" || t.type === "svg") &&
              t.meta.filePath === filePath,
          );
          if (existing) {
            entry.activeTabId = existing.id;
            return;
          }
          // Determine type from extension
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const type: CenterTabType = IMAGE_EXTS.has(ext)
            ? "image"
            : ext === "svg"
              ? "svg"
              : "file";
          const label = filePath.split("/").pop() ?? filePath;
          const tab: TabInstance = {
            id: crypto.randomUUID(),
            type,
            label,
            meta: { filePath },
            preview: true,
          };
          // Replace existing preview tab if any
          const previewIdx = entry.tabs.findIndex((t) => t.preview);
          if (previewIdx !== -1) {
            entry.tabs.splice(previewIdx, 1, tab);
          } else {
            entry.tabs.push(tab);
          }
          entry.activeTabId = tab.id;
        }),
      );
    },

    openFileAtLine: (wsId, filePath, line) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) {
            s.centerTabsByWorkspace[wsId] = { tabs: [], activeTabId: "" };
          }
          const entry = s.centerTabsByWorkspace[wsId];
          // If there's already a tab for this file, activate it and set scrollToLine
          const existing = entry.tabs.find(
            (t) => (t.type === "file" || t.type === "image" || t.type === "svg") &&
              t.meta.filePath === filePath,
          );
          if (existing) {
            existing.meta.scrollToLine = line;
            entry.activeTabId = existing.id;
            return;
          }
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const type: CenterTabType = IMAGE_EXTS.has(ext)
            ? "image"
            : ext === "svg"
              ? "svg"
              : "file";
          const label = filePath.split("/").pop() ?? filePath;
          const tab: TabInstance = {
            id: crypto.randomUUID(),
            type,
            label,
            meta: { filePath, scrollToLine: line },
            preview: true,
          };
          const previewIdx = entry.tabs.findIndex((t) => t.preview);
          if (previewIdx !== -1) {
            entry.tabs.splice(previewIdx, 1, tab);
          } else {
            entry.tabs.push(tab);
          }
          entry.activeTabId = tab.id;
        }),
      );
    },

    openFilePinned: (wsId, filePath) => {
      setStore(
        produce((s) => {
          if (!s.centerTabsByWorkspace[wsId]) {
            s.centerTabsByWorkspace[wsId] = { tabs: [], activeTabId: "" };
          }
          const entry = s.centerTabsByWorkspace[wsId];
          // If tab already exists for this file, pin it and activate
          const existing = entry.tabs.find(
            (t) => (t.type === "file" || t.type === "image" || t.type === "svg") &&
              t.meta.filePath === filePath,
          );
          if (existing) {
            existing.preview = false;
            entry.activeTabId = existing.id;
            return;
          }
          // Create new pinned tab
          const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
          const type: CenterTabType = IMAGE_EXTS.has(ext)
            ? "image"
            : ext === "svg"
              ? "svg"
              : "file";
          const label = filePath.split("/").pop() ?? filePath;
          const tab: TabInstance = {
            id: crypto.randomUUID(),
            type,
            label,
            meta: { filePath },
          };
          entry.tabs.push(tab);
          entry.activeTabId = tab.id;
        }),
      );
    },

    pinTab: (wsId, tabId) => {
      setStore(
        produce((s) => {
          const entry = s.centerTabsByWorkspace[wsId];
          if (!entry) return;
          const tab = entry.tabs.find((t) => t.id === tabId);
          if (tab) tab.preview = false;
        }),
      );
    },

    openSingleton: (wsId, type, label) => {
      const tab = makeSingletonTab(type, label);
      actions.openTab(wsId, tab);
    },

    toggleBottomPane: (tabId) => {
      setStore(
        produce((s) => {
          if (!s.bottomPaneOpen) {
            s.bottomPaneOpen = true;
            s.activeBottomTab = tabId;
          } else if (s.activeBottomTab === tabId) {
            s.bottomPaneOpen = false;
          } else {
            s.activeBottomTab = tabId;
          }
        }),
      );
    },

    setBottomPaneHeight: (h) => setStore("bottomPaneHeight", h),
    setActiveBottomTab: (tabId) => setStore("activeBottomTab", tabId),
    closeBottomPane: () => setStore("bottomPaneOpen", false),

    toggleLeftTreeNode: (nodeId) => {
      setStore(
        produce((s) => {
          s.leftTreeExpanded[nodeId] = !s.leftTreeExpanded[nodeId];
        }),
      );
    },
  };

  return [store, actions] as const;
}
