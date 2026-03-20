import { getCurrentWindow } from "@tauri-apps/api/window";

export function TitleBar() {
  const handleMouseDown = (e: MouseEvent) => {
    if (e.button === 0) {
      getCurrentWindow().startDragging().catch(() => {});
    }
  };

  return (
    <div
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
      class="h-8 w-full flex-shrink-0 flex items-center select-none cursor-move"
    >
      {/* Leave ~80px on left clear for macOS traffic lights */}
      <span data-tauri-drag-region class="pl-20 text-xs text-muted-foreground/40 font-medium tracking-wide pointer-events-none">
        Voidlink
      </span>
    </div>
  );
}
