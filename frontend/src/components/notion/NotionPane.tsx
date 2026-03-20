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

export function NotionPane(props: NotionPaneProps) {
  const [loadedContent, setLoadedContent] = createSignal<{
    id: string;
    html: string;
  } | null>(null);
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  // Load content when pageId changes
  createEffect(() => {
    const pageId = props.tab.pageId;
    if (!pageId) {
      setLoadedContent(null);
      return;
    }
    setLoadedContent(null);
    if (props.useApi) {
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
    if (!props.tab.pageId) return;
    const title = extractTitle(html);
    localStorage.setItem(`voidlink-content-${props.tab.pageId}`, html);
    props.onPageTitleChange(props.tab.pageId, title);
    props.onUpdateTab({ title });

    if (props.useApi) {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        pagesApi.update(props.tab.pageId!, { title, content: html }).catch(() => {});
      }, 500);
    }
  };

  const handleSelectPage = (pageId: string) => {
    const page = props.pages.find((p) => p.id === pageId);
    props.onUpdateTab({
      pageId,
      title: page?.title ?? "Untitled",
    });
  };

  const handleNewPage = async () => {
    const id = await props.onNewPage();
    if (id) {
      props.onUpdateTab({ pageId: id, title: "Untitled" });
    }
  };

  const handleCreateChildPage = (): string => {
    return props.onCreateChildPage(props.tab.pageId);
  };

  const togglePagesPanel = () => {
    props.onUpdateTab({ pagesPanelVisible: !props.tab.pagesPanelVisible });
  };

  return (
    <div class="flex h-full overflow-hidden">
      <Show when={props.tab.pagesPanelVisible}>
        <PageTreePanel
          pages={props.pages}
          activePage={props.tab.pageId}
          onSelectPage={handleSelectPage}
          onNewPage={handleNewPage}
          onDeletePage={props.onDeletePage}
        />
      </Show>

      <div class="flex flex-col flex-1 overflow-hidden">
        {/* Toggle button in a thin header row */}
        <div class="flex items-center h-8 px-2 border-b border-border/50 flex-shrink-0">
          <button
            onClick={togglePagesPanel}
            class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title={props.tab.pagesPanelVisible ? "Hide pages panel" : "Show pages panel"}
          >
            <Show
              when={props.tab.pagesPanelVisible}
              fallback={<PanelLeftOpen class="w-4 h-4" />}
            >
              <PanelLeftClose class="w-4 h-4" />
            </Show>
          </button>
        </div>

        <Show
          when={props.tab.pageId && loadedContent()?.id === props.tab.pageId}
          fallback={
            <Show
              when={props.tab.pageId}
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
            pages={props.pages}
          />
        </Show>
      </div>
    </div>
  );
}
