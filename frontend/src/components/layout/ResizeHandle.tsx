import { createSignal } from "solid-js";

interface ResizeHandleProps {
  /** "vertical" = dragging left/right to resize columns, "horizontal" = dragging up/down */
  direction: "vertical" | "horizontal";
  onResize: (delta: number) => void;
  class?: string;
}

/**
 * A thin drag handle that fires onResize(delta) during pointer moves.
 * delta is in px: positive = rightward/downward, negative = leftward/upward.
 */
export function ResizeHandle(props: ResizeHandleProps) {
  const [dragging, setDragging] = createSignal(false);

  const isVertical = () => props.direction === "vertical";

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    let lastPos = isVertical() ? e.clientX : e.clientY;

    const onMove = (ev: PointerEvent) => {
      const current = isVertical() ? ev.clientX : ev.clientY;
      const delta = current - lastPos;
      if (delta !== 0) {
        props.onResize(delta);
        lastPos = current;
      }
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      class={`flex-shrink-0 transition-colors ${
        isVertical()
          ? `w-1 cursor-col-resize ${dragging() ? "bg-primary/40" : "bg-transparent hover:bg-primary/20"}`
          : `h-1 cursor-row-resize ${dragging() ? "bg-primary/40" : "bg-transparent hover:bg-primary/20"}`
      } ${props.class ?? ""}`}
    />
  );
}
