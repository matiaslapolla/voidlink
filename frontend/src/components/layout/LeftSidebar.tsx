import { Show, createSignal, createEffect, onCleanup, createMemo } from "solid-js";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  DatabaseZap,
  Layers,
  Bot,
  TerminalSquare,
  Workflow,
  Sparkles,
  ChevronDown,
  FilePlus2,
  Trash2,
} from "lucide-solid";
import { FileExplorer } from "@/components/layout/FileExplorer";
import { NavTree } from "@/components/layout/NavTree";
import { useLayout } from "@/store/LayoutContext";
import { sendToTerminal } from "@/store/terminal-bridge";
import { terminalApi } from "@/api/terminal";
import type { NavNode } from "@/components/layout/NavTree";
import type { WorkspaceState } from "@/types/workspace";

interface LeftSidebarProps {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  onSelectWorkspace: (id: string) => void;
  onAddWorkspace: () => void;
  onRemoveWorkspace: (id: string) => void;
  onRenameWorkspace: (id: string, name: string) => void;
  onSettingsOpen: () => void;
  repoRoot: string | null;
}

function WorkspaceDropdown(props: {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onRename: (id: string, name: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal("");

  const activeWs = () =>
    props.workspaces.find((ws) => ws.id === props.activeWorkspaceId);

  const startRename = (id: string, currentName: string) => {
    setRenaming(id);
    setRenameDraft(currentName);
  };

  const commitRename = () => {
    const id = renaming();
    if (id) {
      props.onRename(id, renameDraft().trim() || "Workspace");
      setRenaming(null);
    }
  };

  return (
    <div class="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        class="w-full flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-sidebar-accent/50 transition-colors"
      >
        <Layers class="w-4 h-4 shrink-0 text-muted-foreground" />
        <span class="flex-1 truncate text-left font-medium">
          {activeWs()?.name ?? "No workspace"}
        </span>
        <ChevronDown
          class={`w-3.5 h-3.5 shrink-0 text-muted-foreground ${open() ? "rotate-180" : ""}`}
          style={{ transition: "transform 80ms var(--ease-out-expo)" }}
        />
      </button>

      <Show when={open()}>
        <div class="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-popover shadow-lg py-1">
          {props.workspaces.map((ws) => (
            <div
              class={`flex items-center gap-1 px-2 py-1.5 text-sm ${
                ws.id === props.activeWorkspaceId
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
              }`}
            >
              <Show
                when={renaming() === ws.id}
                fallback={
                  <>
                    <button
                      class="flex-1 text-left truncate"
                      onClick={() => {
                        props.onSelect(ws.id);
                        setOpen(false);
                      }}
                      onDblClick={() => startRename(ws.id, ws.name)}
                    >
                      {ws.name}
                    </button>
                    <button
                      onClick={() => {
                        props.onRemove(ws.id);
                        if (props.workspaces.length <= 1) setOpen(false);
                      }}
                      class="rounded p-0.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete workspace"
                    >
                      <Trash2 class="w-3 h-3" />
                    </button>
                  </>
                }
              >
                <input
                  value={renameDraft()}
                  onInput={(e) => setRenameDraft(e.currentTarget.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  class="flex-1 rounded bg-accent/60 px-1.5 py-0.5 text-xs outline-none"
                  autofocus
                />
              </Show>
            </div>
          ))}
          <div class="border-t border-border mt-1 pt-1 px-1">
            <button
              onClick={() => {
                props.onAdd();
                setOpen(false);
              }}
              class="w-full flex items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
            >
              <FilePlus2 class="w-3.5 h-3.5" />
              New Workspace
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function LeftSidebar(props: LeftSidebarProps) {
  const [layout, actions] = useLayout();

  const collapsed = () => layout.leftCollapsed;

  // Keyboard shortcut: Ctrl+B
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "b" && !e.shiftKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        actions.toggleLeft();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  const activeWs = createMemo(
    () => props.workspaces.find((ws) => ws.id === props.activeWorkspaceId) ?? null,
  );

  const activeTab = createMemo(() => {
    const entry = layout.centerTabsByWorkspace[props.activeWorkspaceId];
    if (!entry) return null;
    const tab = entry.tabs.find((t) => t.id === entry.activeTabId);
    return tab?.type ?? null;
  });

  const navNodes = createMemo((): NavNode[] => {
    const ws = activeWs();
    const hasRepo = !!ws?.repoRoot;

    return [
      {
        id: "repository",
        label: "Repository",
        icon: DatabaseZap,
        iconColor: "text-icon-repository",
        tabTarget: "repository",
      },
      {
        id: "contextBuilder",
        label: "Context Builder",
        icon: Layers,
        iconColor: "text-icon-context",
        tabTarget: "contextBuilder",
        badge: () => {
          const count = ws?.contextItems.length ?? 0;
          return count > 0 ? count : "";
        },
      },
      {
        id: "workflow",
        label: "Workflow",
        icon: Workflow,
        iconColor: "text-icon-workflow",
        tabTarget: "workflow",
      },
      {
        id: "aiAgent",
        label: "AI Agent",
        icon: Bot,
        iconColor: "text-icon-agent",
        tabTarget: "aiAgent",
        disabled: !hasRepo,
      },
      {
        id: "promptStudio",
        label: "Prompt Studio",
        icon: Sparkles,
        iconColor: "text-icon-prompt",
        tabTarget: "promptStudio",
      },
      {
        id: "terminal",
        label: "Terminal",
        icon: TerminalSquare,
        iconColor: "text-icon-terminal",
        tabTarget: "terminal",
        disabled: !hasRepo,
      },
    ];
  });

  const handleNodeClick = (node: NavNode) => {
    if (!node.tabTarget) return;
    if (node.tabTarget === "terminal") {
      // Terminal opens a new tab with a PTY — handled by creating a new terminal tab
      if (!props.repoRoot) return;
      terminalApi.createPty(props.repoRoot).then((ptyId) => {
        actions.openTab(props.activeWorkspaceId, {
          id: ptyId,
          type: "terminal",
          label: "Terminal",
          meta: { ptyId, cwd: props.repoRoot! },
        });
      }).catch(console.error);
    } else {
      actions.openSingleton(props.activeWorkspaceId, node.tabTarget);
    }
  };

  return (
    <aside
      class="glass-panel flex flex-col flex-shrink-0 overflow-hidden will-change-[width]"
      style={{
        width: collapsed() ? "48px" : `${layout.leftWidth}px`,
        transition: "width 100ms var(--ease-snap)",
      }}
    >
      {/* Header */}
      <div class="px-2 py-2.5 border-b border-border flex items-center gap-2">
        <Show
          when={!collapsed()}
          fallback={
            <button
              onClick={() => actions.toggleLeft()}
              class="w-full flex items-center justify-center p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="Expand sidebar (Ctrl+B)"
            >
              <PanelLeftOpen class="w-4 h-4" />
            </button>
          }
        >
          <span class="flex-1 text-xs uppercase tracking-wider font-semibold text-muted-foreground pl-1">
            Explorer
          </span>
          <button
            onClick={() => actions.toggleLeft()}
            class="p-1 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
            title="Collapse sidebar (Ctrl+B)"
          >
            <PanelLeftClose class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>

      {/* Workspace selector */}
      <Show when={!collapsed()}>
        <div class="px-1.5 pt-2 pb-1 border-b border-border">
          <WorkspaceDropdown
            workspaces={props.workspaces}
            activeWorkspaceId={props.activeWorkspaceId}
            onSelect={props.onSelectWorkspace}
            onAdd={props.onAddWorkspace}
            onRemove={props.onRemoveWorkspace}
            onRename={props.onRenameWorkspace}
          />
        </div>
      </Show>

      {/* Nav tree + file explorer */}
      <div class="flex-1 flex flex-col overflow-hidden p-1.5">
        <Show
          when={!collapsed()}
          fallback={
            <div class="space-y-1">
              {navNodes().map((node) => {
                const Icon = node.icon;
                return (
                  <button
                    onClick={() => handleNodeClick(node)}
                    disabled={node.disabled}
                    class={`w-full flex items-center justify-center p-2 rounded-md transition-colors ${
                      node.disabled
                        ? "opacity-40 cursor-not-allowed"
                        : node.tabTarget === activeTab()
                          ? "bg-sidebar-accent"
                          : "hover:bg-sidebar-accent/50"
                    }`}
                    title={node.label}
                  >
                    <Icon class={`w-4 h-4 ${node.iconColor ?? "text-muted-foreground"}`} />
                  </button>
                );
              })}
            </div>
          }
        >
          <NavTree
            nodes={navNodes()}
            activeTabId={activeTab()}
            expandedNodes={layout.leftTreeExpanded}
            onNodeClick={handleNodeClick}
            onToggleNode={(id) => actions.toggleLeftTreeNode(id)}
          />
          <FileExplorer
            repoRoot={props.repoRoot}
            activeWorkspaceId={props.activeWorkspaceId}
            onAddToTerminal={(path) => {
              // Open bottom pane terminal and send the file path
              actions.toggleBottomPane("terminal");
              sendToTerminal(path);
            }}
          />
        </Show>
      </div>

      {/* Bottom actions */}
      <div class="border-t border-border p-1.5">
        <Show
          when={!collapsed()}
          fallback={
            <button
              onClick={props.onSettingsOpen}
              class="w-full flex items-center justify-center p-2 rounded-md hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors"
              title="Settings"
            >
              <Settings class="w-4 h-4" />
            </button>
          }
        >
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
  );
}
