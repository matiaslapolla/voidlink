import { Show, createEffect, onCleanup } from "solid-js";
import {
  TerminalSquare,
  GitBranch,
  ScrollText,
  Bot,
} from "lucide-solid";
import { useLayout } from "@/store/LayoutContext";
import type { BottomTabId } from "@/store/layout";
import type { Component } from "solid-js";

interface BottomBarProps {
  repoPath: string | null;
  statusText: string;
}

const TAB_BUTTONS: { id: BottomTabId; label: string; icon: Component<{ class?: string }>; shortcutKey?: string }[] = [
  { id: "terminal", label: "Terminal", icon: TerminalSquare, shortcutKey: "`" },
  { id: "git", label: "Git", icon: GitBranch, shortcutKey: "g" },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "agentOutput", label: "Agent", icon: Bot },
];

export function BottomBar(props: BottomBarProps) {
  const [layout, actions] = useLayout();

  // Keyboard shortcuts
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      for (const btn of TAB_BUTTONS) {
        if (btn.shortcutKey && e.key === btn.shortcutKey) {
          e.preventDefault();
          actions.toggleBottomPane(btn.id);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <div class="glass-bottom-bar h-7 shrink-0 flex items-center px-1 text-xs text-muted-foreground select-none gap-0.5">
      {/* Tab toggle buttons */}
      {TAB_BUTTONS.map((btn) => {
        const Icon = btn.icon;
        const isActive = () =>
          layout.bottomPaneOpen && layout.activeBottomTab === btn.id;

        return (
          <button
            onClick={() => actions.toggleBottomPane(btn.id)}
            class={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${
              isActive()
                ? "bg-primary/15 text-primary font-medium"
                : "hover:bg-accent/50 hover:text-foreground"
            }`}
            title={
              btn.shortcutKey
                ? `${btn.label} (Ctrl+${btn.shortcutKey})`
                : btn.label
            }
          >
            <Icon class="w-3.5 h-3.5" />
            <span>{btn.label}</span>
          </button>
        );
      })}

      {/* Spacer */}
      <div class="flex-1" />

      {/* Workspace directory */}
      <Show when={props.repoPath}>
        {(path) => (
          <span class="truncate text-muted-foreground px-2" title={path()}>
            {path()}
          </span>
        )}
      </Show>

      {/* Status text */}
      <span class="truncate text-muted-foreground/80 px-2">
        {props.statusText}
      </span>
    </div>
  );
}
