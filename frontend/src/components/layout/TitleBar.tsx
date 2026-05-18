import { Show } from "solid-js";
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Minus,
  Square,
  X,
  PanelLeft,
  PanelRight,
  ArrowLeftRight,
} from "lucide-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@/store/theme";
import { useAppStore } from "@/store/LayoutContext";

interface TitleBarProps {
  onOpenSettings: () => void;
}

export function TitleBar(props: TitleBarProps) {
  const { mode, toggleTheme } = useTheme();
  const { state, actions } = useAppStore();
  const win = getCurrentWindow();

  // Visual semantics follow what the user sees, not where state lives:
  // when sidebars are swapped, the git panel becomes the "left" toggle and
  // the files/terminal panel becomes the "right" toggle.
  const leftCollapsed = () =>
    state.sidebarsSwapped ? state.gitSidebarCollapsed : state.leftSidebarCollapsed;
  const rightCollapsed = () =>
    state.sidebarsSwapped ? state.leftSidebarCollapsed : state.gitSidebarCollapsed;
  const toggleLeft = () =>
    state.sidebarsSwapped ? actions.toggleGitSidebar() : actions.toggleLeftSidebar();
  const toggleRight = () =>
    state.sidebarsSwapped ? actions.toggleLeftSidebar() : actions.toggleGitSidebar();

  return (
    <div class="flex items-stretch h-8 shrink-0 select-none border-b border-border bg-background">
      <div
        data-tauri-drag-region
        class="flex-1 flex items-center px-3 text-xs text-muted-foreground"
        onDblClick={() => void win.toggleMaximize()}
      >
        <span class="font-semibold tracking-wide text-foreground/80 pointer-events-none">
          Voidlink
        </span>
      </div>
      <div class="flex items-stretch text-muted-foreground">
        <button
          onClick={toggleLeft}
          aria-label={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
          aria-pressed={!leftCollapsed()}
          class={`w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors ${leftCollapsed() ? "" : "text-foreground"}`}
          title={leftCollapsed() ? "Show left sidebar" : "Hide left sidebar"}
        >
          <PanelLeft class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={toggleRight}
          aria-label={rightCollapsed() ? "Show right sidebar" : "Hide right sidebar"}
          aria-pressed={!rightCollapsed()}
          class={`w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors ${rightCollapsed() ? "" : "text-foreground"}`}
          title={rightCollapsed() ? "Show right sidebar" : "Hide right sidebar"}
        >
          <PanelRight class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => actions.toggleSidebarsSwapped()}
          aria-label="Swap left and right sidebars"
          aria-pressed={state.sidebarsSwapped}
          class={`w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors ${state.sidebarsSwapped ? "text-foreground" : ""}`}
          title="Swap left and right sidebars"
        >
          <ArrowLeftRight class="w-3.5 h-3.5" />
        </button>
        <div class="w-px self-center h-4 bg-border mx-1" />
        <button
          onClick={toggleTheme}
          aria-label={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          <Show when={mode() === "dark"} fallback={<Moon class="w-3.5 h-3.5" />}>
            <Sun class="w-3.5 h-3.5" />
          </Show>
        </button>
        <button
          onClick={props.onOpenSettings}
          aria-label="Settings"
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Settings"
        >
          <SettingsIcon class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void win.minimize()}
          aria-label="Minimize"
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Minimize"
        >
          <Minus class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void win.toggleMaximize()}
          aria-label="Maximize"
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Maximize"
        >
          <Square class="w-3 h-3" />
        </button>
        <button
          onClick={() => void win.close()}
          aria-label="Close"
          class="w-9 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors"
          title="Close"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
