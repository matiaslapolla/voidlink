/// The agent dashboard sidebar, mounted with a real store.
///
/// The property worth proving is the one the split from `TerminalSidebar`
/// exists for: this panel renders `AgentDashboard` and nothing else — no
/// terminals list, no file tree.
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { useSettings } from "@/store/settings";

import { AgentsSidebar } from "./AgentsSidebar";

function mount() {
  const store = createAppStore({ persist: false });
  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <AgentsSidebar />
    </AppStoreContext.Provider>
  ));
  const aside = container.querySelector("aside");
  if (!aside) throw new Error("the sidebar did not mount");
  return { store, aside };
}

beforeEach(() => {
  useSettings().updateExperimental({ agentDashboard: true, showIdleAgents: false });
});

describe("AgentsSidebar", () => {
  it("renders its own header and the dashboard's empty state", () => {
    mount();
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText(/no agents running in this workspace/i)).toBeInTheDocument();
  });

  it("renders no terminals list", () => {
    mount();
    expect(screen.queryByRole("button", { name: "New terminal" })).toBeNull();
    expect(screen.queryByText(/open a folder to start a shell/i)).toBeNull();
  });

  it("renders no file tree and no explorer disclosure", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Files" })).toBeNull();
    expect(screen.queryByText(/browse its files/i)).toBeNull();
    expect(screen.queryByRole("treeitem")).toBeNull();
  });

  it("has its own grip, menu and splitter", () => {
    mount();
    expect(
      screen.getByRole("button", { name: /drag to dock the agents panel/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agents panel options" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Agents sidebar width" })).toBeInTheDocument();
  });
});
