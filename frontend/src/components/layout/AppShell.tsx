import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { useLayout } from "@/store/LayoutContext";

interface AppShellProps {
  titleBar: JSX.Element;
  leftSidebar: JSX.Element;
  centerColumn: JSX.Element;
  rightSidebar: JSX.Element;
  bottomPane: JSX.Element;
  bottomBar: JSX.Element;
}

const COLUMN_ORDER_MAP: Record<string, number> = {
  left: 0,
  center: 1,
  right: 2,
};

export function AppShell(props: AppShellProps) {
  const [layout, actions] = useLayout();

  const orderOf = (col: string) => {
    const order = layout.columnOrder;
    const idx = order.indexOf(col as "left" | "center" | "right");
    return idx >= 0 ? idx : COLUMN_ORDER_MAP[col] ?? 1;
  };

  const handleLeftResize = (delta: number) => {
    if (layout.leftCollapsed) return;
    actions.setLeftWidth(Math.max(180, layout.leftWidth + delta));
  };

  const handleRightResize = (delta: number) => {
    if (layout.rightCollapsed) return;
    // Right resize handle: dragging right = shrink, dragging left = grow
    actions.setRightWidth(Math.max(200, layout.rightWidth - delta));
  };

  return (
    <div class="flex flex-col h-screen bg-background text-foreground overflow-hidden">
      {props.titleBar}

      <div class="flex flex-1 overflow-hidden">
        {/* Left sidebar + resize handle */}
        <div
          class="flex flex-shrink-0"
          style={{ order: orderOf("left") }}
        >
          {props.leftSidebar}
          <Show when={!layout.leftCollapsed}>
            <ResizeHandle direction="vertical" onResize={handleLeftResize} />
          </Show>
        </div>

        {/* Center column */}
        <div
          class="flex-1 flex flex-col overflow-hidden min-w-0"
          style={{ order: orderOf("center") }}
        >
          {props.centerColumn}
        </div>

        {/* Right sidebar + resize handle */}
        <div
          class="flex flex-shrink-0"
          style={{ order: orderOf("right") }}
        >
          <Show when={!layout.rightCollapsed}>
            <ResizeHandle direction="vertical" onResize={handleRightResize} />
          </Show>
          {props.rightSidebar}
        </div>
      </div>

      {/* Bottom pane (above bottom bar) */}
      {props.bottomPane}

      {/* Bottom bar (always visible, full width) */}
      {props.bottomBar}
    </div>
  );
}
