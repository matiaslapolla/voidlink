import { createSignal, createEffect, onCleanup, type JSX } from "solid-js";

interface BottomPanelProps {
  open: boolean;
  onToggle: () => void;
  children: JSX.Element;
  /** Minimum panel height in px */
  minHeight?: number;
  /** Maximum panel height as fraction of viewport (0-1) */
  maxHeightFraction?: number;
  /** Default panel height in px */
  defaultHeight?: number;
  /** Keyboard shortcut to toggle (e.g. "g") — combined with Ctrl */
  shortcutKey?: string;
}

const STORAGE_KEY = "voidlink-bottom-panel-height";

export function BottomPanel(props: BottomPanelProps) {
  const minH = () => props.minHeight ?? 180;
  const maxFrac = () => props.maxHeightFraction ?? 0.65;
  const defaultH = () => props.defaultHeight ?? 300;

  const stored = localStorage.getItem(STORAGE_KEY);
  const initialHeight = stored ? Math.max(Number(stored), minH()) : defaultH();

  const [height, setHeight] = createSignal(initialHeight);
  const [dragging, setDragging] = createSignal(false);

  // Persist height
  createEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height()));
  });

  // Keyboard shortcut
  createEffect(() => {
    const key = props.shortcutKey;
    if (!key) return;

    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === key && !e.shiftKey && !e.altKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        props.onToggle();
      }
    };

    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Drag resize
  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = height();
    const maxH = window.innerHeight * maxFrac();

    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      const next = Math.min(Math.max(startH + delta, minH()), maxH);
      setHeight(next);
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Always render children; use height:0 + overflow:hidden when closed
  // so child components (GitTabContent, xterm, etc.) survive toggle.
  return (
    <div
      class={`flex flex-col flex-shrink-0 overflow-hidden will-change-[height] ${
        props.open ? "border-t border-border" : ""
      }`}
      style={{
        height: props.open ? `${height()}px` : "0px",
        transition: dragging() ? "none" : "height 100ms var(--ease-snap)",
      }}
    >
      {/* Drag handle — only interactive when open */}
      <div
        onPointerDown={props.open ? onPointerDown : undefined}
        class={`h-1 flex-shrink-0 ${
          props.open
            ? `cursor-row-resize transition-colors ${dragging() ? "bg-primary/40" : "bg-border hover:bg-primary/30"}`
            : ""
        }`}
      />
      {/* Panel content — always mounted */}
      <div class="flex-1 overflow-hidden">
        {props.children}
      </div>
    </div>
  );
}
