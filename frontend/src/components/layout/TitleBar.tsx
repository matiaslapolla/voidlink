import { Show, type JSX } from "solid-js";
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Minus,
  Square,
  X,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  ArrowLeftRight,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  GitBranch,
  FileCode,
} from "lucide-solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMac } from "@/api/platform";
import { openEditorWindow, openGitWindow } from "@/api/windows";
import { pushToast } from "@/commands/toast";
import { useTheme } from "@/store/theme";
import { DEV_CHROME_CLASS, DevBadge } from "@/components/layout/devChrome";
import { ViewSwitcher } from "@/components/layout/ViewSwitcher";
import { isStackedMode } from "@/commands/environment";
import { useAppStore } from "@/store/LayoutContext";
import type { DockSide, SidebarId } from "@/store/layout";
import { SIDEBAR_LABEL } from "@/components/layout/SidebarDock";
import { getAction, runAction } from "@/commands/registry";
import { shortcutLabel } from "@/commands/shortcuts";

interface TitleBarProps {
  onOpenSettings: () => void;
}

/// Back / forward across the navigation history.
///
/// The button runs the registered action rather than calling the store, so the
/// chord and the click are one code path — the same reason the palette rows do.
/// A history with nowhere to go renders the button disabled with the reason in
/// its `title`, which §7.6 requires of every disabled control.
function NavButton(props: {
  actionId: string;
  enabled: boolean;
  label: string;
  disabledReason: string;
  children: JSX.Element;
}) {
  const accelerator = () => shortcutLabel(props.actionId);
  const title = () =>
    props.enabled
      ? `${props.label}${accelerator() ? ` (${accelerator()})` : ""}`
      : props.disabledReason;
  return (
    <button
      onClick={() => {
        const action = getAction(props.actionId);
        if (action) void runAction(action);
      }}
      disabled={!props.enabled}
      aria-disabled={!props.enabled}
      aria-label={props.label}
      title={title()}
      class="w-9 flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      classList={{
        "hover:bg-accent/60 hover:text-foreground": props.enabled,
        "opacity-40 cursor-not-allowed": !props.enabled,
      }}
    >
      {props.children}
    </button>
  );
}

export function TitleBar(props: TitleBarProps) {
  const { mode, toggleTheme } = useTheme();
  const { state, canGoBack, canGoForward, actions } = useAppStore();

  // Resolved per click, not once at construction. `getCurrentWindow()` reads
  // Tauri's injected metadata and throws where that is absent — which used to
  // take the whole render down in a plain browser, breaking `make frontend`.
  // The buttons that need it are macOS-hidden anyway, so nothing is lost.
  const withWindow = (fn: (w: ReturnType<typeof getCurrentWindow>) => void) => () => {
    try {
      fn(getCurrentWindow());
    } catch {
      /* not running under Tauri */
    }
  };

  // Visual semantics follow what the user sees, not where state lives: the
  // `PanelLeft` button toggles a content sidebar docked on the left, and
  // `PanelRight` one docked on the right. The workspace rail has its own
  // button (`ui.toggle-workspace-rail`) and is excluded here.
  //
  // With five independently dockable sidebars an edge can hold more than one
  // of these at once — the git panel and the explorer can both end up on the
  // right, for instance — so a lookup that assumed at most one per edge would
  // either toggle the wrong panel or silently do nothing. `contentIdsOn`
  // returns every content sidebar on that edge in the user's own screen order
  // (`dockOrder`), the button acts on the first one, and its title says so
  // explicitly when there are more — "say what it means" rather than pretend
  // one button covers an edge it does not.
  const contentIdsOn = (side: DockSide): SidebarId[] =>
    state.dockOrder.filter((id) => id !== "workspaces" && state.dockSide[id] === side);

  const isCollapsed = (id: SidebarId): boolean => {
    switch (id) {
      case "explorer":
        return state.leftSidebarCollapsed;
      case "git":
        return state.gitSidebarCollapsed;
      case "terminals":
        return !state.sidebarSections.terminals;
      case "agents":
        return !state.sidebarSections.agents;
      case "workspaces":
        return state.workspaceRailCollapsed;
    }
  };
  const toggle = (id: SidebarId): void => {
    switch (id) {
      case "explorer":
        actions.toggleLeftSidebar();
        break;
      case "git":
        actions.toggleGitSidebar();
        break;
      case "terminals":
        actions.toggleSidebarSection("terminals");
        break;
      case "agents":
        actions.toggleSidebarSection("agents");
        break;
      case "workspaces":
        actions.toggleWorkspaceRail();
        break;
    }
  };

  const panelOn = (side: DockSide): SidebarId | null => contentIdsOn(side)[0] ?? null;
  const collapsedOn = (side: DockSide) => {
    const id = panelOn(side);
    return id ? isCollapsed(id) : true;
  };
  const toggleOn = (side: DockSide) => {
    const id = panelOn(side);
    if (id) toggle(id);
  };
  const labelOn = (side: DockSide) => {
    const ids = contentIdsOn(side);
    const id = ids[0];
    if (!id) return `No panel is docked on the ${side}`;
    const extra =
      ids.length > 1
        ? ` — ${ids.length - 1} more panel${ids.length > 2 ? "s" : ""} also on this edge`
        : "";
    return `${isCollapsed(id) ? "Show" : "Hide"} the ${SIDEBAR_LABEL[id].toLowerCase()} (${side})${extra}`;
  };

  return (
    <div
      /* The title bar is window chrome, not an island: it stays flush to the
         window edge (it carries the traffic lights) and takes the canvas
         colour, so the islands below read as floating on it. Its `border-b` is
         gone with the islands' — the 8px canvas inset is the separation. */
      class={`flex items-stretch h-8 shrink-0 select-none bg-canvas ${DEV_CHROME_CLASS}`}
    >
      {/*
        Tauri's injected drag-region script already starts a native drag on
        mousedown and toggles maximise on double click, so no handlers here.
        On macOS the left padding clears the traffic lights the OS draws over
        this bar (they end at 66px; see trafficLightPosition in tauri.conf.json).
      */}
      <div
        data-tauri-drag-region
        class="flex-1 flex items-center pr-3 text-body text-muted-foreground"
        classList={{ "pl-3": !isMac(), "pl-[78px]": isMac() }}
      >
        <span class="font-semibold tracking-wide text-foreground/80 pointer-events-none">
          Voidlink
        </span>
        <DevBadge class="ml-2 pointer-events-none" />
      </div>
      <div class="flex items-stretch text-muted-foreground">
        <NavButton
          actionId="ui.navigate-back"
          enabled={canGoBack()}
          label="Go back"
          disabledReason="Nothing to go back to yet"
        >
          <ArrowLeft class="w-3.5 h-3.5" />
        </NavButton>
        <NavButton
          actionId="ui.navigate-forward"
          enabled={canGoForward()}
          label="Go forward"
          disabledReason="Nothing to go forward to"
        >
          <ArrowRight class="w-3.5 h-3.5" />
        </NavButton>
        <div class="w-px self-center h-4 bg-border mx-1" />
        {/* The workspace rail's toggle, beside the other two sidebars' — it
            became collapsible in the same change that made it dockable, and a
            collapse with no title-bar control would be the one sidebar you
            could only reach from its own header. Runs the registered action, so
            the button, the chord and the palette row are one code path. */}
        <NavButton
          actionId="ui.toggle-workspace-rail"
          enabled
          label={state.workspaceRailCollapsed ? "Show the workspace rail" : "Collapse the workspace rail"}
          disabledReason=""
        >
          <PanelLeftClose class="w-3.5 h-3.5" />
        </NavButton>
        <button
          onClick={() => toggleOn("left")}
          disabled={!panelOn("left")}
          aria-disabled={!panelOn("left")}
          aria-label={labelOn("left")}
          aria-pressed={!collapsedOn("left")}
          class={`w-9 flex items-center justify-center transition-colors ${panelOn("left") ? "hover:bg-accent/60 hover:text-foreground" : "opacity-40 cursor-not-allowed"} ${collapsedOn("left") ? "" : "text-foreground"}`}
          title={labelOn("left")}
        >
          <PanelLeft class="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => toggleOn("right")}
          disabled={!panelOn("right")}
          aria-disabled={!panelOn("right")}
          aria-label={labelOn("right")}
          aria-pressed={!collapsedOn("right")}
          class={`w-9 flex items-center justify-center transition-colors ${panelOn("right") ? "hover:bg-accent/60 hover:text-foreground" : "opacity-40 cursor-not-allowed"} ${collapsedOn("right") ? "" : "text-foreground"}`}
          title={labelOn("right")}
        >
          <PanelRight class="w-3.5 h-3.5" />
        </button>
        {/*
          Wider than their neighbours on purpose. The others toggle panels
          inside this window; these two leave it, and the dashed border plus the
          up-right arrow are the two conventions that say "opens elsewhere"
          before the click rather than after — which is exactly why stacked mode
          shows a segmented switcher instead: there, nothing leaves the window.
        */}
        <Show when={isStackedMode()} fallback={<>
        <button
          onClick={() => {
            void openEditorWindow().catch((e) =>
              pushToast(
                `Could not open the editor window: ${e instanceof Error ? e.message : String(e)}`,
                "error",
              ),
            );
          }}
          aria-label="Open editor window"
          title="Open the code editor in its own window"
          class="self-center ml-1 flex items-center gap-1 h-[22px] px-1.5 rounded border border-dashed border-border text-label hover:bg-accent/60 hover:text-foreground hover:border-border/80 transition-colors"
        >
          <FileCode class="w-3 h-3 shrink-0" />
          Editor
          <ArrowUpRight class="w-3 h-3 shrink-0 opacity-70" />
        </button>
        <button
          onClick={() => {
            void openGitWindow().catch((e) =>
              pushToast(
                `Could not open the git window: ${e instanceof Error ? e.message : String(e)}`,
                "error",
              ),
            );
          }}
          aria-label="Open git window"
          title="Open the git client in its own window"
          class="self-center mx-1 flex items-center gap-1 h-[22px] px-1.5 rounded border border-dashed border-border text-label hover:bg-accent/60 hover:text-foreground hover:border-border/80 transition-colors"
        >
          <GitBranch class="w-3 h-3 shrink-0" />
          Git
          <ArrowUpRight class="w-3 h-3 shrink-0 opacity-70" />
        </button>
        </>}>
          <ViewSwitcher />
        </Show>
        {/* Repurposed rather than removed. It was a two-state swap of two
            slots; it now mirrors the whole arrangement — every panel to the
            opposite edge, order reversed — which is what the icon always
            claimed. It is no longer a *state*, so there is no `aria-pressed`:
            pressing it twice returns the layout it found. */}
        <NavButton
          actionId="ui.swap-sidebars"
          enabled
          label="Mirror the sidebar layout"
          disabledReason=""
        >
          <ArrowLeftRight class="w-3.5 h-3.5" />
        </NavButton>
        <div class="w-px self-center h-4 bg-border mx-1" />
        <button
          onClick={toggleTheme}
          aria-label={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title={mode() === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          <Show when={mode() === "dark"} fallback={<Moon class="w-3.5 h-3.5" />}>
            <Sun class="w-3.5 h-3.5" />
          </Show>
        </button>
        <button
          onClick={props.onOpenSettings}
          aria-label="Settings"
          class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
          title="Settings"
        >
          <SettingsIcon class="w-3.5 h-3.5" />
        </button>
        {/* On macOS the OS draws the traffic lights, so we must not draw our own. */}
        <Show when={!isMac()}>
          <button
            onClick={withWindow((w) => void w.minimize())}
            aria-label="Minimize"
            class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
            title="Minimize"
          >
            <Minus class="w-3.5 h-3.5" />
          </button>
          <button
            onClick={withWindow((w) => void w.toggleMaximize())}
            aria-label="Maximize"
            class="w-9 flex items-center justify-center hover:bg-accent/60 hover:text-foreground transition-colors"
            title="Maximize"
          >
            <Square class="w-3.5 h-3.5" />
          </button>
          <button
            onClick={withWindow((w) => void w.close())}
            aria-label="Close"
            class="w-9 flex items-center justify-center hover:bg-destructive hover:text-destructive-foreground transition-colors"
            title="Close"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </Show>
      </div>
    </div>
  );
}
