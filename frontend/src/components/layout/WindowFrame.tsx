import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Overlay of 8 thin invisible strips around the window frame that each show
 * the correct resize cursor and start a native resize drag on mousedown.
 * Needed because tauri.conf has `decorations: false` — the OS draws no frame,
 * so without this layer the user has no way to resize the window.
 */

type Direction =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const EDGE_PX = 4;
const CORNER_PX = 10;

function startResize(direction: Direction) {
  return async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Tauri v2 accepts the string enum directly.
    await getCurrentWindow().startResizeDragging(direction as never);
  };
}

const edgeBase = "fixed z-[60] pointer-events-auto";

export function WindowFrame() {
  return (
    <>
      {/* Edges */}
      <div
        class={edgeBase}
        style={{
          top: 0, left: `${CORNER_PX}px`, right: `${CORNER_PX}px`,
          height: `${EDGE_PX}px`, cursor: "ns-resize",
        }}
        onMouseDown={startResize("North")}
      />
      <div
        class={edgeBase}
        style={{
          bottom: 0, left: `${CORNER_PX}px`, right: `${CORNER_PX}px`,
          height: `${EDGE_PX}px`, cursor: "ns-resize",
        }}
        onMouseDown={startResize("South")}
      />
      <div
        class={edgeBase}
        style={{
          top: `${CORNER_PX}px`, bottom: `${CORNER_PX}px`, left: 0,
          width: `${EDGE_PX}px`, cursor: "ew-resize",
        }}
        onMouseDown={startResize("West")}
      />
      <div
        class={edgeBase}
        style={{
          top: `${CORNER_PX}px`, bottom: `${CORNER_PX}px`, right: 0,
          width: `${EDGE_PX}px`, cursor: "ew-resize",
        }}
        onMouseDown={startResize("East")}
      />

      {/* Corners */}
      <div
        class={edgeBase}
        style={{
          top: 0, left: 0, width: `${CORNER_PX}px`, height: `${CORNER_PX}px`,
          cursor: "nwse-resize",
        }}
        onMouseDown={startResize("NorthWest")}
      />
      <div
        class={edgeBase}
        style={{
          top: 0, right: 0, width: `${CORNER_PX}px`, height: `${CORNER_PX}px`,
          cursor: "nesw-resize",
        }}
        onMouseDown={startResize("NorthEast")}
      />
      <div
        class={edgeBase}
        style={{
          bottom: 0, left: 0, width: `${CORNER_PX}px`, height: `${CORNER_PX}px`,
          cursor: "nesw-resize",
        }}
        onMouseDown={startResize("SouthWest")}
      />
      <div
        class={edgeBase}
        style={{
          bottom: 0, right: 0, width: `${CORNER_PX}px`, height: `${CORNER_PX}px`,
          cursor: "nwse-resize",
        }}
        onMouseDown={startResize("SouthEast")}
      />
    </>
  );
}
