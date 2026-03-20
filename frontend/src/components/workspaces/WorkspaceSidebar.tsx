import { createSignal, createEffect, onCleanup, For, Show } from "solid-js";
import { Plus, Settings, MoreHorizontal } from "lucide-solid";
import { Separator } from "@/components/ui/separator";
import type { Workspace } from "@/types/tabs";

interface WorkspaceSidebarProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: (name: string) => void;
  onOpenSettings: () => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onRemoveWorkspace?: (id: string) => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const [adding, setAdding] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [editValue, setEditValue] = createSignal("");
  const [menuOpenId, setMenuOpenId] = createSignal<string | null>(null);
  let addInputRef: HTMLInputElement | undefined;
  let editInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    if (!menuOpenId()) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-ws-menu]")) setMenuOpenId(null);
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

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

  const getInitials = (name: string) =>
    name
      .split(" ")
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");

  return (
    <div class="w-60 border-r border-border flex flex-col h-full bg-sidebar text-sidebar-foreground">
      <div class="flex-1 overflow-y-auto p-2 pt-3 flex flex-col gap-0.5">
        <For each={props.workspaces}>
          {(ws) => (
            <div
              role="button"
              tabIndex={0}
              onClick={() => props.onSelectWorkspace(ws.id)}
              onDblClick={(e) => {
                e.preventDefault();
                startEdit(ws);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") props.onSelectWorkspace(ws.id);
              }}
              class={`group relative w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm text-left transition-colors cursor-pointer ${
                ws.id === props.activeWorkspaceId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "hover:bg-sidebar-accent/50 text-sidebar-foreground"
              }`}
            >
              <span class="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-xs font-bold flex-shrink-0">
                {getInitials(ws.name) || "W"}
              </span>
              <Show
                when={editingId() === ws.id}
                fallback={<span class="truncate flex-1">{ws.name}</span>}
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
                  class="flex-1 px-1 py-0 text-sm bg-accent rounded outline-none min-w-0"
                />
              </Show>
              <Show when={editingId() !== ws.id}>
                <div class="ml-auto flex items-center gap-1 flex-shrink-0" data-ws-menu>
                  <button
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setMenuOpenId(menuOpenId() === ws.id ? null : ws.id);
                    }}
                    class="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-accent/60 transition-opacity"
                    title="Workspace options"
                  >
                    <MoreHorizontal class="w-3.5 h-3.5" />
                  </button>
                  <Show when={ws.id === props.activeWorkspaceId}>
                    <span class="w-1.5 h-1.5 rounded-full bg-green-400" />
                  </Show>
                  <Show when={menuOpenId() === ws.id}>
                    <div
                      data-ws-menu
                      class="absolute right-0 top-full z-50 mt-0.5 w-44 rounded-md border border-border bg-popover shadow-md py-1"
                    >
                      <button
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          props.onRemoveWorkspace?.(ws.id);
                          setMenuOpenId(null);
                        }}
                        class="w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-accent rounded-md"
                      >
                        Delete workspace
                      </button>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          )}
        </For>

        <Show when={adding()}>
          <div class="px-2 py-1">
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
              class="w-full px-2 py-1 text-sm bg-accent rounded outline-none"
            />
          </div>
        </Show>
      </div>

      <Separator />
      <div class="p-2 flex gap-1">
        <button
          onClick={() => setAdding(true)}
          class="flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-sm hover:bg-sidebar-accent/50 transition-colors"
        >
          <Plus class="w-4 h-4" />
          New Workspace
        </button>
        <button
          onClick={props.onOpenSettings}
          class="p-1.5 rounded-md hover:bg-sidebar-accent/50 transition-colors"
          title="Settings"
        >
          <Settings class="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
