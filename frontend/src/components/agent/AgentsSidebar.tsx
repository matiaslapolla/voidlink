/// The Agent Dashboard, as a dockable sidebar of its own.
///
/// Formerly the bottom section of `TerminalSidebar`, gated behind
/// `experimental.agentDashboard` the same way it is here — the `<Show>` around
/// the whole panel is what keeps `AgentDashboard` (and the poll
/// `useAgentSessions` attaches the moment it mounts) out of existence entirely
/// while the flag is off, not merely hidden.
///
/// `App.tsx` decides *whether this sidebar shows at all* the same way it always
/// has for the section: absent behind the flag. What moved here is everything
/// about it being a panel — its own edge, width, splitter, collapse, grip and
/// menu — which a stacked section never had.
import { Show, createSignal } from "solid-js";
import { Bot } from "lucide-solid";
import { useAppStore } from "@/store/LayoutContext";
import { AgentDashboard } from "@/components/agent/AgentDashboard";
import { Splitter } from "@/components/layout/Splitter";
import { PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH, type DockSide } from "@/store/layout";
import { SidebarGrip, SidebarMenuButton } from "@/components/layout/SidebarDock";

export function AgentsSidebar(props: {
  /// Which edge this panel is docked to. Used for one thing: which side the
  /// resize handle sits on.
  dock?: DockSide;
}) {
  const { state, actions } = useAppStore();
  const dock = (): DockSide => props.dock ?? "left";
  /// Collapsed to the icon rail — the Agent Dashboard's own disclosure flag,
  /// the same one it always used inside the combined column.
  const railed = () => !state.sidebarSections.agents;
  const [resizing, setResizing] = createSignal(false);

  return (
    <aside
      /* Island (D1): no border — the canvas gap around it is the separator. */
      class="flex flex-col bg-sidebar overflow-hidden relative"
      classList={{
        "transition-[width] duration-[var(--dur-short)] ease-[var(--ease-in-out)]":
          !resizing(),
      }}
      style={{ width: `${railed() ? SIDEBAR_RAIL_WIDTH : state.panels.agentsSidebar}px` }}
      data-motion="sidebar-collapse"
    >
      <Show
        when={!railed()}
        fallback={
          <div class="flex flex-col items-center w-full h-full bg-sidebar py-2 gap-2">
            <button
              onClick={() => actions.toggleSidebarSection("agents")}
              aria-expanded={false}
              aria-label="Show the agent dashboard"
              title={"Show the agent dashboard\nThe sidebar returns to the width you left it at"}
              class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
            >
              <Bot class="w-4 h-4" />
            </button>
          </div>
        }
      >
        <div class="h-9 pl-1.5 pr-1 border-b border-border flex items-center gap-1 shrink-0">
          <SidebarGrip id="agents" />
          <Bot class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span class="flex-1 text-body font-semibold text-muted-foreground truncate">
            Agents
          </span>
          <SidebarMenuButton id="agents" />
        </div>
        <AgentDashboard class="flex-1 min-h-0" />
      </Show>

      {/* Rendered while collapsed too, disabled rather than absent — §7.6. */}
      <Splitter
        side={dock() === "left" ? "end" : "start"}
        label="Agents sidebar width"
        value={state.panels.agentsSidebar}
        min={PANEL_BOUNDS.agentsSidebar.min}
        max={PANEL_BOUNDS.agentsSidebar.max}
        defaultValue={PANEL_BOUNDS.agentsSidebar.default}
        disabledReason={
          railed() ? "The agent dashboard is collapsed — expand it to resize" : undefined
        }
        onDragStateChange={setResizing}
        onResize={(w) => actions.setPanelWidth("agentsSidebar", w)}
      />
    </aside>
  );
}
