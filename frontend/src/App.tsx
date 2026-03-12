import { useState, useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Editor } from "@/components/editor/Editor";
import { PageSidebar } from "@/components/sidebar/PageSidebar";
import type { Page } from "@/components/sidebar/PageSidebar";
import { pagesApi } from "@/api/pages";
import { SettingsPanel } from "@/components/settings/SettingsPanel";

function App() {
  const [pages, setPages] = useState<Page[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [loadedContent, setLoadedContent] = useState<{ id: string; html: string } | null>(null);
  const [useApi, setUseApi] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Restore opacity and vibrancy from localStorage on mount
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

  // Load pages on mount
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
        if (mapped.length > 0 && !activePageId) {
          setActivePageId(mapped[0].id);
        }
      })
      .catch(() => {
        setUseApi(false);
        const raw = localStorage.getItem("voidlink-pages");
        if (raw) {
          const local = JSON.parse(raw) as Page[];
          setPages(local);
          if (local.length > 0) setActivePageId(local[0].id);
        }
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load content when page changes — clear first so editor never mounts with stale content
  useEffect(() => {
    if (!activePageId) {
      setLoadedContent(null);
      return;
    }
    setLoadedContent(null);
    const id = activePageId;
    if (useApi) {
      pagesApi
        .get(id)
        .then((p) => setLoadedContent({ id, html: p.content }))
        .catch(() => {
          setLoadedContent({
            id,
            html: localStorage.getItem(`voidlink-content-${id}`) ?? "",
          });
        });
    } else {
      setLoadedContent({
        id,
        html: localStorage.getItem(`voidlink-content-${id}`) ?? "",
      });
    }
  }, [activePageId, useApi]);

  const extractTitle = (html: string): string => {
    const match = html.match(/^<[^>]+>([\s\S]*?)<\/[^>]+>/);
    if (match) {
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      return text.slice(0, 60) || "Untitled";
    }
    return "Untitled";
  };

  const handleNewPage = useCallback(async () => {
    if (useApi) {
      try {
        const page = await pagesApi.create();
        const newPage = { id: page.id, title: page.title };
        setPages((prev) => [...prev, newPage]);
        setActivePageId(page.id);
        return;
      } catch {
        // fall through to localStorage
      }
    }
    const id = crypto.randomUUID();
    const newPage: Page = { id, title: "Untitled" };
    setPages((prev) => {
      const updated = [...prev, newPage];
      localStorage.setItem("voidlink-pages", JSON.stringify(updated));
      return updated;
    });
    setActivePageId(id);
  }, [useApi]);

  const handleDeletePage = useCallback(
    (id: string) => {
      setPages((prev) => {
        const updated = prev.filter((p) => p.id !== id);
        localStorage.setItem("voidlink-pages", JSON.stringify(updated));
        return updated;
      });
      if (activePageId === id) {
        setActivePageId(null);
      }
      localStorage.removeItem(`voidlink-content-${id}`);
      if (useApi) {
        pagesApi.delete(id).catch(() => {});
      }
    },
    [activePageId, useApi],
  );

  const handleCreateChildPage = useCallback((): string => {
    const parentId = activePageId;
    const id = crypto.randomUUID();
    const newPage: Page = { id, title: "Untitled", parentId };
    setPages((prev) => {
      const updated = [...prev, newPage];
      localStorage.setItem("voidlink-pages", JSON.stringify(updated));
      return updated;
    });
    if (useApi) {
      pagesApi.create({ id, title: "Untitled", parent_id: parentId ?? undefined }).catch(() => {});
    }
    return id;
  }, [activePageId, useApi]);

  const handleUpdate = useCallback(
    (html: string) => {
      if (!activePageId) return;
      const title = extractTitle(html);

      localStorage.setItem(`voidlink-content-${activePageId}`, html);
      setPages((prev) => {
        const updated = prev.map((p) =>
          p.id === activePageId ? { ...p, title } : p,
        );
        localStorage.setItem("voidlink-pages", JSON.stringify(updated));
        return updated;
      });

      if (useApi) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          pagesApi.update(activePageId, { title, content: html }).catch(() => {});
        }, 500);
      }
    },
    [activePageId, useApi],
  );

  return (
    <div className="flex h-screen bg-background text-foreground">
      <PageSidebar
        pages={pages}
        activePage={activePageId}
        onSelectPage={setActivePageId}
        onNewPage={handleNewPage}
        onDeletePage={handleDeletePage}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex-1 flex flex-col">
        {activePageId && loadedContent?.id === activePageId ? (
          <Editor
            key={activePageId}
            content={loadedContent.html}
            onUpdate={handleUpdate}
            onCreateChildPage={handleCreateChildPage}
            onSelectPage={setActivePageId}
            pages={pages}
          />
        ) : activePageId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Loading…
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <h2 className="text-xl font-medium mb-2">No page selected</h2>
              <p>Create a new page to get started.</p>
            </div>
          </div>
        )}
      </main>
      <SettingsPanel open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

export default App;
