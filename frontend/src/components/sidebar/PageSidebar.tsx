import { createSignal, For, Show } from "solid-js";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogPortal,
  DialogBackdrop,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@/components/ui/dialog";
import { Trash2, Settings } from "lucide-solid";

export interface Page {
  id: string;
  title: string;
  parentId?: string | null;
}

interface PageSidebarProps {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
  onDeletePage: (id: string) => void;
  onOpenSettings: () => void;
}

function PageTree(props: {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  parentId?: string | null;
  depth?: number;
}) {
  const depth = () => props.depth ?? 0;
  const children = () =>
    props.pages.filter((p) => (p.parentId ?? null) === (props.parentId ?? null));

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
              style={{ "padding-left": `${depth() * 12 + 8}px` }}
            >
              <button
                onClick={() => props.onSelectPage(page.id)}
                class="flex-1 text-left py-1.5 text-sm truncate pr-7"
              >
                <Show when={depth() > 0}>
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
              depth={depth() + 1}
            />
          </>
        )}
      </For>
    </Show>
  );
}

export function PageSidebar(props: PageSidebarProps) {
  const [pendingDeleteId, setPendingDeleteId] = createSignal<string | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);

  const handleDeleteRequest = (id: string) => {
    setPendingDeleteId(id);
    setDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    const id = pendingDeleteId();
    if (id) {
      props.onDeletePage(id);
    }
    setDialogOpen(false);
    setPendingDeleteId(null);
  };

  return (
    <div class="w-60 border-r border-border flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div class="p-4 flex items-center justify-between">
        <span class="font-semibold text-lg">Voidlink</span>
      </div>
      <Separator />
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
      <Separator />
      <div class="p-2 flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          class="flex-1 justify-start"
          onClick={props.onNewPage}
        >
          + New Page
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class="px-2"
          onClick={props.onOpenSettings}
          title="Settings"
        >
          <Settings class="w-4 h-4" />
        </Button>
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
    </div>
  );
}
