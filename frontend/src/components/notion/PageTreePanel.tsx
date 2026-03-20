import { createSignal, For, Show } from "solid-js";
import { Trash2 } from "lucide-solid";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import type { Page } from "@/types/tabs";

interface PageTreeProps {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  parentId?: string | null;
  depth?: number;
}

function PageTree(props: PageTreeProps) {
  const children = () => props.pages.filter((p) => (p.parentId ?? null) === (props.parentId ?? null));

  return (
    <Show when={children().length > 0}>
      <For each={children()}>
        {(page) => (
          <>
            <div
              class={`group relative flex items-center rounded-md ${
                props.activePage === page.id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/50"
              }`}
              style={{ "padding-left": `${(props.depth ?? 0) * 12 + 8}px` }}
            >
              <button
                onClick={() => props.onSelectPage(page.id)}
                class="flex-1 text-left py-1.5 text-sm truncate pr-7"
              >
                <Show when={(props.depth ?? 0) > 0}>
                  <span class="text-muted-foreground mr-1">↳</span>
                </Show>
                {page.title || "Untitled"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteRequest(page.id);
                }}
                class="absolute right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/20 hover:text-destructive"
                title="Delete page"
              >
                <Trash2 class="w-3 h-3" />
              </button>
            </div>
            <PageTree
              pages={props.pages}
              activePage={props.activePage}
              onSelectPage={props.onSelectPage}
              onDeleteRequest={props.onDeleteRequest}
              parentId={page.id}
              depth={(props.depth ?? 0) + 1}
            />
          </>
        )}
      </For>
    </Show>
  );
}

interface PageTreePanelProps {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
  onDeletePage: (id: string) => void;
}

export function PageTreePanel(props: PageTreePanelProps) {
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);

  const handleDeleteRequest = (id: string) => {
    setPendingDeleteId(id);
    setDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    if (pendingDeleteId()) props.onDeletePage(pendingDeleteId()!);
    setDialogOpen(false);
    setPendingDeleteId(null);
  };

  return (
    <>
      <div class="w-52 border-r border-border flex flex-col h-full bg-sidebar/60 text-sidebar-foreground flex-shrink-0">
        <div class="p-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 pt-3">
          Pages
        </div>
        <ScrollArea class="flex-1">
          <div class="p-2 flex flex-col gap-0.5">
            <PageTree
              pages={props.pages}
              activePage={props.activePage}
              onSelectPage={props.onSelectPage}
              onDeleteRequest={handleDeleteRequest}
            />
          </div>
        </ScrollArea>
        <div class="p-2 border-t border-border">
          <button
            onClick={props.onNewPage}
            class="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm hover:bg-sidebar-accent/50 transition-colors"
          >
            + New Page
          </button>
        </div>
      </div>

      <Dialog open={dialogOpen()} onOpenChange={setDialogOpen}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup>
            <DialogTitle>Delete this page?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. The page and its content will be
              permanently deleted.
            </DialogDescription>
            <div class="flex justify-end gap-2">
              <DialogClose class="px-3 py-1.5 text-sm rounded-md hover:bg-accent">
                Cancel
              </DialogClose>
              <button
                onClick={handleConfirmDelete}
                class="px-3 py-1.5 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90"
              >
                Delete
              </button>
            </div>
          </DialogPopup>
        </DialogPortal>
      </Dialog>
    </>
  );
}
