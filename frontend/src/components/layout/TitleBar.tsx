import { Show } from "solid-js";
import { Sun, Moon, Settings as SettingsIcon, Minus, Square, X } from "lucide-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@/store/theme";

interface TitleBarProps {
  onOpenSettings: () => void;
}

export function TitleBar(props: TitleBarProps) {
  const { mode, toggleTheme } = useTheme();
  const win = getCurrentWindow();

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
          onClick={toggleTheme}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          <Show when={mode() === "dark"} fallback={<Moon class="w-3.5 h-3.5" />}>
            <Sun class="w-3.5 h-3.5" />
          </Show>
        </button>
        <button
          onClick={props.onOpenSettings}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Settings"
        >
          <SettingsIcon class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void win.minimize()}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Minimize"
        >
          <Minus class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void win.toggleMaximize()}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Maximize"
        >
          <Square class="w-3 h-3" />
        </button>
        <button
          onClick={() => void win.close()}
          class="w-9 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors"
          title="Close"
        >
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
