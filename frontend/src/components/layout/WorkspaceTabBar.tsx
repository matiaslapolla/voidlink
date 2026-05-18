import { For, Show, createSignal } from "solid-js";
import { Plus, X } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";

export function WorkspaceTabBar() {
  const { state, actions } = useAppStore();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  /// Drag state lives in component-local signals — we don't need to round-
  /// trip through the store. `dragId` is the workspace being dragged;
  /// `dropTarget` is the workspace it would land *before* (or "end" for the
  /// trailing slot). Both are reset on dragend/drop.
  const [dragId, setDragId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | "end" | null>(null);

  const startRename = (id: string, name: string) => {
    setRenaming(id);
    setDraft(name);
  };
  const commitRename = () => {
    const id = renaming();
    if (id) actions.renameWorkspace(id, draft());
    setRenaming(null);
  };

  function onDragStart(e: DragEvent, id: string) {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = "move";
    // Some browsers ignore a drag with no payload — set a benign string.
    e.dataTransfer.setData("text/voidlink-workspace", id);
    setDragId(id);
  }

  function onDragOverTab(e: DragEvent, id: string) {
    if (!dragId() || dragId() === id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropTarget(id);
  }

  function onDropOnTab(e: DragEvent, id: string) {
    const from = dragId();
    if (!from || from === id) {
      resetDrag();
      return;
    }
    e.preventDefault();
    actions.reorderWorkspace(from, id);
    resetDrag();
  }

  function onDragOverEnd(e: DragEvent) {
    if (!dragId()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropTarget("end");
  }

  function onDropAtEnd(e: DragEvent) {
    const from = dragId();
    if (!from) return;
    e.preventDefault();
    actions.reorderWorkspace(from, null);
    resetDrag();
  }

  function resetDrag() {
    setDragId(null);
    setDropTarget(null);
  }

  return (
    <div
      role="tablist"
      aria-label="Workspaces"
      class="flex items-end h-9 shrink-0 border-b border-border bg-background px-1 pt-1 gap-0.5 overflow-x-auto scrollbar-thin"
      onDragOver={onDragOverEnd}
      onDrop={onDropAtEnd}
    >
      <For each={state.workspaces}>
        {(ws) => (
          <div
            draggable={renaming() !== ws.id}
            onDragStart={(e) => onDragStart(e, ws.id)}
            onDragEnd={resetDrag}
            onDragOver={(e) => onDragOverTab(e, ws.id)}
            onDrop={(e) => onDropOnTab(e, ws.id)}
            class={`group flex items-center h-full rounded-t-md text-xs transition-colors border-x border-t ${
              ws.id === state.activeWorkspaceId
                ? "bg-sidebar border-border text-foreground"
                : "bg-transparent border-transparent text-muted-foreground"
            } ${dragId() === ws.id ? "opacity-50" : ""} ${
              dropTarget() === ws.id ? "border-l-primary" : ""
            }`}
          >
            <Show
              when={renaming() === ws.id}
              fallback={
                <button
                  role="tab"
                  aria-selected={ws.id === state.activeWorkspaceId}
                  aria-label={ws.name}
                  title={`${ws.name} — double-click to rename, drag to reorder`}
                  onClick={() => actions.selectWorkspace(ws.id)}
                  onDblClick={() => startRename(ws.id, ws.name)}
                  class={`flex items-center pl-3 pr-1 gap-2 h-full rounded-t-md cursor-pointer ${
                    ws.id !== state.activeWorkspaceId
                      ? "hover:text-foreground hover:bg-accent/40"
                      : ""
                  }`}
                >
                  <span class="truncate max-w-48">{ws.name}</span>
                </button>
              }
            >
              <input
                value={draft()}
                autofocus
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label="Rename workspace"
                class="ml-3 bg-background/60 rounded px-1 text-xs outline-none w-32"
              />
            </Show>
            <button
              onClick={(e) => {
                e.stopPropagation();
                actions.removeWorkspace(ws.id);
              }}
              aria-label={`Close ${ws.name} workspace`}
              title="Close workspace"
              class="p-0.5 mr-1.5 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        )}
      </For>
      <button
        onClick={() => actions.addWorkspace()}
        aria-label="New workspace"
        class={`px-2 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 self-end mb-1 ${
          dropTarget() === "end" ? "border-l border-l-primary" : ""
        }`}
        title="New workspace"
      >
        <Plus class="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
