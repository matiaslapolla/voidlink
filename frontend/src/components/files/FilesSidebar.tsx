/// The file explorer as a docked sidebar in its own right.
///
/// It exists because of what the dock model made possible. Under vertical tabs
/// the explorer used to be stacked *inside* the git panel's column — one column
/// holding two panels, sharing one width, because a global swap flag had no way
/// to say "this panel goes on that edge". With a per-sidebar dock side it can
/// simply be a sidebar: its own edge, its own width, its own splitter, its own
/// collapse. That is the whole content of this file.
///
/// Under horizontal tabs the explorer stays where it has always been — the
/// first section of `TerminalSidebar` — so this is *not* a second home for the
/// tree. `FilesPanel` is rendered by both, which is what keeps the tree, its
/// empty state and its persisted disclosure one implementation.
import { Show, createSignal } from "solid-js";
import { FilesPanel, FilesRail } from "@/components/files/FilesPanel";
import { Splitter } from "@/components/layout/Splitter";
import { SidebarGrip, SidebarMenuButton } from "@/components/layout/SidebarDock";
import { useAppStore } from "@/store/LayoutContext";
import { PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH, type DockSide } from "@/store/layout";

export function FilesSidebar(props: {
  onOpenFile?: (path: string) => void;
  /// Which edge this panel is docked to. Used for one thing: which side the
  /// resize handle sits on.
  dock?: DockSide;
}) {
  const { state, actions } = useAppStore();
  const dock = (): DockSide => props.dock ?? "left";
  /// Collapsed to the icon rail — `sidebarSections.files`, the same flag the
  /// explorer's disclosure has always used, because this is the same collapse
  /// asked from a different placement (see `FilesPanel`'s header).
  const railed = () => !state.sidebarSections.files;
  /// Suppress the width transition while the splitter is held: a pane the user
  /// is dragging must track the pointer 1:1 (§7.3.10), while the collapse
  /// animates because it carries information (§7.1).
  const [resizing, setResizing] = createSignal(false);

  return (
    <aside
      /* Island (D1): no border — the canvas gap around it is the separator. */
      class="flex flex-col bg-sidebar overflow-hidden relative"
      classList={{
        "transition-[width] duration-[var(--dur-short)] ease-[var(--ease-in-out)]":
          !resizing(),
      }}
      style={{ width: `${railed() ? SIDEBAR_RAIL_WIDTH : state.panels.sidebar}px` }}
      data-motion="sidebar-collapse"
    >
      <Show
        when={!railed()}
        fallback={<FilesRail onExpand={() => actions.toggleSidebarSection("files")} />}
      >
        <div class="h-9 pl-1.5 pr-1 border-b border-border flex items-center gap-1 shrink-0">
          <SidebarGrip id="files" />
          <span class="flex-1 text-body font-semibold text-muted-foreground truncate">
            Explorer
          </span>
          <SidebarMenuButton id="files" />
        </div>
        <FilesPanel onOpenFile={props.onOpenFile} />
      </Show>

      {/* Kept while collapsed, disabled and saying why — §7.6, and the same
          arrangement the other two sidebars have. */}
      <Splitter
        side={dock() === "left" ? "end" : "start"}
        label="File explorer width"
        value={state.panels.sidebar}
        min={PANEL_BOUNDS.sidebar.min}
        max={PANEL_BOUNDS.sidebar.max}
        defaultValue={PANEL_BOUNDS.sidebar.default}
        disabledReason={
          railed() ? "The file explorer is collapsed — expand it to resize" : undefined
        }
        onDragStateChange={setResizing}
        onResize={(w) => actions.setPanelWidth("sidebar", w)}
      />
    </aside>
  );
}
