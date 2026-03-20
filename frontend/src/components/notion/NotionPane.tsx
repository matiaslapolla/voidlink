import { createSignal, createEffect, Show } from "solid-js";
import { PanelLeftOpen, PanelLeftClose } from "lucide-solid";
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
  const [loadedContent, setLoadedContent] = createSignal<{
    id: string;
    html: string;
  } | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // Load content when pageId changes
  createEffect(() => {
    const pageId = tab.pageId;
    if (!pageId) {
      setLoadedContent(null);
      return;
    }
    setLoadedContent(null);
    if (useApi) {
      pagesApi
        .get(pageId)
        .then((p) => setLoadedContent({ id: pageId, html: p.content }))
        .catch(() => {
          setLoadedContent({
            id: pageId,
            html: localStorage.getItem(`voidlink-content-${pageId}`) ?? "",
          });
        });
    } else {
      setLoadedContent({
        id: pageId,
        html: localStorage.getItem(`voidlink-content-${pageId}`) ?? "",
      });
    }
  });

  const extractTitle = (html: string): string => {
    const match = html.match(/^<[^>]+>([\s\S]*?)<\/[^>]+>/);
    if (match) {
      const text = match[1].replace(/<[^>]*>/g, "").trim();
      return text.slice(0, 60) || "Untitled";
    }
    return "Untitled";
  };

  const handleUpdate = (html: string) => {
    if (!tab.pageId) return;
    const title = extractTitle(html);
    localStorage.setItem(`voidlink-content-${tab.pageId}`, html);
    onPageTitleChange(tab.pageId, title);
    onUpdateTab({ title });

    if (useApi) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        pagesApi.update(tab.pageId!, { title, content: html }).catch(() => {});
      }, 500);
    }
  };

  const handleSelectPage = (pageId: string) => {
    const page = pages.find((p) => p.id === pageId);
    onUpdateTab({
      pageId,
      title: page?.title ?? "Untitled",
    });
  };

  const handleNewPage = async () => {
    const id = await onNewPage();
    if (id) {
      onUpdateTab({ pageId: id, title: "Untitled" });
    }
  };

  const handleCreateChildPage = (): string => {
    return onCreateChildPage(tab.pageId);
  };

  const togglePagesPanel = () => {
    onUpdateTab({ pagesPanelVisible: !tab.pagesPanelVisible });
  };

  return (
    <div class="flex h-full overflow-hidden">
      <Show when={tab.pagesPanelVisible}>
        <PageTreePanel
          pages={pages}
          activePage={tab.pageId}
          onSelectPage={handleSelectPage}
          onNewPage={handleNewPage}
          onDeletePage={onDeletePage}
        />
      </Show>

      <div class="flex flex-col flex-1 overflow-hidden">
        {/* Toggle button in a thin header row */}
        <div class="flex items-center h-8 px-2 border-b border-border/50 flex-shrink-0">
          <button
            onClick={togglePagesPanel}
            class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title={tab.pagesPanelVisible ? "Hide pages panel" : "Show pages panel"}
          >
            <Show
              when={tab.pagesPanelVisible}
              fallback={<PanelLeftOpen class="w-4 h-4" />}
            >
              <PanelLeftClose class="w-4 h-4" />
            </Show>
          </button>
        </div>

        <Show
          when={tab.pageId && loadedContent()?.id === tab.pageId}
          fallback={
            <Show
              when={tab.pageId}
              fallback={
                <div class="flex-1 flex items-center justify-center text-muted-foreground">
                  <div class="text-center">
                    <h2 class="text-xl font-medium mb-2">No page selected</h2>
                    <p class="text-sm">
                      Select a page from the panel or create a new one.
                    </p>
                  </div>
                </div>
              }
            >
              <div class="flex-1 flex items-center justify-center text-muted-foreground">
                Loading…
              </div>
            </Show>
          }
        >
          <Editor
            content={loadedContent()!.html}
            onUpdate={handleUpdate}
            onCreateChildPage={handleCreateChildPage}
            onSelectPage={handleSelectPage}
            pages={pages}
          />
        </Show>
      </div>
    </div>
  );
}
