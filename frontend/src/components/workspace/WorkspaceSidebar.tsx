import { For } from "solid-js";
import { FilePlus2, Settings, Trash2 } from "lucide-solid";
import type { WorkspaceState } from "@/types/workspace";

interface WorkspaceSidebarProps {
  workspaces: WorkspaceState[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSettingsOpen: () => void;
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  return (
    <aside class="w-64 border-r border-border bg-sidebar flex flex-col">
      <div class="px-3 py-3 border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
        Workspaces
      </div>

      <div class="flex-1 overflow-y-auto p-2 space-y-1">
        <For each={props.workspaces}>
          {(ws) => (
            <div
              class={`group rounded-md border px-2 py-2 text-sm transition-colors ${
                ws.id === props.activeId
                  ? "border-primary/50 bg-sidebar-accent"
                  : "border-transparent hover:bg-sidebar-accent/50"
              }`}
            >
              <button
                class="w-full text-left"
                onClick={() => props.onSelect(ws.id)}
                title={ws.name}
              >
                <div class="truncate font-medium">{ws.name}</div>
                <div class="truncate text-xs text-muted-foreground">
                  {ws.repoRoot ?? "No repository selected"}
                </div>
              </button>

              <div class="mt-2 flex items-center justify-between gap-1">
                <input
                  value={ws.name}
                  onInput={(event) => {
                    props.onRename(ws.id, event.currentTarget.value || "Workspace");
                  }}
                  class="w-full rounded bg-accent/60 px-1.5 py-1 text-xs outline-none"
                  aria-label={`Rename ${ws.name}`}
                />
                <button
                  onClick={() => props.onRemove(ws.id)}
                  class="rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                  title="Delete workspace"
                >
                  <Trash2 class="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>

      <div class="border-t border-border p-2 space-y-2">
        <button
          onClick={props.onAdd}
          class="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/60"
        >
          <FilePlus2 class="w-4 h-4" />
          New Workspace
        </button>
        <button
          onClick={props.onSettingsOpen}
          class="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-accent/60"
        >
          <Settings class="w-4 h-4" />
          Settings
        </button>
      </div>
    </aside>
  );
}
