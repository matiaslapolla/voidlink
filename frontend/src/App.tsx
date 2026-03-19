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
import type { Page } from "@/components/notion/PageTreePanel";
import type { Workspace, Tab, NotionTab, TerminalTab } from "@/types/tabs";

// ─── Workspace state initializer ─────────────────────────────────────────────

interface WsState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

function initWsState(): WsState {
  try {
    const saved = localStorage.getItem("voidlink-workspaces");
    if (saved) {
      const workspaces = JSON.parse(saved) as Workspace[];
      if (workspaces.length > 0) {
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
  };
  return { workspaces: [ws], activeWorkspaceId: ws.id };
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [pages, setPages] = useState<Page[]>([]);
  const [useApi, setUseApi] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wsState, setWsState] = useState<WsState>(initWsState);
  const keydownRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef(false);
  const scrollDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { workspaces, activeWorkspaceId } = wsState;
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const activeTab = activeWorkspace?.tabs.find(
    (t) => t.id === activeWorkspace.activeTabId,
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
      const ws: Workspace = {
        id: crypto.randomUUID(),
        name,
        tabs: [],
        activeTabId: null,
      };
      updateWsState((prev) => ({
        workspaces: [...prev.workspaces, ws],
        activeWorkspaceId: ws.id,
      }));
    },
    [updateWsState],
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
        workspaces: prev.workspaces.map((w) =>
          w.id === wsId
            ? { ...w, tabs: [...w.tabs, tab], activeTabId: tab.id }
            : w,
        ),
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
        workspaces: prev.workspaces.map((w) =>
          w.id === wsId ? { ...w, activeTabId: tabId } : w,
        ),
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

      // Cmd+W → close active tab
      if (meta && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspaceId && activeTab) {
          removeTab(activeWorkspaceId, activeTab.id);
        }
        return;
      }

      // Cmd+[ → prev tab
      if (meta && e.key === "[" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspace) {
          const tabs = activeWorkspace.tabs;
          const idx = tabs.findIndex((t) => t.id === activeWorkspace.activeTabId);
          if (idx > 0) selectTab(activeWorkspaceId!, tabs[idx - 1].id);
        }
        return;
      }

      // Cmd+] → next tab
      if (meta && e.key === "]" && !e.shiftKey) {
        e.preventDefault();
        if (activeWorkspace) {
          const tabs = activeWorkspace.tabs;
          const idx = tabs.findIndex((t) => t.id === activeWorkspace.activeTabId);
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

  // ─── Sync scroll position back to tab selection ───────────────────────

  const handleContentScroll = useCallback(() => {
    if (programmaticScroll.current) return;
    if (scrollDebounce.current) clearTimeout(scrollDebounce.current);
    scrollDebounce.current = setTimeout(() => {
      const container = contentScrollRef.current;
      if (!container || !activeWorkspace || !activeWorkspaceId) return;
      const idx = Math.round(container.scrollLeft / container.clientWidth);
      const tab = activeWorkspace.tabs[idx];
      if (tab && tab.id !== activeWorkspace.activeTabId) {
        selectTab(activeWorkspaceId, tab.id);
      }
    }, 100);
  }, [activeWorkspace, activeWorkspaceId, selectTab]);

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

  // ─── Pages ───────────────────────────────────────────────────────────────

  useEffect(() => {
    pagesApi
      .list()
      .then((list) => {
        const mapped = list.map((p) => ({
          id: p.id,
          title: p.title,
          parentId: p.parent_id ?? null,
        }));
        setPages(mapped);
        localStorage.setItem("voidlink-pages", JSON.stringify(mapped));
      })
      .catch(() => {
        setUseApi(false);
        const raw = localStorage.getItem("voidlink-pages");
        if (raw) {
          try {
            setPages(JSON.parse(raw) as Page[]);
          } catch {}
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewPage = useCallback(async (): Promise<string | null> => {
    if (useApi) {
      try {
        const page = await pagesApi.create();
        const newPage: Page = { id: page.id, title: page.title };
        setPages((prev) => {
          const updated = [...prev, newPage];
          localStorage.setItem("voidlink-pages", JSON.stringify(updated));
          return updated;
        });
        return page.id;
      } catch {}
    }
    const id = crypto.randomUUID();
    const newPage: Page = { id, title: "Untitled" };
    setPages((prev) => {
      const updated = [...prev, newPage];
      localStorage.setItem("voidlink-pages", JSON.stringify(updated));
      return updated;
    });
    return id;
  }, [useApi]);

  const handleDeletePage = useCallback(
    (id: string) => {
      setPages((prev) => {
        const updated = prev.filter((p) => p.id !== id);
        localStorage.setItem("voidlink-pages", JSON.stringify(updated));
        return updated;
      });
      localStorage.removeItem(`voidlink-content-${id}`);
      if (useApi) pagesApi.delete(id).catch(() => {});
    },
    [useApi],
  );

  const handleCreateChildPage = useCallback(
    (parentId: string | null): string => {
      const id = crypto.randomUUID();
      const newPage: Page = { id, title: "Untitled", parentId };
      setPages((prev) => {
        const updated = [...prev, newPage];
        localStorage.setItem("voidlink-pages", JSON.stringify(updated));
        return updated;
      });
      if (useApi) {
        pagesApi
          .create({ id, title: "Untitled", parent_id: parentId ?? undefined })
          .catch(() => {});
      }
      return id;
    },
    [useApi],
  );

  const handlePageTitleChange = useCallback(
    (pageId: string, title: string) => {
      setPages((prev) => {
        const updated = prev.map((p) => (p.id === pageId ? { ...p, title } : p));
        localStorage.setItem("voidlink-pages", JSON.stringify(updated));
        return updated;
      });
    },
    [],
  );

  // ─── Render ───────────────────────────────────────────────────────────────

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
            onSelectTab={(tabId) => selectTab(activeWorkspaceId!, tabId)}
            onCloseTab={(tabId) => removeTab(activeWorkspaceId!, tabId)}
            onAddTab={(type) => addTab(activeWorkspaceId!, type)}
            onRenameTab={(tabId, title) =>
              updateTab(activeWorkspaceId!, tabId, { title } as Partial<Tab>)
            }
          />
        )}

        {/* Content area — horizontal scroll container (niri-style) */}
        <main
          ref={contentScrollRef}
          className="flex flex-1 overflow-x-auto overflow-y-hidden scrollbar-thin"
          style={{ scrollSnapType: "x mandatory", scrollBehavior: "smooth" }}
          onScroll={handleContentScroll}
        >
          {activeWorkspace?.tabs.length === 0 && (
            <EmptyWorkspaceState
              onAddNotion={() => addTab(activeWorkspaceId!, "notion")}
              onAddTerminal={() => addTab(activeWorkspaceId!, "terminal")}
            />
          )}
          {activeWorkspace?.tabs.map((tab) => (
            <div
              key={tab.id}
              className="w-full h-full flex-shrink-0"
              style={{ scrollSnapAlign: "start" }}
            >
              {tab.type === "notion" ? (
                <NotionPane
                  tab={tab as NotionTab}
                  pages={pages}
                  useApi={useApi}
                  onUpdateTab={(updates) =>
                    updateTab(activeWorkspaceId!, tab.id, updates as Partial<Tab>)
                  }
                  onNewPage={handleNewPage}
                  onDeletePage={handleDeletePage}
                  onPageTitleChange={handlePageTitleChange}
                  onCreateChildPage={handleCreateChildPage}
                />
              ) : (
                <TerminalPane
                  tab={tab as TerminalTab}
                  onUpdateTab={(updates) =>
                    updateTab(activeWorkspaceId!, tab.id, updates as Partial<Tab>)
                  }
                />
              )}
            </div>
          ))}
        </main>
      </div>
      </div>

      <SettingsPanel open={settingsOpen} onOpenChange={setSettingsOpen} />
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
