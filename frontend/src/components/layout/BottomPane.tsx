import { createSignal } from "solid-js";
import { useLayout } from "@/store/LayoutContext";
import type { BottomTabId } from "@/store/layout";
import type { JSX } from "solid-js";

interface BottomPaneProps {
  children: Record<BottomTabId, JSX.Element>;
}

const MIN_HEIGHT = 120;
const MAX_FRAC = 0.65;

export function BottomPane(props: BottomPaneProps) {
  const [layout, actions] = useLayout();
  const [dragging, setDragging] = createSignal(false);

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = layout.bottomPaneHeight;
    const maxH = window.innerHeight * MAX_FRAC;

    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.min(Math.max(startH + delta, MIN_HEIGHT), maxH);
      actions.setBottomPaneHeight(next);
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const tabs: BottomTabId[] = ["terminal", "git", "logs", "agentOutput"];

  return (
    <div
      class="glass-panel flex flex-col flex-shrink-0 overflow-hidden will-change-[height]"
      style={{
        height: layout.bottomPaneOpen ? `${layout.bottomPaneHeight}px` : "0px",
        transition: dragging() ? "none" : "height 100ms var(--ease-snap)",
      }}
    >
      {/* Drag handle */}
      <div
        onPointerDown={layout.bottomPaneOpen ? onPointerDown : undefined}
        class={`h-1 flex-shrink-0 ${
          layout.bottomPaneOpen
            ? `cursor-row-resize transition-colors ${dragging() ? "bg-primary/40" : "bg-border hover:bg-primary/30"}`
            : ""
        }`}
      />

      {/* Tab content — always mounted via display:none for stateful tabs */}
      <div class="flex-1 overflow-hidden relative">
        {tabs.map((tabId) => (
          <div
            class="absolute inset-0 overflow-hidden"
            style={{ display: layout.activeBottomTab === tabId ? "block" : "none" }}
          >
            {props.children[tabId]}
          </div>
        ))}
      </div>
    </div>
  );
}
