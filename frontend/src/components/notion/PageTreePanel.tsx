import { useState, Fragment } from "react";
import { Trash2 } from "lucide-react";
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

export interface Page {
  id: string;
  title: string;
  parentId?: string | null;
}

interface PageTreeProps {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onDeleteRequest: (id: string) => void;
  parentId?: string | null;
  depth?: number;
}

function PageTree({
  pages,
  activePage,
  onSelectPage,
  onDeleteRequest,
  parentId = null,
  depth = 0,
}: PageTreeProps) {
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

interface PageTreePanelProps {
  pages: Page[];
  activePage: string | null;
  onSelectPage: (id: string) => void;
  onNewPage: () => void;
  onDeletePage: (id: string) => void;
}

export function PageTreePanel({
  pages,
  activePage,
  onSelectPage,
  onNewPage,
  onDeletePage,
}: PageTreePanelProps) {
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleDeleteRequest = (id: string) => {
    setPendingDeleteId(id);
    setDialogOpen(true);
  };

  const handleConfirmDelete = () => {
    if (pendingDeleteId) onDeletePage(pendingDeleteId);
    setDialogOpen(false);
    setPendingDeleteId(null);
  };

  return (
    <>
      <div className="w-52 border-r border-border flex flex-col h-full bg-sidebar/60 text-sidebar-foreground flex-shrink-0">
        <div className="p-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide px-3 pt-3">
          Pages
        </div>
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
        <div className="p-2 border-t border-border">
          <button
            onClick={onNewPage}
            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm hover:bg-sidebar-accent/50 transition-colors"
          >
            + New Page
          </button>
        </div>
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
    </>
  );
}
