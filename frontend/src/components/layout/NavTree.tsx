import { For, Show } from "solid-js";
import { ChevronRight } from "lucide-solid";
import type { Component } from "solid-js";
import type { CenterTabId } from "@/store/layout";

export interface NavNodeAction {
  id: string;
  label: string;
  icon: Component<{ class?: string }>;
  onClick: () => void;
  disabled?: boolean;
}

export interface NavNode {
  id: string;
  label: string;
  icon: Component<{ class?: string; style?: any }>;
  tabTarget?: CenterTabId;
  children?: NavNode[];
  actions?: NavNodeAction[];
  badge?: () => string | number;
  disabled?: boolean;
  /** Tailwind class for the icon's distinct color (e.g. "text-icon-scan") */
  iconColor?: string;
}

interface NavTreeProps {
  nodes: NavNode[];
  activeTabId: CenterTabId | null;
  expandedNodes: Record<string, boolean>;
  onNodeClick: (node: NavNode) => void;
  onToggleNode: (nodeId: string) => void;
}

function NavTreeNode(props: {
  node: NavNode;
  depth: number;
  activeTabId: CenterTabId | null;
  expandedNodes: Record<string, boolean>;
  onNodeClick: (node: NavNode) => void;
  onToggleNode: (nodeId: string) => void;
}) {
  const hasChildren = () =>
    (props.node.children?.length ?? 0) > 0 || (props.node.actions?.length ?? 0) > 0;
  const isExpanded = () => props.expandedNodes[props.node.id] ?? false;
  const isActive = () =>
    props.node.tabTarget != null && props.node.tabTarget === props.activeTabId;

  const handleClick = () => {
    if (props.node.disabled) return;
    if (hasChildren()) {
      props.onToggleNode(props.node.id);
    }
    if (props.node.tabTarget) {
      props.onNodeClick(props.node);
    }
  };

  const Icon = props.node.icon;

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={props.node.disabled}
        class={`w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
          props.node.disabled
            ? "text-muted-foreground/50 cursor-not-allowed"
            : isActive()
              ? "bg-sidebar-accent text-foreground font-medium"
              : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
        }`}
        style={{ "padding-left": `${props.depth * 12 + 8}px` }}
      >
        <Show when={hasChildren()}>
          <ChevronRight
            class={`w-3 h-3 shrink-0 ${isExpanded() ? "rotate-90" : ""}`}
            style={{ transition: "transform 80ms var(--ease-out-expo)" }}
          />
        </Show>
        <Show when={!hasChildren()}>
          <span class="w-3 shrink-0" />
        </Show>
        <Icon class={`w-4 h-4 shrink-0 ${props.node.iconColor ?? ""}`} />
        <span class="truncate flex-1 text-left">{props.node.label}</span>
        <Show when={props.node.badge}>
          {(badge) => (
            <span class="text-xs bg-primary/15 rounded px-1.5 py-0.5 text-primary font-medium">
              {badge()()}
            </span>
          )}
        </Show>
      </button>

      <Show when={hasChildren() && isExpanded()}>
        <For each={props.node.children}>
          {(child) => (
            <NavTreeNode
              node={child}
              depth={props.depth + 1}
              activeTabId={props.activeTabId}
              expandedNodes={props.expandedNodes}
              onNodeClick={props.onNodeClick}
              onToggleNode={props.onToggleNode}
            />
          )}
        </For>
        <Show when={props.node.actions}>
          {(actions) => (
            <div
              class="space-y-0.5 py-1"
              style={{ "padding-left": `${(props.depth + 1) * 12 + 8 + 12}px` }}
            >
              <For each={actions()}>
                {(action) => {
                  const ActionIcon = action.icon;
                  return (
                    <button
                      onClick={action.onClick}
                      disabled={action.disabled}
                      class="w-full flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ActionIcon class="w-3.5 h-3.5 shrink-0" />
                      <span class="truncate">{action.label}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </Show>
      </Show>
    </div>
  );
}

export function NavTree(props: NavTreeProps) {
  return (
    <div class="space-y-0.5 shrink-0">
      <For each={props.nodes}>
        {(node) => (
          <NavTreeNode
            node={node}
            depth={0}
            activeTabId={props.activeTabId}
            expandedNodes={props.expandedNodes}
            onNodeClick={props.onNodeClick}
            onToggleNode={props.onToggleNode}
          />
        )}
      </For>
    </div>
  );
}
