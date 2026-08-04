/// The left sidebar collapsing to its icon rail, mounted.
///
/// The behaviour this file exists for is the one a reader cannot check by
/// reading `TerminalSidebar.tsx`: that collapsing gives the *width* back and
/// that expanding returns the panel to the width the user dragged to rather
/// than to `PANEL_BOUNDS.sidebar.default`. Both are properties of the store and
/// the component together — the rail's width is applied at render and never
/// written to `panels.sidebar`, which is only true if nothing on the collapse
/// path touches it.
///
/// **Width is read off the inline style, not off layout.** jsdom has no layout
/// engine (see `vitest.config.ts`), so `getBoundingClientRect` is zeroes and
/// there is no measurable "content region" to watch grow. The inline width is
/// the input to that growth: `AppShell` gives the sidebar `flex-shrink-0` and
/// the main column `flex-1`, so a smaller sidebar is a larger workbench by
/// construction. A test that wanted the pixels themselves would belong in the
/// browser project.
///
/// One provider, and a real `createAppStore({ persist: false })` rather than a
/// fake: the component reads `state.panels`, `state.sidebarSections` and four
/// actions, and a fake of that surface would be a second store to keep in step.
import { describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, PANEL_BOUNDS, SIDEBAR_RAIL_WIDTH } from "@/store/layout";

import { TerminalSidebar } from "./TerminalSidebar";

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

/// The panel's rendered width in px. `style.width` rather than a class, because
/// this is the one dimension the component computes rather than declares.
const widthOf = (el: Element) =>
  Number.parseInt((el as HTMLElement).style.width, 10);

const filesToggle = () => screen.getByRole("button", { name: "Files" });
const railButton = () => screen.getByRole("button", { name: "Show the file explorer" });

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
