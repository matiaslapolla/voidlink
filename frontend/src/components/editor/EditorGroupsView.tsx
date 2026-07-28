/// The editor area, one or two groups wide.
///
/// Nothing here animates. Splitting is keyboard-initiated (⌘K, ⌘⌥\) and MASTER
/// §7.1 budgets those at 0ms — a pane that slides in is a pane you are waiting
/// for. The seam itself is pointer-driven and therefore tracks 1:1 (§7.3.10),
/// which is the opposite rule and the reason the two live in the same file:
/// it is easy to reach for a transition on the wrong one.
///
/// The view owns geometry only. Which file each group shows, and which group
/// takes the next command, is `editorController`'s.

import { For, Show, type JSX } from "solid-js";
import {
  clampFraction,
  DEFAULT_SPLIT_FRACTION,
  isSplit,
  type GroupId,
  type SplitLayout,
  type SplitOrientation,
} from "./editorGroups";

export interface EditorGroupsViewProps {
  layout: () => SplitLayout;
  /// Size of the first group as a fraction of the container.
  fraction: () => number;
  onFraction: (next: number) => void;
  /// Contents of one group — the inline change bar plus that group's
  /// `EditorHost`. A render prop rather than a component because the bar needs
  /// the surface's `send`, and threading that through here would make this
  /// module know about the cross-window request protocol for no reason.
  renderGroup: (groupId: GroupId) => JSX.Element;
  /// Called when a pointer lands anywhere in a group. Focus follows the click
  /// even if it misses Monaco's text area (the minimap, the gutter, the
  /// group's own padding).
  onFocusGroup: (groupId: GroupId) => void;
}

/// Keyboard resize step, in fractions. 2% is small enough to aim with and big
/// enough that holding the key gets somewhere.
const KEY_STEP = 0.02;

export function EditorGroupsView(props: EditorGroupsViewProps) {
  let containerRef!: HTMLDivElement;

  const orientation = () => props.layout().orientation;
  const horizontal = () => orientation() === "horizontal";

  /// Turn a pointer position into a fraction of the container along the split
  /// axis. Clamped by `clampFraction`, so a drag past either edge parks at the
  /// minimum instead of collapsing a pane.
  function fractionAt(clientX: number, clientY: number): number {
    const rect = containerRef.getBoundingClientRect();
    const raw = horizontal()
      ? (clientX - rect.left) / rect.width
      : (clientY - rect.top) / rect.height;
    return clampFraction(raw);
  }

  function onHandlePointerDown(e: PointerEvent) {
    // Only the primary button drags; a right-click on the seam should fall
    // through to the context menu rather than starting a resize.
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();

    const move = (ev: PointerEvent) => props.onFraction(fractionAt(ev.clientX, ev.clientY));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function onHandleKeyDown(e: KeyboardEvent) {
    const back = horizontal() ? "ArrowLeft" : "ArrowUp";
    const forward = horizontal() ? "ArrowRight" : "ArrowDown";
    if (e.key === back) {
      e.preventDefault();
      props.onFraction(clampFraction(props.fraction() - KEY_STEP));
    } else if (e.key === forward) {
      e.preventDefault();
      props.onFraction(clampFraction(props.fraction() + KEY_STEP));
    } else if (e.key === "Home" || e.key === "Enter") {
      e.preventDefault();
      props.onFraction(DEFAULT_SPLIT_FRACTION);
    }
  }

  const groupBasis = (index: number): string => {
    if (!isSplit(props.layout())) return "100%";
    const f = clampFraction(props.fraction());
    return `${(index === 0 ? f : 1 - f) * 100}%`;
  };

  return (
    <div
      ref={containerRef}
      class="absolute inset-0 flex min-h-0 min-w-0"
      classList={{ "flex-row": horizontal(), "flex-col": !horizontal() }}
    >
      <For each={props.layout().groups}>
        {(groupId, index) => (
          <>
            <Show when={index() > 0}>
              <SplitHandle
                orientation={orientation()}
                fraction={props.fraction()}
                onPointerDown={onHandlePointerDown}
                onKeyDown={onHandleKeyDown}
                onReset={() => props.onFraction(DEFAULT_SPLIT_FRACTION)}
              />
            </Show>
            <div
              class="relative flex flex-col min-h-0 min-w-0 overflow-hidden"
              style={{ "flex-basis": groupBasis(index()), "flex-grow": "0", "flex-shrink": "0" }}
              onPointerDown={() => props.onFocusGroup(groupId)}
              onFocusIn={() => props.onFocusGroup(groupId)}
            >
              {/* The focused-group marker, present only while split — a single
                  group is unambiguously the focused one and does not need a
                  ring saying so. `--primary` tint is the app's "this one is
                  active" idiom (MASTER §11.5.3); the slot is a constant 1px in
                  both states, so nothing reflows when focus moves. */}
              <Show when={isSplit(props.layout())}>
                <div
                  aria-hidden="true"
                  class="h-px shrink-0"
                  classList={{
                    "bg-primary/60": props.layout().focused === groupId,
                    "bg-transparent": props.layout().focused !== groupId,
                  }}
                />
              </Show>
              {props.renderGroup(groupId)}
            </div>
          </>
        )}
      </For>
    </div>
  );
}

/// The seam. 9px of hit area around a 1px line, per MASTER §7.6's splitter
/// note: the target is comfortable, the mark is hairline, and neither changes
/// size in any state.
function SplitHandle(props: {
  orientation: SplitOrientation;
  fraction: number;
  onPointerDown: (e: PointerEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onReset: () => void;
}) {
  const horizontal = () => props.orientation === "horizontal";
  return (
    <div
      role="separator"
      tabindex="0"
      aria-orientation={horizontal() ? "vertical" : "horizontal"}
      aria-label="Resize editor groups"
      aria-valuenow={Math.round(props.fraction * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      title="Drag to resize · arrow keys to nudge · double-click to reset"
      onPointerDown={props.onPointerDown}
      onKeyDown={props.onKeyDown}
      onDblClick={props.onReset}
      class="group/seam relative shrink-0 flex items-center justify-center bg-transparent focus-visible:outline-none"
      classList={{
        "w-[9px] cursor-col-resize": horizontal(),
        "h-[9px] cursor-row-resize": !horizontal(),
      }}
    >
      <div
        aria-hidden="true"
        class="bg-border group-hover/seam:bg-primary/50 group-focus-visible/seam:bg-primary"
        classList={{ "w-px h-full": horizontal(), "h-px w-full": !horizontal() }}
      />
    </div>
  );
}
