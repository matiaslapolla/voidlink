import { useState, Fragment } from "react";
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
import { Trash2, Settings } from "lucide-react";

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

function PageTree({
  pages,
  activePage,
  onSelectPage,
  onDeleteRequest,
  parentId = null,
  depth = 0,
}: {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  parentId?: string | null;
  depth?: number;
}) {
  const children = pages.filter((p) => (p.parentId ?? null) === parentId);
  if (children.length === 0) return null;

  return (
    <>
      {children.map((page) => (
        <Fragment key={page.id}>
          <div
            className={`group relative flex items-center rounded-md ${
              activePage === page.id
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/50"
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            <button
              onClick={() => onSelectPage(page.id)}
              className="flex-1 text-left py-1.5 text-sm truncate pr-7"
            >
              {depth > 0 && (
                <span className="text-muted-foreground mr-1">↳</span>
              )}
              {page.title || "Untitled"}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRequest(page.id);
              }}
              className="absolute right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/20 hover:text-destructive"
              title="Delete page"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
          <PageTree
            pages={pages}
            activePage={activePage}
            onSelectPage={onSelectPage}
            onDeleteRequest={onDeleteRequest}
            parentId={page.id}
            depth={depth + 1}
          />
        </Fragment>
      ))}
    </>
  );
}

export function PageSidebar({
  pages,
  activePage,
  onSelectPage,
  onNewPage,
  onDeletePage,
  onOpenSettings,
}: PageSidebarProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleDeleteRequest = (id: string) => {
    setPendingDeleteId(id);
    setDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    if (pendingDeleteId) {
      onDeletePage(pendingDeleteId);
    }
    setDialogOpen(false);
    setPendingDeleteId(null);
  };

  return (
    <div className="w-60 border-r border-border flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div className="p-4 flex items-center justify-between">
        <span className="font-semibold text-lg">Voidlink</span>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        <div className="p-2 flex flex-col gap-0.5">
          <PageTree
            pages={pages}
            activePage={activePage}
            onSelectPage={onSelectPage}
            onDeleteRequest={handleDeleteRequest}
          />
        </div>
      </ScrollArea>
      <Separator />
      <div className="p-2 flex gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 justify-start"
          onClick={onNewPage}
        >
          + New Page
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={onOpenSettings}
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </Button>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogPortal>
          <DialogBackdrop />
          <DialogPopup>
            <DialogTitle>Delete this page?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. The page and its content will be
              permanently deleted.
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <DialogClose
                render={<button />}
                className="px-3 py-1.5 text-sm rounded-md hover:bg-accent"
              >
                Cancel
              </DialogClose>
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-sm rounded-md bg-destructive text-white hover:bg-destructive/90"
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
