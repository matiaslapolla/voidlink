import { createSignal, createEffect, For, Show } from "solid-js";
import { X, Plus } from "lucide-solid";
import type { Workspace } from "@/types/tabs";

interface WorkspaceTopBarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: (name: string) => void;
  onRemoveWorkspace: (id: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
}

export function WorkspaceTopBar(props: WorkspaceTopBarProps) {
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  let addInputRef: HTMLInputElement | undefined;
  let editInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (adding()) addInputRef?.focus();
  });

  createEffect(() => {
    if (editingId()) {
      editInputRef?.focus();
      editInputRef?.select();
    }
  });

  const confirmAdd = () => {
    const name = newName().trim() || "Workspace";
    props.onAddWorkspace(name);
    setNewName("");
    setAdding(false);
  };

  const startEdit = (ws: Workspace) => {
    setEditingId(ws.id);
    setEditValue(ws.name);
  };

  const confirmEdit = () => {
    if (!editingId()) return;
    const name =
      editValue().trim() ||
      props.workspaces.find((w) => w.id === editingId())?.name ||
      "Workspace";
    props.onRenameWorkspace(editingId()!, name);
    setEditingId(null);
    setEditValue("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  return (
    <div class="flex items-center gap-1 px-2 h-9 border-b border-border bg-background/60 overflow-x-auto scrollbar-none flex-shrink-0">
      <For each={props.workspaces}>
        {(ws) => (
          <div
            class={`group flex items-center gap-1 px-2 py-1 rounded text-xs font-medium cursor-pointer transition-colors whitespace-nowrap ${
              ws.id === props.activeWorkspaceId
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            onClick={() => props.onSelectWorkspace(ws.id)}
            onDblClick={(e) => {
              e.preventDefault();
              startEdit(ws);
            }}
          >
            <Show when={ws.id === props.activeWorkspaceId && editingId() !== ws.id}>
              <span class="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
            </Show>
            <Show
              when={editingId() === ws.id}
              fallback={<span>{ws.name}</span>}
            >
              <input
                ref={editInputRef}
                value={editValue()}
                onInput={(e) => setEditValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation();
                    confirmEdit();
                  }
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    cancelEdit();
                  }
                }}
                onBlur={confirmEdit}
                onClick={(e) => e.stopPropagation()}
                class="px-1 py-0 text-xs bg-background rounded outline-none w-24"
              />
            </Show>
            <Show when={props.workspaces.length > 1 && editingId() !== ws.id}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemoveWorkspace(ws.id);
                }}
                class="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-destructive/20 hover:text-destructive"
                title="Close workspace"
              >
                <X class="w-3 h-3" />
              </button>
            </Show>
          </div>
        )}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            onClick={() => setAdding(true)}
            class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
            title="New workspace"
          >
            <Plus class="w-3.5 h-3.5" />
          </button>
        }
      >
        <input
          ref={addInputRef}
          value={newName()}
          onInput={(e) => setNewName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmAdd();
            if (e.key === "Escape") {
              setAdding(false);
              setNewName("");
            }
          }}
          onBlur={confirmAdd}
          placeholder="Workspace name…"
          class="px-2 py-0.5 text-xs bg-accent rounded outline-none w-32"
        />
      </Show>
    </div>
  );
}
