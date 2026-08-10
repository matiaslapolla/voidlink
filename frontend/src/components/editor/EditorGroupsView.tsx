/// The editor area, one or two groups wide.
///
/// The seam used to be a hand-rolled `mousemove`/`mouseup` pair with its own
/// keyboard handling and its own disabled-never state. It is `<Splitter>` now,
/// like every other resizable edge in the app (`MASTER`'s "one control"
/// discipline) — which is also why the seam's keyboard step changed from a 2%
/// fraction to `Splitter`'s 8px/32px: this is a converted handle, not a new
/// one, and it inherits the shared control's behaviour rather than keeping its
/// own.
///
/// The view owns geometry only. Which file each group shows, and which group
/// takes the next command, is `editorController`'s.

import { For, Show, type JSX } from "solid-js";
import { Splitter } from "@/components/layout/Splitter";
import {
  MIN_SPLIT_FRACTION,
  DEFAULT_SPLIT_FRACTION,
  clampFraction,
  isSplit,
  type GroupId,
  type SplitLayout,
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

export function EditorGroupsView(props: EditorGroupsViewProps) {
  let containerRef!: HTMLDivElement;

  const orientation = () => props.layout().orientation;
  const horizontal = () => orientation() === "horizontal";

  /// The px extent of the split container along its own axis, measured on
  /// demand — `<Splitter>` works in pixels and the layout works in a
  /// fraction. Mirrors `MainSurface`'s `splitExtent`, which is the same
  /// fraction↔px meeting point for the workbench's own pane splitters.
  const extent = (): number => {
    if (!containerRef) return 0;
    const r = containerRef.getBoundingClientRect();
    return horizontal() ? r.width : r.height;
  };

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
            {/* Only the first group carries the seam, on its trailing edge —
                exactly `MainSurface`'s per-pane splitter placement, and the
                only sane one for a two-group cap: there is one seam, and it
                belongs to whichever pane's "end" it sits on. */}
            <Show when={index() < props.layout().groups.length - 1}>
              <Splitter
                axis={horizontal() ? "x" : "y"}
                side="end"
                label="Resize editor groups"
                value={clampFraction(props.fraction()) * extent()}
                min={MIN_SPLIT_FRACTION * extent()}
                max={(1 - MIN_SPLIT_FRACTION) * extent()}
                defaultValue={DEFAULT_SPLIT_FRACTION * extent()}
                onResize={(px) => {
                  const e = extent();
                  props.onFraction(clampFraction(e > 0 ? px / e : DEFAULT_SPLIT_FRACTION));
                }}
              />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
