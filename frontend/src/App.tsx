import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pagesApi } from "@/api/pages";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { TitleBar } from "@/components/TitleBar";
import { WorkspaceSidebar } from "@/components/workspaces/WorkspaceSidebar";
import { WorkspaceTopBar } from "@/components/workspaces/WorkspaceTopBar";
import { WorkspaceTabStrip } from "@/components/tabs/WorkspaceTabStrip";
import { NotionPane } from "@/components/notion/NotionPane";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import type { Page, Workspace, Tab, NotionTab, TerminalTab } from "@/types/tabs";

// ─── Workspace state initializer ─────────────────────────────────────────────

interface WsState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

function initWsState(): WsState {
  try {
    const saved = localStorage.getItem("voidlink-workspaces");
    if (saved) {
      const raw = JSON.parse(saved) as Workspace[];
      if (raw.length > 0) {
        const workspaces = raw.map((w) => ({
          ...w,
          splitTabId: w.splitTabId ?? null,
          focusedPane: w.focusedPane ?? "left" as const,
        }));
        const savedActiveId = localStorage.getItem("voidlink-active-workspace");
        const activeWorkspaceId =
          savedActiveId && workspaces.find((w) => w.id === savedActiveId)
            ? savedActiveId
            : workspaces[0].id;
        return { workspaces, activeWorkspaceId };
      }
    }
  } catch {}
  const ws: Workspace = {
    id: crypto.randomUUID(),
    name: "Main",
    tabs: [],
    activeTabId: null,
    splitTabId: null,
    focusedPane: "left",
  };
  return { workspaces: [ws], activeWorkspaceId: ws.id };
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [pagesMap, setPagesMap] = useState<Record<string, Page[]>>({});
  const [useApi, setUseApi] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wsState, setWsState] = useState<WsState>(initWsState);
  const keydownRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);


  const { workspaces, activeWorkspaceId } = wsState;
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeTab = activeWorkspace?.tabs.find(
    (t) => t.id === activeWorkspace.activeTabId,
  ) ?? null;
  const splitTab = activeWorkspace?.tabs.find(
    (t) => t.id === activeWorkspace.splitTabId,
  ) ?? null;

  // ─── Persist workspaces ─────────────────────────────────────────────────

  const updateWsState = useCallback((fn: (prev: WsState) => WsState) => {
    setWsState((prev) => {
      const next = fn(prev);
      localStorage.setItem("voidlink-workspaces", JSON.stringify(next.workspaces));
      if (next.activeWorkspaceId) {
        localStorage.setItem("voidlink-active-workspace", next.activeWorkspaceId);
      }
      return next;
    });
  }, []);

  // ─── Workspace helpers ──────────────────────────────────────────────────

  const addWorkspace = useCallback(
    (name: string) => {
      const wsId = crypto.randomUUID();
      const pageId = crypto.randomUUID();
      const defaultTab: NotionTab = {
        id: crypto.randomUUID(),
        type: "notion",
        title: "Untitled",
        pageId,
        pagesPanelVisible: true,
      };
      const ws: Workspace = {
        id: wsId,
        name,
        tabs: [defaultTab],
        activeTabId: defaultTab.id,
        splitTabId: null,
        focusedPane: "left",
      };
      updateWsState((prev) => ({
        workspaces: [...prev.workspaces, ws],
        activeWorkspaceId: wsId,
      }));
      const defaultPage: Page = { id: pageId, title: "Untitled", workspaceId: wsId };
      setPagesMap((prev) => {
        const updated = [defaultPage];
        localStorage.setItem(`voidlink-pages-${wsId}`, JSON.stringify(updated));
        return { ...prev, [wsId]: updated };
      });
      if (useApi) {
        pagesApi.create({ id: pageId, workspace_id: wsId }).catch(() => {});
      }
    },
    [updateWsState, useApi],
  );

  const removeWorkspace = useCallback(
    (id: string) => {
      updateWsState((prev) => {
        const wss = prev.workspaces.filter((w) => w.id !== id);
        if (wss.length === 0) {
          const newWs: Workspace = {
            id: crypto.randomUUID(),
            name: "Main",
            tabs: [],
            activeTabId: null,
            splitTabId: null,
            focusedPane: "left",
          };
          return { workspaces: [newWs], activeWorkspaceId: newWs.id };
        }
        const activeId =
          prev.activeWorkspaceId === id
            ? (wss[wss.length - 1]?.id ?? null)
            : prev.activeWorkspaceId;
        return { workspaces: wss, activeWorkspaceId: activeId };
      });
    },
    [updateWsState],
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      updateWsState((prev) => ({ ...prev, activeWorkspaceId: id }));
    },
    [updateWsState],
  );

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) =>
          w.id === id ? { ...w, name } : w,
        ),
      }));
    },
    [updateWsState],
  );

  // ─── Tab helpers ─────────────────────────────────────────────────────────

  const addTab = useCallback(
    (wsId: string, type: "notion" | "terminal") => {
      const tab: Tab =
        type === "notion"
          ? {
              id: crypto.randomUUID(),
              type: "notion",
              title: "New Document",
              pageId: null,
              pagesPanelVisible: true,
            }
          : {
              id: crypto.randomUUID(),
              type: "terminal",
              title: "Terminal",
              sessionId: "",
              cwd: "",
            };
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          if (w.splitTabId && w.focusedPane === "right") {
            return { ...w, tabs: [...w.tabs, tab], splitTabId: tab.id };
          }
          return { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id };
        }),
      }));
    },
    [updateWsState],
  );

  const removeTab = useCallback(
    (wsId: string, tabId: string) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          const tabs = w.tabs.filter((t) => t.id !== tabId);
          // Removing the split tab → close split
          if (w.splitTabId === tabId) {
            return { ...w, tabs, splitTabId: null, focusedPane: "left" as const };
          }
          // Removing the active tab while split is active → promote split tab
          if (w.activeTabId === tabId && w.splitTabId) {
            return { ...w, tabs, activeTabId: w.splitTabId, splitTabId: null, focusedPane: "left" as const };
          }
          // Normal case
          const activeTabId =
            w.activeTabId === tabId
              ? (tabs[tabs.length - 1]?.id ?? null)
              : w.activeTabId;
          return { ...w, tabs, activeTabId };
        }),
      }));
    },
    [updateWsState],
  );

  const selectTab = useCallback(
    (wsId: string, tabId: string) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          if (!w.splitTabId) return { ...w, activeTabId: tabId };
          // In split mode: if clicking tab already in other pane, swap
          if (w.focusedPane === "left" && tabId === w.splitTabId) {
            return { ...w, activeTabId: w.splitTabId, splitTabId: w.activeTabId };
          }
          if (w.focusedPane === "right" && tabId === w.activeTabId) {
            return { ...w, activeTabId: w.splitTabId, splitTabId: w.activeTabId };
          }
          // Assign to focused pane
          if (w.focusedPane === "right") {
            return { ...w, splitTabId: tabId };
          }
          return { ...w, activeTabId: tabId };
        }),
      }));
    },
    [updateWsState],
  );

  const updateTab = useCallback(
    (wsId: string, tabId: string, updates: Partial<Tab>) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) =>
          w.id !== wsId
            ? w
            : {
                ...w,
                tabs: w.tabs.map((t) =>
                  t.id !== tabId ? t : ({ ...t, ...updates } as Tab),
                ),
              },
        ),
      }));
    },
    [updateWsState],
  );

  // ─── Split helpers ─────────────────────────────────────────────────────

  const splitTabAction = useCallback(
    (wsId: string, tabId: string) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          let activeTabId = w.activeTabId;
          if (tabId === activeTabId) {
            // Pick a different tab for left pane
            const idx = w.tabs.findIndex((t) => t.id === tabId);
            const next = w.tabs[idx + 1] ?? w.tabs[idx - 1];
            if (!next) return w; // Only 1 tab, can't split
            activeTabId = next.id;
          }
          return { ...w, splitTabId: tabId, activeTabId, focusedPane: "right" as const };
        }),
      }));
    },
    [updateWsState],
  );

  const closeSplit = useCallback(
    (wsId: string) => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) => {
          if (w.id !== wsId) return w;
          const activeTabId = w.focusedPane === "right" ? w.splitTabId ?? w.activeTabId : w.activeTabId;
          return { ...w, activeTabId, splitTabId: null, focusedPane: "left" as const };
        }),
      }));
    },
    [updateWsState],
  );

  const setFocusedPane = useCallback(
    (wsId: string, pane: "left" | "right") => {
      updateWsState((prev) => ({
        ...prev,
        workspaces: prev.workspaces.map((w) =>
          w.id === wsId ? { ...w, focusedPane: pane } : w,
        ),
      }));
    },
    [updateWsState],
  );

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      // Cmd+T → new notion tab in active workspace
      if (meta && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspaceId) addTab(activeWorkspaceId, "notion");
        return;
      }

      // Cmd+W → close focused pane's tab
      if (meta && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspaceId && activeWorkspace) {
          const tabToClose = activeWorkspace.splitTabId && activeWorkspace.focusedPane === "right"
            ? activeWorkspace.splitTabId
            : activeWorkspace.activeTabId;
          if (tabToClose) removeTab(activeWorkspaceId, tabToClose);
        }
        return;
      }

      // Cmd+\ → toggle split
      if (meta && e.key === "\\") {
        e.preventDefault();
        if (activeWorkspaceId && activeWorkspace) {
          if (activeWorkspace.splitTabId) {
            closeSplit(activeWorkspaceId);
          } else if (activeWorkspace.activeTabId && activeWorkspace.tabs.length > 1) {
            splitTabAction(activeWorkspaceId, activeWorkspace.activeTabId);
          }
        }
        return;
      }

      // Ctrl+Cmd+Left/Right → move focus between panes
      if (e.ctrlKey && e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (activeWorkspaceId && activeWorkspace?.splitTabId) {
          setFocusedPane(activeWorkspaceId, e.key === "ArrowLeft" ? "left" : "right");
        }
        return;
      }

      // Cmd+[ → prev tab in focused pane
      if (meta && e.key === "[" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspace) {
          const tabs = activeWorkspace.tabs;
          const currentTabId = activeWorkspace.splitTabId && activeWorkspace.focusedPane === "right"
            ? activeWorkspace.splitTabId
            : activeWorkspace.activeTabId;
          const idx = tabs.findIndex((t) => t.id === currentTabId);
          if (idx > 0) selectTab(activeWorkspaceId!, tabs[idx - 1].id);
        }
        return;
      }

      // Cmd+] → next tab in focused pane
      if (meta && e.key === "]" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspace) {
          const tabs = activeWorkspace.tabs;
          const currentTabId = activeWorkspace.splitTabId && activeWorkspace.focusedPane === "right"
            ? activeWorkspace.splitTabId
            : activeWorkspace.activeTabId;
          const idx = tabs.findIndex((t) => t.id === currentTabId);
          if (idx < tabs.length - 1) selectTab(activeWorkspaceId!, tabs[idx + 1].id);
        }
        return;
      }

      // Cmd+Shift+[ → prev workspace
      if (meta && e.shiftKey && e.key === "[") {
        e.preventDefault();
        const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        if (idx > 0) selectWorkspace(workspaces[idx - 1].id);
        return;
      }

      // Cmd+Shift+] → next workspace
      if (meta && e.shiftKey && e.key === "]") {
        e.preventDefault();
        const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        if (idx < workspaces.length - 1) selectWorkspace(workspaces[idx + 1].id);
        return;
      }
    };

    if (keydownRef.current) {
      document.removeEventListener("keydown", keydownRef.current);
    }
    keydownRef.current = handler;
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    activeWorkspaceId,
    activeWorkspace,
    activeTab,
    workspaces,
    addTab,
    removeTab,
    selectTab,
    selectWorkspace,
    splitTabAction,
    closeSplit,
    setFocusedPane,
  ]);

  // ─── Scroll-to-tab when active tab changes ─────────────────────────────

  useEffect(() => {
    const container = contentScrollRef.current;
    if (!container || !activeWorkspace?.activeTabId) return;
    const idx = activeWorkspace.tabs.findIndex(
      (t) => t.id === activeWorkspace.activeTabId,
    );
    if (idx < 0) return;
    const targetLeft = idx * container.clientWidth;
    if (Math.abs(container.scrollLeft - targetLeft) > 2) {
      programmaticScroll.current = true;
      container.scrollTo({ left: targetLeft, behavior: "smooth" });
      // Reset flag after scroll animation settles
      setTimeout(() => {
        programmaticScroll.current = false;
      }, 400);
    }
  }, [activeWorkspace?.activeTabId, activeWorkspace?.tabs]);


  // ─── Vibrancy / opacity on mount ─────────────────────────────────────────

  useEffect(() => {
    const opacity = localStorage.getItem("voidlink-opacity") ?? "0.85";
    document.documentElement.style.setProperty("--bg-opacity", opacity);

    const vibrancy = localStorage.getItem("voidlink-vibrancy") ?? "hudWindow";
    const win = getCurrentWindow();
    if (vibrancy === "off") {
      win.clearEffects().catch(() => {});
    } else {
      win.setEffects({ effects: [vibrancy as never], state: "active" }).catch(() => {});
    }
  }, []);

  // ─── Pages (per-workspace) ──────────────────────────────────────────────

  const getWorkspacePages = useCallback(
    (wsId: string): Page[] => pagesMap[wsId] ?? [],
    [pagesMap],
  );

  const persistWorkspacePages = useCallback((wsId: string, pages: Page[]) => {
    localStorage.setItem(`voidlink-pages-${wsId}`, JSON.stringify(pages));
  }, []);

  // Migrate legacy global pages to first workspace on mount
  useEffect(() => {
    const globalPages = localStorage.getItem("voidlink-pages");
    if (globalPages && workspaces.length > 0) {
      const firstWsId = workspaces[0].id;
      if (!localStorage.getItem(`voidlink-pages-${firstWsId}`)) {
        localStorage.setItem(`voidlink-pages-${firstWsId}`, globalPages);
        localStorage.removeItem("voidlink-pages");
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Stable key — only changes when workspace IDs are added/removed, not on tab/rename mutations
  const wsIds = workspaces.map((w) => w.id).join(",");

  // Load pages for each workspace
  useEffect(() => {
    const ids = wsIds.split(",").filter(Boolean);
    const loadPages = async () => {
      const newMap: Record<string, Page[]> = {};
      for (const wsId of ids) {
        try {
          const list = await pagesApi.list(wsId);
          newMap[wsId] = list.map((p) => ({
            id: p.id,
            title: p.title,
            parentId: p.parent_id ?? null,
            workspaceId: wsId,
          }));
          localStorage.setItem(`voidlink-pages-${wsId}`, JSON.stringify(newMap[wsId]));
        } catch {
          setUseApi(false);
          const raw = localStorage.getItem(`voidlink-pages-${wsId}`);
          if (raw) {
            try {
              newMap[wsId] = JSON.parse(raw) as Page[];
            } catch {}
          }
          if (!newMap[wsId]) newMap[wsId] = [];
        }
      }
      setPagesMap(newMap);
    };
    loadPages();
  }, [wsIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewPage = useCallback(async (workspaceId: string): Promise<string | null> => {
    if (useApi) {
      try {
        const page = await pagesApi.create({ workspace_id: workspaceId });
        const newPage: Page = { id: page.id, title: page.title, workspaceId };
        setPagesMap((prev) => {
          const updated = [...(prev[workspaceId] ?? []), newPage];
          persistWorkspacePages(workspaceId, updated);
          return { ...prev, [workspaceId]: updated };
        });
        return page.id;
      } catch {}
    }
    const id = crypto.randomUUID();
    const newPage: Page = { id, title: "Untitled", workspaceId };
    setPagesMap((prev) => {
      const updated = [...(prev[workspaceId] ?? []), newPage];
      persistWorkspacePages(workspaceId, updated);
      return { ...prev, [workspaceId]: updated };
    });
    return id;
  }, [useApi, persistWorkspacePages]);

  const handleDeletePage = useCallback(
    (workspaceId: string, id: string) => {
      setPagesMap((prev) => {
        const updated = (prev[workspaceId] ?? []).filter((p) => p.id !== id);
        persistWorkspacePages(workspaceId, updated);
        return { ...prev, [workspaceId]: updated };
      });
      localStorage.removeItem(`voidlink-content-${id}`);
      if (useApi) pagesApi.delete(id).catch(() => {});
    },
    [useApi, persistWorkspacePages],
  );

  const handleCreateChildPage = useCallback(
    (workspaceId: string, parentId: string | null): string => {
      const id = crypto.randomUUID();
      const newPage: Page = { id, title: "Untitled", parentId, workspaceId };
      setPagesMap((prev) => {
        const updated = [...(prev[workspaceId] ?? []), newPage];
        persistWorkspacePages(workspaceId, updated);
        return { ...prev, [workspaceId]: updated };
      });
      if (useApi) {
        pagesApi
          .create({ id, title: "Untitled", parent_id: parentId ?? undefined, workspace_id: workspaceId })
          .catch(() => {});
      }
      return id;
    },
    [useApi, persistWorkspacePages],
  );

  const handlePageTitleChange = useCallback(
    (workspaceId: string, pageId: string, title: string) => {
      setPagesMap((prev) => {
        const updated = (prev[workspaceId] ?? []).map((p) =>
          p.id === pageId ? { ...p, title } : p,
        );
        persistWorkspacePages(workspaceId, updated);
        return { ...prev, [workspaceId]: updated };
      });
    },
    [persistWorkspacePages],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  const renderTabContent = (tab: Tab) => {
    if (tab.type === "notion") {
      return (
        <NotionPane
          tab={tab as NotionTab}
          pages={getWorkspacePages(activeWorkspaceId!)}
          useApi={useApi}
          onUpdateTab={(updates) =>
            updateTab(activeWorkspaceId!, tab.id, updates as Partial<Tab>)
          }
          onNewPage={() => handleNewPage(activeWorkspaceId!)}
          onDeletePage={(id) => handleDeletePage(activeWorkspaceId!, id)}
          onPageTitleChange={(pid, t) => handlePageTitleChange(activeWorkspaceId!, pid, t)}
          onCreateChildPage={(pid) => handleCreateChildPage(activeWorkspaceId!, pid)}
        />
      );
    }
    return (
      <TerminalPane
        tab={tab as TerminalTab}
        onUpdateTab={(updates) =>
          updateTab(activeWorkspaceId!, tab.id, updates as Partial<Tab>)
        }
        onClose={() => removeTab(activeWorkspaceId!, tab.id)}
      />
    );
  };

  return (
    <div className="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {/* Draggable macOS title bar — full width, hosts traffic lights */}
      <TitleBar />

      {/* Sidebar + content row */}
      <div className="flex flex-1 overflow-hidden">
      {/* Global workspace sidebar */}
      <WorkspaceSidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={selectWorkspace}
        onAddWorkspace={addWorkspace}
        onOpenSettings={() => setSettingsOpen(true)}
        onRenameWorkspace={renameWorkspace}
      />

      {/* Main content column */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Workspace top bar */}
        <WorkspaceTopBar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelectWorkspace={selectWorkspace}
          onAddWorkspace={addWorkspace}
          onRemoveWorkspace={removeWorkspace}
          onRenameWorkspace={renameWorkspace}
        />

        {/* Tab strip for active workspace */}
        {activeWorkspace && (
          <WorkspaceTabStrip
            tabs={activeWorkspace.tabs}
            activeTabId={activeWorkspace.activeTabId}
            splitTabId={activeWorkspace.splitTabId}
            focusedPane={activeWorkspace.focusedPane}
            onSelectTab={(tabId) => selectTab(activeWorkspaceId!, tabId)}
            onCloseTab={(tabId) => removeTab(activeWorkspaceId!, tabId)}
            onAddTab={(type) => addTab(activeWorkspaceId!, type)}
            onRenameTab={(tabId, title) =>
              updateTab(activeWorkspaceId!, tabId, { title } as Partial<Tab>)
            }
            onSplitTab={(tabId) => splitTabAction(activeWorkspaceId!, tabId)}
            onCloseSplit={() => closeSplit(activeWorkspaceId!)}
          />
        )}

        {/* Content area */}
        {activeWorkspace?.tabs.length === 0 ? (
          <main className="flex flex-1 overflow-hidden">
            <EmptyWorkspaceState
              onAddNotion={() => addTab(activeWorkspaceId!, "notion")}
              onAddTerminal={() => addTab(activeWorkspaceId!, "terminal")}
            />
          </main>
        ) : activeWorkspace?.splitTabId ? (
          /* Split mode — two equal-width columns */
          <div className="flex flex-1 overflow-hidden">
            <div
              className={`flex-1 overflow-hidden ${
                activeWorkspace.focusedPane === "left" ? "border-t-2 border-primary" : ""
              }`}
              onMouseDown={() => setFocusedPane(activeWorkspaceId!, "left")}
            >
              {activeTab && renderTabContent(activeTab)}
            </div>
            <div className="w-px bg-border flex-shrink-0" />
            <div
              className={`flex-1 overflow-hidden ${
                activeWorkspace.focusedPane === "right" ? "border-t-2 border-primary" : ""
              }`}
              onMouseDown={() => setFocusedPane(activeWorkspaceId!, "right")}
            >
              {splitTab && renderTabContent(splitTab)}
            </div>
          </div>
        ) : (
          /* Single-pane mode — horizontal scroll container */
          <main
            ref={contentScrollRef}
            className="flex flex-1 overflow-x-auto overflow-y-hidden scrollbar-thin"
          >
            {activeWorkspace?.tabs.map((tab) => (
              <div
                key={tab.id}
                className="w-full h-full flex-shrink-0"
              >
                {renderTabContent(tab)}
              </div>
            ))}
          </main>
        )}
      </div>
      </div>

      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}

function EmptyWorkspaceState({
  onAddNotion,
  onAddTerminal,
}: {
  onAddNotion: () => void;
  onAddTerminal: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted-foreground">
      <div className="text-center">
        <h2 className="text-xl font-medium mb-3">Empty workspace</h2>
        <p className="text-sm mb-4">Open a new tab to get started.</p>
        <div className="flex gap-2 justify-center">
          <button
            onClick={onAddNotion}
            className="px-4 py-2 rounded-md bg-accent text-accent-foreground text-sm hover:bg-accent/80 transition-colors"
          >
            New Document
          </button>
          <button
            onClick={onAddTerminal}
            className="px-4 py-2 rounded-md border border-border text-sm hover:bg-accent/40 transition-colors"
          >
            New Terminal
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
