/// The left sidebar, mounted. Two concerns landed here from two branches and
/// they are kept apart deliberately, because they want different stores.
///
/// **Collapsing to the icon rail** needs a real `createAppStore({ persist: false })`:
/// the behaviour a reader cannot check by reading `TerminalSidebar.tsx` is that
/// collapsing gives the *width* back and that expanding returns the panel to the
/// width the user dragged to rather than to `PANEL_BOUNDS.sidebar.default`. Both
/// are properties of the store and the component together — the rail's width is
/// applied at render and never written to `panels.sidebar`, which is only true if
/// nothing on the collapse path touches it. A fake of that surface would be a
/// second store to keep in step.
///
/// **The experimental Agent Dashboard entry** wants the opposite: a fake store and
/// `files={false}`, to keep the explorer's own Tauri traffic out of a test about
/// one disclosure header. The property worth mounting for is that *behind the flag*
/// means the entry is not in the document, not that it is in the document with
/// `display: none` — only mounting tells those apart, and they are the same
/// screenshot.
///
/// **Width is read off the inline style, not off layout.** jsdom has no layout
/// engine (see `vitest.config.ts`), so `getBoundingClientRect` is zeroes and there
/// is no measurable "content region" to watch grow. The inline width is the input
/// to that growth: `AppShell` gives the sidebar `flex-shrink-0` and the main column
/// `flex-1`, so a smaller sidebar is a larger workbench by construction. A test
/// that wanted the pixels themselves would belong in the browser project.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { AppStoreContext } from "@/store/LayoutContext";
import { useSettings } from "@/store/settings";
import { createAppStore, PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH, type AppStore } from "@/store/layout";

import { TerminalSidebar } from "./TerminalSidebar";

/// The real store. Used by the collapse tests, which are about store and
/// component agreeing.
function mount() {
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <TerminalSidebar />
    </AppStoreContext.Provider>
  ));
  const aside = container.querySelector("aside");
  if (!aside) throw new Error("the sidebar did not mount");
  return { store, aside };
}

function fakeStore(): AppStore {
  return {
    state: {
      panels: { sidebar: 256, sidebarTerminalsHeight: 208, sidebarAgentsHeight: 256 },
      sidebarSections: { files: true, terminals: true, agents: true },
      activeWorktreeId: "wt1",
      terminalsByWorktree: {},
      workspaces: [],
      activeWorkspaceId: "ws1",
    },
    activeWorkspace: () => ({ id: "ws1", name: "api", worktrees: [] }),
    activeRepoPath: () => "/repos/api",
    activeTerminals: () => [],
    activeItem: () => null,
    actions: {
      toggleSidebarSection: vi.fn(),
      selectTerminal: vi.fn(),
      selectWorktree: vi.fn(),
      removeTerminal: vi.fn(),
      spawnTerminal: vi.fn(),
      setRepoRoot: vi.fn(),
      openCompareTab: vi.fn(),
      setPanelWidth: vi.fn(),
    },
  } as unknown as AppStore;
}

/// The fake store, with the explorer off. Used by the flag-gating tests.
function mountGated() {
  return render(() => (
    <AppStoreContext.Provider value={fakeStore()}>
      <TerminalSidebar files={false} />
    </AppStoreContext.Provider>
  ));
}

/// The panel's rendered width in px. `style.width` rather than a class, because
/// this is the one dimension the component computes rather than declares.
const widthOf = (el: Element) => Number.parseInt((el as HTMLElement).style.width, 10);

const filesToggle = () => screen.getByRole("button", { name: "Files" });
const railButton = () => screen.getByRole("button", { name: "Show the file explorer" });
const entry = () => screen.queryByRole("button", { name: /agent dashboard/i });

/// Module-level, so the experimental flags are off before *every* test here —
/// including the collapse ones, which must not start passing or failing because
/// a dashboard test ran first.
beforeEach(() => {
  useSettings().updateExperimental({ agentDashboard: false, showIdleAgents: false });
});

describe("collapsing the file explorer", () => {
  it("starts expanded, at the persisted width", () => {
    const { aside } = mount();
    expect(filesToggle()).toHaveAttribute("aria-expanded", "true");
    expect(widthOf(aside)).toBe(PANEL_BOUNDS.sidebar.default);
  });

  it("collapses to the rail and hands the width back to the workbench", async () => {
    const user = userEvent.setup();
    const { store, aside } = mount();
    store.actions.setPanelWidth("sidebar", 320);
    expect(widthOf(aside)).toBe(320);

    await user.click(filesToggle());

    // The disclosure control is now the rail's icon, and it says the panel is
    // collapsed rather than gone.
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(railButton()).toHaveAttribute("aria-expanded", "false");
    // Narrower than the panel can be dragged to: the difference is what the
    // content area grows by.
    expect(widthOf(aside)).toBe(SIDEBAR_RAIL_WIDTH);
    expect(widthOf(aside)).toBeLessThan(PANEL_BOUNDS.sidebar.min);
  });

  it("restores the width the user left, not the default", async () => {
    const user = userEvent.setup();
    const { store, aside } = mount();
    store.actions.setPanelWidth("sidebar", 320);

    await user.click(filesToggle());
    await user.click(railButton());

    expect(filesToggle()).toHaveAttribute("aria-expanded", "true");
    expect(widthOf(aside)).toBe(320);
    expect(widthOf(aside)).not.toBe(PANEL_BOUNDS.sidebar.default);
  });

  it("survives a round trip through the store, since the flag is global", async () => {
    const user = userEvent.setup();
    const { store } = mount();
    await user.click(filesToggle());
    // Not a per-worktree field: what the rail is showing is what a reload — or
    // a switch to another worktree — would revive.
    expect(store.state.sidebarSections.files).toBe(false);
    expect(store.state.panels.sidebar).toBe(PANEL_BOUNDS.sidebar.default);
  });

  it("disables the splitter while collapsed, with the reason", async () => {
    const user = userEvent.setup();
    mount();
    const splitter = screen.getByRole("separator", {
      name: "Files and terminals sidebar width",
    });
    expect(splitter).not.toHaveAttribute("aria-disabled");

    await user.click(filesToggle());

    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(splitter).toHaveAttribute(
      "title",
      "The file explorer is collapsed — expand it to resize the sidebar",
    );
    // Not focusable either: a handle you can tab to and then not move is a
    // control that lies about what it does.
    expect(splitter).toHaveAttribute("tabindex", "-1");
  });

  it("is reachable from the keyboard in both directions", async () => {
    const user = userEvent.setup();
    mount();
    filesToggle().focus();
    await user.keyboard("{Enter}");
    expect(railButton()).toHaveAttribute("aria-expanded", "false");

    railButton().focus();
    await user.keyboard("{Enter}");
    expect(filesToggle()).toHaveAttribute("aria-expanded", "true");
  });
});

/// The Files/Terminals/Agents disclosures each grew a height handle on the
/// seam above them, so the user can decide how much of the sidebar each one
/// gets rather than living with Terminals' old fixed `max-h-52`. A collapsed
/// section has nothing to resize — the handle renders disabled with a reason
/// (MASTER §7.6) rather than vanishing, the same contract the sidebar's own
/// width splitter already has.
describe("stacked section height handles", () => {
  const terminalsToggle = () => screen.getByRole("button", { name: /^terminals$/i });

  it("enables the Files/Terminals handle while Terminals is open", () => {
    mount();
    const splitter = screen.getByRole("separator", { name: "Terminals section height" });
    expect(splitter).not.toHaveAttribute("aria-disabled");
  });

  it("disables the Files/Terminals handle once Terminals collapses, with the reason", async () => {
    const user = userEvent.setup();
    mount();
    const splitter = screen.getByRole("separator", { name: "Terminals section height" });

    await user.click(terminalsToggle());

    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(splitter).toHaveAttribute(
      "title",
      "Terminals is collapsed — expand it to resize",
    );
    expect(splitter).toHaveAttribute("tabindex", "-1");
  });

  it("survives a reload at the size the user dragged to", () => {
    const { store } = mount();
    store.actions.setPanelWidth("sidebarTerminalsHeight", 260);
    expect(store.state.panels.sidebarTerminalsHeight).toBe(260);
  });

  it("omits the Files/Terminals handle when Files is not rendered here (vertical tabs)", () => {
    render(() => (
      <AppStoreContext.Provider value={fakeStore()}>
        <TerminalSidebar files={false} />
      </AppStoreContext.Provider>
    ));
    expect(
      screen.queryByRole("separator", { name: "Terminals section height" }),
    ).toBeNull();
  });

  it("enables the Terminals/Agent Dashboard handle only behind the experimental flag", () => {
    useSettings().updateExperimental({ agentDashboard: true });
    mount();
    expect(
      screen.getByRole("separator", { name: "Agent Dashboard section height" }),
    ).not.toHaveAttribute("aria-disabled");
  });

  it("disables the Terminals/Agent Dashboard handle once Agent Dashboard collapses", async () => {
    const user = userEvent.setup();
    useSettings().updateExperimental({ agentDashboard: true });
    mount();
    const splitter = screen.getByRole("separator", { name: "Agent Dashboard section height" });

    await user.click(screen.getByRole("button", { name: /agent dashboard/i }));

    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(splitter).toHaveAttribute(
      "title",
      "Agent Dashboard is collapsed — expand it to resize",
    );
  });
});

describe("the Agent Dashboard sidebar entry", () => {
  /// Absent, not hidden. If this ever starts passing because the element is
  /// present-but-invisible, the flag has stopped gating the poll as well —
  /// `useAgentSessions` is what subscribes `processInfo` to terminals outside
  /// the active worktree, and it runs the moment the component mounts.
  it("is absent with the flag off", () => {
    mountGated();
    expect(entry()).toBeNull();
    // The section it sits under is unaffected, so this is not asserting an
    // empty render.
    expect(screen.getByRole("button", { name: /^terminals$/i })).toBeInTheDocument();
  });

  it("is present with the flag on", () => {
    useSettings().updateExperimental({ agentDashboard: true });
    mountGated();
    expect(entry()).toBeInTheDocument();
  });

  /// The nested flag does not gate the entry — only the Idle column. A user who
  /// turned the dashboard on and idle agents off still has a dashboard.
  it("is present with the dashboard on and idle agents off", () => {
    useSettings().updateExperimental({ agentDashboard: true, showIdleAgents: false });
    mountGated();
    expect(entry()).toBeInTheDocument();
  });
});
