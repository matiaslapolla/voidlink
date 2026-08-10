/// The terminals sidebar, mounted with a real store.
///
/// The property worth proving is the one the split from `TerminalSidebar`
/// exists for: this panel renders the terminals list and nothing else — no
/// file tree, no agent dashboard. `FilesSidebar` and `AgentsSidebar` have the
/// analogous tests for their own slice.
import { describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";

import { TerminalsSidebar } from "./TerminalsSidebar";

function mount() {
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <TerminalsSidebar />
    </AppStoreContext.Provider>
  ));
  const aside = container.querySelector("aside");
  if (!aside) throw new Error("the sidebar did not mount");
  return { store, aside };
}

describe("TerminalsSidebar", () => {
  it("renders its own header and the terminals empty state", () => {
    mount();
    expect(screen.getByText("Terminals")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New terminal" })).toBeInTheDocument();
    expect(screen.getByText(/open a folder to start a shell/i)).toBeInTheDocument();
  });

  it("renders no file tree and no explorer disclosure", () => {
    mount();
    // The explorer's disclosure button, its "Open a folder to browse its
    // files" empty state and its tree rows all live in `FilesSidebar` now.
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByText(/browse its files/i)).toBeNull();
    expect(screen.queryByRole("treeitem")).toBeNull();
  });

  it("renders no agent dashboard", () => {
    mount();
    expect(screen.queryByText(/agent dashboard/i)).toBeNull();
    expect(screen.queryByText(/no agents running/i)).toBeNull();
  });

  it("has its own grip, menu and splitter", () => {
    mount();
    expect(
      screen.getByRole("button", { name: /drag to dock the terminals panel/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Terminals panel options" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Terminals sidebar width" })).toBeInTheDocument();
  });

  /// The way *out* of the panel, which it did not have: expanding was a rail
  /// you could click and collapsing was somewhere else entirely (the title
  /// bar, or a right-click). Both halves belong to the panel.
  it("collapses to its icon rail from its own header, and back", async () => {
    const { store } = mount();
    const collapse = screen.getByRole("button", { name: "Collapse the terminals sidebar" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");

    collapse.click();
    expect(store.state.sidebarSections.terminals).toBe(false);
    // The header is gone with the rest of the panel; the rail is what is left.
    expect(screen.queryByText("Terminals")).toBeNull();

    const expand = await screen.findByRole("button", { name: "Show the terminals sidebar" });
    expand.click();
    expect(store.state.sidebarSections.terminals).toBe(true);
  });
});
