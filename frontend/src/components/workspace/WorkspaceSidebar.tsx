import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { FilePlus2, Settings, Trash2, PanelLeftClose, PanelLeftOpen, Layers } from "lucide-solid";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
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

const STORAGE_KEY = "voidlink-sidebar-width";
const COLLAPSED_KEY = "voidlink-sidebar-collapsed";
const MIN_WIDTH = 48;
const DEFAULT_WIDTH = 264;
/** Inline rename input that only commits on blur/Enter to avoid re-render loops. */
function RenameInput(props: { name: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = createSignal(props.name);

  function commit() {
    const value = draft().trim() || "Workspace";
    props.onCommit(value);
  }

  return (
    <input
      value={draft()}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      class="w-full rounded bg-accent/60 px-1.5 py-1 text-xs outline-none"
      aria-label={`Rename ${props.name}`}
    />
  );
}

export function WorkspaceSidebar(props: WorkspaceSidebarProps) {
  const storedWidth = localStorage.getItem(STORAGE_KEY);
  const storedCollapsed = localStorage.getItem(COLLAPSED_KEY);

  const [collapsed, setCollapsed] = createSignal(storedCollapsed === "true");
  const [width, setWidth] = createSignal(
    storedWidth ? Math.max(Number(storedWidth), MIN_WIDTH) : DEFAULT_WIDTH,
  );

  const effectiveWidth = () => (collapsed() ? MIN_WIDTH : width());

  const toggleCollapsed = () => {
    setCollapsed((v) => !v);
  };

  // Persist
  createEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width()));
    localStorage.setItem(COLLAPSED_KEY, String(collapsed()));
  });

  // Keyboard shortcut: Ctrl+B
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b" && !e.shiftKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const handleResize = (delta: number) => {
    if (collapsed()) return;
    setWidth((w) => Math.max(MIN_WIDTH, w + delta));
  };

  return (
    <>
      <aside
        class="border-r border-border bg-sidebar flex flex-col flex-shrink-0 overflow-hidden will-change-[width]"
        style={{
          width: `${effectiveWidth()}px`,
          transition: "width 100ms var(--ease-snap)",
        }}
      >
        {/* Header */}
        <div class="px-2 py-2.5 border-b border-border flex items-center gap-2">
          <Show
            when={!collapsed()}
            fallback={
              <button
                onClick={toggleCollapsed}
                class="w-full flex items-center justify-center p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                title="Expand sidebar (Ctrl+B)"
              >
                <PanelLeftOpen class="w-4 h-4" />
              </button>
            }
          >
            <span class="flex-1 text-xs uppercase tracking-wide text-muted-foreground pl-1">
              Workspaces
            </span>
            <button
              onClick={toggleCollapsed}
              class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="Collapse sidebar (Ctrl+B)"
            >
              <PanelLeftClose class="w-3.5 h-3.5" />
            </button>
          </Show>
        </div>

        {/* Workspace list */}
        <div class="flex-1 overflow-y-auto p-1.5 space-y-1">
          <For each={props.workspaces}>
            {(ws) => (
              <Show
                when={!collapsed()}
                fallback={
                  <button
                    onClick={() => props.onSelect(ws.id)}
                    class={`w-full flex items-center justify-center p-2 rounded-md transition-colors ${
                      ws.id === props.activeId
                        ? "bg-sidebar-accent text-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                    }`}
                    title={ws.name}
                  >
                    <Layers class="w-4 h-4" />
                  </button>
                }
              >
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
                    <RenameInput
                      name={ws.name}
                      onCommit={(name) => props.onRename(ws.id, name)}
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
              </Show>
            )}
          </For>
        </div>

        {/* Bottom actions */}
        <div class="border-t border-border p-1.5 space-y-1.5">
          <Show
            when={!collapsed()}
            fallback={
              <>
                <button
                  onClick={props.onAdd}
                  class="w-full flex items-center justify-center p-2 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                  title="New Workspace"
                >
                  <FilePlus2 class="w-4 h-4" />
                </button>
                <button
                  onClick={props.onSettingsOpen}
                  class="w-full flex items-center justify-center p-2 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
                  title="Settings"
                >
                  <Settings class="w-4 h-4" />
                </button>
              </>
            }
          >
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
          </Show>
        </div>
      </aside>
      <Show when={!collapsed()}>
        <ResizeHandle direction="vertical" onResize={handleResize} />
      </Show>
    </>
  );
}
