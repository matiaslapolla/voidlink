/// The workspace rail's collapse, mounted.
///
/// The rail was the one sidebar in the shell that could not be collapsed — it
/// could only be resized, or removed entirely by zen. The property worth
/// mounting for is the same one `TerminalSidebar.test.tsx` asserts for the file
/// explorer, and for the same reason: collapsing has to give the *width* back
/// and expanding has to return the panel to the width the user dragged to, and
/// both are properties of the store and the component together. A build that
/// wrote the rail's 32px into `panels.rail` would look identical right up until
/// the user expanded it again and found the default.
///
/// Width is read off the inline style rather than off layout: jsdom has no
/// layout engine (see `vitest.config.ts`), and the inline width is the input to
/// the growth a real browser would show.
import { describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH } from "@/store/layout";

import { WorkspaceRail } from "./WorkspaceRail";

function mount() {
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <WorkspaceRail dock="left" />
    </AppStoreContext.Provider>
  ));
  const nav = container.querySelector("nav");
  if (!nav) throw new Error("the rail did not mount");
  return { store, nav };
}

const widthOf = (el: Element) => Number.parseInt((el as HTMLElement).style.width, 10);
const collapseButton = () =>
  screen.getByRole("button", { name: "Collapse the workspace rail" });
const expandButton = () =>
  screen.getByRole("button", { name: "Expand the workspace rail" });

describe("collapsing the workspace rail", () => {
  it("starts expanded at the persisted width", () => {
    const { nav } = mount();
    expect(collapseButton()).toHaveAttribute("aria-expanded", "true");
    expect(widthOf(nav)).toBe(PANEL_BOUNDS.rail.default);
  });

  it("collapses to the icon rail rather than to nothing, and says so", () => {
    return (async () => {
      const user = userEvent.setup();
      const { store, nav } = mount();
      store.actions.setPanelWidth("rail", 300);
      expect(widthOf(nav)).toBe(300);

      await user.click(collapseButton());

      // The way back is on the rail itself — a collapse with no visible way
      // out is a panel the user has lost.
      expect(expandButton()).toHaveAttribute("aria-expanded", "false");
      expect(widthOf(nav)).toBe(SIDEBAR_RAIL_WIDTH);
      expect(widthOf(nav)).toBeLessThan(PANEL_BOUNDS.rail.min);
    })();
  });

  it("restores the width the user left, not the default", async () => {
    const user = userEvent.setup();
    const { store, nav } = mount();
    store.actions.setPanelWidth("rail", 300);

    await user.click(collapseButton());
    await user.click(expandButton());

    expect(widthOf(nav)).toBe(300);
    expect(widthOf(nav)).not.toBe(PANEL_BOUNDS.rail.default);
  });

  it("keeps the collapse in the store, so it survives a reload", async () => {
    const user = userEvent.setup();
    const { store } = mount();
    await user.click(collapseButton());
    expect(store.state.workspaceRailCollapsed).toBe(true);
    // And the width is untouched underneath it, which is what makes the revive
    // exact rather than approximately right.
    expect(store.state.panels.rail).toBe(PANEL_BOUNDS.rail.default);
  });

  it("disables the splitter while collapsed, with the reason (§7.6)", async () => {
    const user = userEvent.setup();
    mount();
    const splitter = screen.getByRole("separator", { name: "Workspace rail width" });
    expect(splitter).not.toHaveAttribute("aria-disabled");

    await user.click(collapseButton());

    expect(splitter).toHaveAttribute("aria-disabled", "true");
    expect(splitter).toHaveAttribute(
      "title",
      "The workspace rail is collapsed — expand it to resize",
    );
  });

  it("is reachable from the keyboard in both directions", async () => {
    const user = userEvent.setup();
    mount();
    collapseButton().focus();
    await user.keyboard("{Enter}");
    expect(expandButton()).toHaveAttribute("aria-expanded", "false");

    expandButton().focus();
    await user.keyboard("{Enter}");
    expect(collapseButton()).toHaveAttribute("aria-expanded", "true");
  });
});

describe("the dock affordance", () => {
  it("offers a grip in the header and one on the collapsed rail", async () => {
    const user = userEvent.setup();
    mount();
    expect(
      screen.getByRole("button", { name: "Drag to dock the workspaces panel" }),
    ).toBeInTheDocument();

    await user.click(collapseButton());

    // Still draggable while collapsed: a panel you cannot move until you
    // expand it is a panel with two states and one gesture.
    expect(
      screen.getByRole("button", { name: "Drag to dock the workspaces panel" }),
    ).toBeInTheDocument();
  });

  it("puts the resize handle on the edge facing the workbench", () => {
    const handleOf = (dock: "left" | "right") => {
      const store = createAppStore({ persist: false });
      const { container } = render(() => (
        <AppStoreContext.Provider value={store}>
          <WorkspaceRail dock={dock} />
        </AppStoreContext.Provider>
      ));
      return container.querySelector('[role="separator"]') as HTMLElement;
    };
    // `Splitter` offsets an `end` handle from the right and a `start` handle
    // from the left. Docked left, the rail is dragged by its right edge; docked
    // right, by its left one — otherwise the handle would sit against the
    // window frame with nothing on the far side of it.
    expect(handleOf("left").style.right).not.toBe("");
    expect(handleOf("left").style.left).toBe("");
    expect(handleOf("right").style.left).not.toBe("");
    expect(handleOf("right").style.right).toBe("");
  });
});
