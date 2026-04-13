import { For, createSignal } from "solid-js";
import {
  X,
  DatabaseZap,
  Layers,
  Workflow,
  Bot,
  TerminalSquare,
  FileCode,
  Image,
  Code,
  GitCompare,
} from "lucide-solid";
import { useLayout } from "@/store/LayoutContext";
import type { CenterTabType, TabInstance } from "@/store/layout";
import type { Component } from "solid-js";

interface CenterTabBarProps {
  workspaceId: string;
}

const TYPE_ICONS: Record<CenterTabType, Component<{ class?: string }>> = {
  repository: DatabaseZap,
  contextBuilder: Layers,
  workflow: Workflow,
  aiAgent: Bot,
  terminal: TerminalSquare,
  file: FileCode,
  image: Image,
  svg: Code,
  diff: GitCompare,
};

export function CenterTabBar(props: CenterTabBarProps) {
  const [layout, actions] = useLayout();
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);

  const tabState = () =>
    layout.centerTabsByWorkspace[props.workspaceId] ?? {
      tabs: [] as TabInstance[],
      activeTabId: "",
    };

  const handleDragStart = (idx: number, e: DragEvent) => {
    setDragIdx(idx);
    e.dataTransfer!.effectAllowed = "move";
  };

  const handleDragOver = (idx: number, e: DragEvent) => {
    e.preventDefault();
    const from = dragIdx();
    if (from === null || from === idx) return;

    const tabs = [...tabState().tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(idx, 0, moved);
    actions.reorderTabs(props.workspaceId, tabs.map((t) => t.id));
    setDragIdx(idx);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
  };

  return (
    <div class="border-b border-border bg-background/60 flex items-center overflow-x-auto scrollbar-tab-strip">
      <For each={tabState().tabs}>
        {(tab, idx) => {
          const Icon = TYPE_ICONS[tab.type] ?? FileCode;
          const isActive = () => tabState().activeTabId === tab.id;

          return (
            <div
              draggable={true}
              onDragStart={(e) => handleDragStart(idx(), e)}
              onDragOver={(e) => handleDragOver(idx(), e)}
              onDragEnd={handleDragEnd}
              class={`group flex items-center gap-1.5 px-3 py-1.5 text-sm cursor-pointer border-b-2 transition-colors select-none ${
                isActive()
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30"
              }`}
              onClick={() => actions.setActiveTab(props.workspaceId, tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  actions.closeTab(props.workspaceId, tab.id);
                }
              }}
              onDblClick={() => {
                if (tab.preview) actions.pinTab(props.workspaceId, tab.id);
              }}
            >
              <Icon class="w-3.5 h-3.5 shrink-0" />
              <span class={`truncate max-w-[120px] ${tab.preview ? "italic opacity-70" : ""}`}>
                {tab.label}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closeTab(props.workspaceId, tab.id);
                }}
                class="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-accent/60 transition-opacity"
                title="Close tab"
              >
                <X class="w-3 h-3" />
              </button>
            </div>
          );
        }}
      </For>
    </div>
  );
}
