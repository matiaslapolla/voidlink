import { useState, useEffect, useCallback, useRef } from "react";
import { PanelLeftOpen, PanelLeftClose } from "lucide-react";
import { Editor } from "@/components/editor/Editor";
import { PageTreePanel } from "./PageTreePanel";
import { pagesApi } from "@/api/pages";
import type { NotionTab, Page } from "@/types/tabs";

interface NotionPaneProps {
  tab: NotionTab;
  pages: Page[];
  useApi: boolean;
  onUpdateTab: (updates: Partial<NotionTab>) => void;
  onNewPage: () => Promise<string | null>;
  onDeletePage: (id: string) => void;
  onPageTitleChange: (pageId: string, title: string) => void;
  onCreateChildPage: (parentId: string | null) => string;
}

export function NotionPane({
  tab,
  pages,
  useApi,
  onUpdateTab,
  onNewPage,
  onDeletePage,
  onPageTitleChange,
  onCreateChildPage,
}: NotionPaneProps) {
  const [loadedContent, setLoadedContent] = useState<{
    id: string;
    html: string;
  } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // Load content when pageId changes
  useEffect(() => {
    if (!tab.pageId) {
      setLoadedContent(null);
      return;
    }
    setLoadedContent(null);
    const id = tab.pageId;
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
  }, [tab.pageId, useApi]);

  const extractTitle = (html: string): string => {
    const match = html.match(/^<[^>]+>([\s\S]*?)<\/[^>]+>/);
    if (match) {
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      return text.slice(0, 60) || "Untitled";
    }
    return "Untitled";
  };

  const handleUpdate = useCallback(
    (html: string) => {
      if (!tab.pageId) return;
      const title = extractTitle(html);
      localStorage.setItem(`voidlink-content-${tab.pageId}`, html);
      onPageTitleChange(tab.pageId, title);
      onUpdateTab({ title });

      if (useApi) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          pagesApi.update(tab.pageId!, { title, content: html }).catch(() => {});
        }, 500);
      }
    },
    [tab.pageId, useApi, onPageTitleChange, onUpdateTab],
  );

  const handleSelectPage = useCallback(
    (pageId: string) => {
      const page = pages.find((p) => p.id === pageId);
      onUpdateTab({
        pageId,
        title: page?.title ?? "Untitled",
      });
    },
    [pages, onUpdateTab],
  );

  const handleNewPage = useCallback(async () => {
    const id = await onNewPage();
    if (id) {
      onUpdateTab({ pageId: id, title: "Untitled" });
    }
  }, [onNewPage, onUpdateTab]);

  const handleCreateChildPage = useCallback((): string => {
    return onCreateChildPage(tab.pageId);
  }, [onCreateChildPage, tab.pageId]);

  const togglePagesPanel = () => {
    onUpdateTab({ pagesPanelVisible: !tab.pagesPanelVisible });
  };

  return (
    <div className="flex h-full overflow-hidden">
      {tab.pagesPanelVisible && (
        <PageTreePanel
          pages={pages}
          activePage={tab.pageId}
          onSelectPage={handleSelectPage}
          onNewPage={handleNewPage}
          onDeletePage={onDeletePage}
        />
      )}

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Toggle button in a thin header row */}
        <div className="flex items-center h-8 px-2 border-b border-border/50 flex-shrink-0">
          <button
            onClick={togglePagesPanel}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title={tab.pagesPanelVisible ? "Hide pages panel" : "Show pages panel"}
          >
            {tab.pagesPanelVisible ? (
              <PanelLeftClose className="w-4 h-4" />
            ) : (
              <PanelLeftOpen className="w-4 h-4" />
            )}
          </button>
        </div>

        {tab.pageId && loadedContent?.id === tab.pageId ? (
          <Editor
            key={tab.pageId}
            content={loadedContent.html}
            onUpdate={handleUpdate}
            onCreateChildPage={handleCreateChildPage}
            onSelectPage={handleSelectPage}
            pages={pages}
          />
        ) : tab.pageId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Loading…
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <h2 className="text-xl font-medium mb-2">No page selected</h2>
              <p className="text-sm">
                Select a page from the panel or create a new one.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
