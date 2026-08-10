/// `SidebarBodyMenuScope` (Stream D): a right-click anywhere in a sidebar's
/// body opens the same move/detach rows the ⋮ button (`SidebarMenuButton`)
/// does, built from the same `sidebarDockMenuItems` — and a right-click on a
/// nested row that has its own menu never opens this one, because that row
/// stops propagation before it gets here (the convention every existing
/// sidebar body already used, `main.tsx`'s comment on where it is documented).
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore } from "@/store/layout";
import { SidebarBodyMenuScope } from "./SidebarDock";

function mount() {
  const store = createAppStore({ persist: false });
  render(() => (
    <AppStoreContext.Provider value={store}>
      <SidebarBodyMenuScope id="explorer">
        <div data-testid="body" style={{ width: "200px", height: "200px" }}>
          <button
            data-testid="own-row"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            a file row with its own menu
          </button>
        </div>
      </SidebarBodyMenuScope>
    </AppStoreContext.Provider>
  ));
  return { store };
}

describe("a sidebar body's right-click menu", () => {
  it("opens the move/detach rows on a right-click over the body's bare chrome", async () => {
    const { store } = mount();
    fireEvent.contextMenu(screen.getByTestId("body"));

    const moveRight = await screen.findByRole("menuitem", { name: "Move to the right edge" });
    expect(screen.getByRole("menuitem", { name: "Move to the left edge" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    fireEvent.click(moveRight);
    expect(store.state.dockSide.explorer).toBe("right");
  });

  it("does not open when a nested row's own handler already stopped propagation", () => {
    mount();
    fireEvent.contextMenu(screen.getByTestId("own-row"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
