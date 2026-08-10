/// The terminals list, as a dockable sidebar of its own.
///
/// Formerly the middle section of `TerminalSidebar` — a single column that also
/// carried the file explorer above it and the Agent Dashboard below it, because
/// the pre-dock model had no way to give three unrelated panels three edges.
/// With a per-sidebar dock side each is an ordinary sidebar: its own edge, its
/// own width, its own splitter, its own collapse. `FilesSidebar` and
/// `AgentsSidebar` are its siblings; this file keeps only what was always the
/// terminals section — the LED slots, `watchTerminal`, `forgetTerminalHistory`,
/// `forgetPtySize` and `tabMark` move here intact.
///
/// It renders no file tree and no agent dashboard. It also drops the repo
/// picker and the "Compare branches" quick action that used to live in the
/// combined column's header and footer: the workspace rail already offers
/// "open a folder", and Compare branches is a palette action and a row in the
/// git sidebar's own footer (which stays exactly where it is — see Stream G).
/// A sidebar whose only job is the terminals list does not need a second copy
/// of either.
import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Plus, X, TerminalSquare } from "lucide-solid";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "@/store/LayoutContext";
import { terminalApi } from "@/api/terminal";
import type { TerminalSession } from "@/types/workspace";
import { forget as forgetTerminalHistory } from "@/commands/terminalHistory";
import { forgetPtySize } from "@/commands/terminalSize";
import { LedSlot, ledLabel, terminalSignal } from "@/components/layout/StatusLed";
import { Splitter } from "@/components/layout/Splitter";
import { PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH, type DockSide } from "@/store/layout";
import {
  SidebarCollapseButton,
  SidebarGrip,
  SidebarMenuButton,
} from "@/components/layout/SidebarDock";
import { tabMark } from "@/store/activity";
import { watchTerminal } from "@/store/terminalWatch";

export function TerminalsSidebar(props: {
  /// Which edge this panel is docked to. Used for one thing: which side the
  /// resize handle sits on.
  dock?: DockSide;
}) {
  const { state, activeRepoPath, activeTerminals, activeItem, actions } = useAppStore();

  const activeTerminalId = () => {
    const a = activeItem();
    return a?.type === "terminal" ? a.id : null;
  };

  /// Collapsed to the icon rail — the terminals section's own flag, the same
  /// one it always used inside the combined column.
  const railed = () => !state.sidebarSections.terminals;

  /// Suppress the width transition for the duration of a splitter drag — see
  /// `FilesSidebar` for why the collapse itself keeps the transition.
  const [resizing, setResizing] = createSignal(false);

  const dock = (): DockSide => props.dock ?? "left";

  return (
    <aside
      /* Island (D1): no border — the canvas gap around it is the separator. */
      class="flex flex-col bg-sidebar overflow-hidden relative"
      classList={{
        "transition-[width] duration-[var(--dur-short)] ease-[var(--ease-in-out)]":
          !resizing(),
      }}
      style={{ width: `${railed() ? SIDEBAR_RAIL_WIDTH : state.panels.terminalsSidebar}px` }}
      data-motion="sidebar-collapse"
    >
      <Show
        when={!railed()}
        fallback={
          <div class="flex flex-col items-center w-full h-full bg-sidebar py-2 gap-2">
            <button
              onClick={() => actions.toggleSidebarSection("terminals")}
              aria-expanded={false}
              aria-label="Show the terminals sidebar"
              title={"Show the terminals sidebar\nThe sidebar returns to the width you left it at"}
              class="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-[background-color,color] duration-[var(--dur-tint)] ease-out"
            >
              <TerminalSquare class="w-4 h-4" />
            </button>
          </div>
        }
      >
        <div class="h-9 pl-1.5 pr-1 border-b border-border flex items-center gap-1 shrink-0">
          <SidebarGrip id="terminals" />
          <TerminalSquare class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span class="flex-1 text-body font-semibold text-muted-foreground truncate">
            Terminals
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={() => {
              if (!activeRepoPath()) return;
              void actions.spawnTerminal(state.activeWorktreeId);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              if (!activeRepoPath()) return;
              void actions.spawnTerminal(state.activeWorktreeId);
            }}
            aria-label="New terminal"
            class={`p-0.5 rounded hover:bg-accent/60 text-muted-foreground hover:text-foreground transition-colors ${!activeRepoPath() ? "opacity-40 pointer-events-none" : ""}`}
            title="New terminal"
          >
            <Plus class="w-3.5 h-3.5" />
          </span>
          <SidebarMenuButton id="terminals" />
          <SidebarCollapseButton
            dock={dock()}
            label="the terminals sidebar"
            onCollapse={() => actions.toggleSidebarSection("terminals")}
          />
        </div>

        <div class="flex-1 overflow-y-auto scrollbar-thin p-1.5 density-gap">
          <Show
            when={activeTerminals().length > 0}
            fallback={
              <div class="px-2 py-3 text-center text-ui text-muted-foreground">
                <TerminalSquare class="w-4 h-4 mx-auto mb-1.5 opacity-60" />
                {activeRepoPath()
                  ? "No terminals. Click + to start one."
                  : "Open a folder to start a shell."}
              </div>
            }
          >
            <For each={activeTerminals()}>
              {(term) => (
                <TerminalRow
                  term={term}
                  active={term.id === activeTerminalId()}
                  onSelect={() => actions.selectTerminal(state.activeWorktreeId, term.id)}
                  onClose={() => actions.removeTerminal(state.activeWorktreeId, term.id)}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>

      {/* Rendered while collapsed too, disabled rather than absent — §7.6. */}
      <Splitter
        side={dock() === "left" ? "end" : "start"}
        label="Terminals sidebar width"
        value={state.panels.terminalsSidebar}
        min={PANEL_BOUNDS.terminalsSidebar.min}
        max={PANEL_BOUNDS.terminalsSidebar.max}
        defaultValue={PANEL_BOUNDS.terminalsSidebar.default}
        disabledReason={
          railed() ? "The terminals sidebar is collapsed — expand it to resize" : undefined
        }
        onDragStateChange={setResizing}
        onResize={(w) => actions.setPanelWidth("terminalsSidebar", w)}
      />
    </aside>
  );
}

/// One row per shell. Reads `store/activity.ts` and `store/terminalWatch.ts`;
/// it does not poll. Unchanged from `TerminalSidebar.tsx`'s row — see that
/// file's history for why it reads the shared signal system rather than
/// keeping its own.
function TerminalRow(props: {
  term: TerminalSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const watch = watchTerminal(props.term.id, props.term.ptyId);
  const [cwd, setCwd] = createSignal<string | null>(null);

  onMount(() => {
    let alive = true;
    const tick = async () => {
      try {
        const info = await terminalApi.processInfo(props.term.ptyId);
        if (alive) setCwd(info.cwd);
      } catch {
        // pty may be gone between ticks
      }
    };
    void tick();
    const unlistenExit = listen<unknown>(`pty-exit:${props.term.ptyId}`, () => {
      forgetTerminalHistory(props.term.ptyId);
      forgetPtySize(props.term.ptyId);
    });
    onCleanup(() => {
      alive = false;
      void unlistenExit.then((u) => u());
    });
  });

  const displayLabel = () => (watch.busy() && watch.processName()) || props.term.label;

  const mark = () =>
    tabMark(
      props.term.id,
      terminalSignal({
        working: watch.working(),
        agent: watch.agent(),
        waiting: watch.waiting(),
        focused: props.active,
      }),
    );

  return (
    <div
      class={`group flex items-center rounded-md border transition-colors focus-within:border-border ${
        props.active
          ? "bg-accent/60 border-border text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 focus-within:text-foreground focus-within:bg-accent/30"
      }`}
    >
      <button
        onClick={props.onSelect}
        aria-label={`Terminal: ${props.term.label}${mark() ? ` (${ledLabel(mark()!)})` : ""}`}
        class="flex-1 flex items-center gap-2 px-2 density-row min-w-0 text-left cursor-pointer focus-visible:outline-none"
      >
        <LedSlot signal={mark()} dim={!props.active} silent />
        <div class="flex-1 min-w-0">
          <div
            class="text-body truncate flex items-center gap-1.5"
            title={displayLabel() === props.term.label ? props.term.label : `${props.term.label} — ${displayLabel()}`}
          >
            <span class="truncate">{displayLabel()}</span>
          </div>
          <Show when={cwd()}>
            {(c) => (
              <div class="text-body text-muted-foreground truncate">{c()}</div>
            )}
          </Show>
        </div>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
        aria-label={`Kill terminal ${props.term.label}`}
        title="Kill terminal"
        class="p-0.5 mr-1 rounded opacity-60 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-[opacity,background-color,color] focus-visible:opacity-100"
      >
        <X class="w-3 h-3" />
      </button>
    </div>
  );
}
