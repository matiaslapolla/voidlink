import { For, Show, createSignal } from "solid-js";
import { Plus, X } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";

export function WorkspaceTabBar() {
  const { state, actions } = useAppStore();
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");

  const startRename = (id: string, name: string) => {
    setRenaming(id);
    setDraft(name);
  };
  const commitRename = () => {
    const id = renaming();
    if (id) actions.renameWorkspace(id, draft());
    setRenaming(null);
  };

  return (
    <div class="flex items-end h-9 shrink-0 border-b border-border bg-background px-1 pt-1 gap-0.5 overflow-x-auto scrollbar-thin">
      <For each={state.workspaces}>
        {(ws) => (
          <div
            class={`group flex items-center gap-2 px-3 h-full rounded-t-md text-xs cursor-pointer transition-colors border-x border-t ${
              ws.id === state.activeWorkspaceId
                ? "bg-sidebar border-border text-foreground"
                : "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/40"
            }`}
            onClick={() => actions.selectWorkspace(ws.id)}
            onDblClick={() => startRename(ws.id, ws.name)}
          >
            <Show
              when={renaming() === ws.id}
              fallback={<span class="truncate max-w-48">{ws.name}</span>}
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
                class="bg-background/60 rounded px-1 text-xs outline-none w-32"
              />
            </Show>
            <button
              onClick={(e) => {
                e.stopPropagation();
                actions.removeWorkspace(ws.id);
              }}
              class="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-all"
              title="Close workspace"
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        )}
      </For>
      <button
        onClick={() => actions.addWorkspace()}
        class="px-2 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 self-end mb-1"
        title="New workspace"
      >
        <Plus class="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
