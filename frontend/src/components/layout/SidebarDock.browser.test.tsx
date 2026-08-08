/// Dragging a sidebar to the opposite edge, mounted in a real browser.
///
/// `SidebarDockOverlay` resolves the drop entirely from `getBoundingClientRect`
/// (`dockEdgeAt` in `sidebarDrop.ts` divides the pointer's position by the
/// workbench's real width), and jsdom reports a zero rect for every element —
/// every drop in `render` would land in the same "no edge" band regardless of
/// where the pointer actually was. This is the one place that can prove the
/// drag actually re-docks a panel.
///
/// It doubles as the proof for `AppShell.tsx`'s no-remount contract, driven
/// through the real gesture rather than a synthetic signal flip (which is what
/// `AppShell.test.tsx` already covers in `render`): the workbench body owns
/// live PTYs, and a dock change has to be a style change on elements already
/// in the DOM, never a swap between two lists. Same assertion, real pointer
/// events, real layout.
import { describe, expect, it } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import { AppStoreContext } from "@/store/LayoutContext";
import { createAppStore, slotOrder, type AppStore } from "@/store/layout";
import { AppShell, type AppShellSidebar } from "./AppShell";
import { SidebarDockOverlay, SidebarGrip } from "./SidebarDock";

function press(source: Element, at: { x: number; y: number }) {
  source.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function moveTo(at: { x: number; y: number }) {
  window.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      buttons: 1,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function release(at: { x: number; y: number }) {
  window.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: at.x,
      clientY: at.y,
    }),
  );
}

function mount(store: AppStore) {
  const sidebars: AppShellSidebar[] = (["explorer", "git"] as const).map((id) => ({
    id,
    side: () => store.state.dockSide[id],
    order: () => slotOrder(store.state.dockSide[id], store.state.dockOrder.indexOf(id)),
    content: (
      <div data-testid={id} style={{ width: "200px", height: "100%" }} class="flex flex-col">
        <SidebarGrip id={id} />
      </div>
    ),
  }));

  const { container } = render(() => (
    <AppStoreContext.Provider value={store}>
      <div data-testid="harness" style={{ width: "800px", height: "600px", position: "relative" }}>
        <AppShell
          fill
          titleBar={null}
          sidebars={sidebars}
          main={<div data-testid="workbench">workbench body</div>}
          statusBar={<div />}
        />
        <SidebarDockOverlay />
      </div>
    </AppStoreContext.Provider>
  ));

  return { container };
}

describe("dragging a sidebar to the opposite edge", () => {
  it("re-docks it, and the workbench element is identity-equal before and after", async () => {
    const store = createAppStore({ persist: false });
    // Starting arrangement: explorer left, git right (the shipped default).
    expect(store.state.dockSide.explorer).toBe("left");
    expect(store.state.dockSide.git).toBe("right");

    mount(store);

    const workbenchBefore = screen.getByTestId("workbench");
    const gitSlotBefore = screen.getByTestId("git");

    const grip = screen.getByRole("button", { name: /drag to dock the git panel/i });
    const harness = screen.getByTestId("harness");
    const harnessRect = harness.getBoundingClientRect();
    const gripRect = grip.getBoundingClientRect();
    const origin = { x: gripRect.left + gripRect.width / 2, y: gripRect.top + gripRect.height / 2 };
    // Comfortably inside the left 20% dock zone (`DOCK_EDGE_ZONE` in
    // `sidebarDrop.ts`), and away from the grip's own starting point so the
    // move clears `DRAG_THRESHOLD_PX`.
    const leftEdge = { x: harnessRect.left + 40, y: harnessRect.top + harnessRect.height / 2 };

    press(grip, origin);
    // Two moves: the drag controller only "starts" (and calls the drop zone's
    // `over`) once the pointer has travelled past the threshold, so a single
    // jump straight to the target would still register as the first move.
    moveTo({ x: origin.x - 10, y: origin.y });
    moveTo(leftEdge);
    release(leftEdge);

    expect(store.state.dockSide.git).toBe("left");

    // Re-docked without remounting anything: the same DOM nodes, only the
    // slot's flex `order` (and therefore `data-dock`) changed.
    expect(screen.getByTestId("workbench")).toBe(workbenchBefore);
    expect(screen.getByTestId("git")).toBe(gitSlotBefore);
    expect(screen.getByTestId("git").closest("[data-sidebar]")).toHaveAttribute(
      "data-dock",
      "left",
    );
  });
});
