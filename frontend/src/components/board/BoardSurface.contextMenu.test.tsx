/// The board's context menus, and specifically the boundary between the two.
///
/// Two streams landed a menu on this surface. The card's menu is the richer
/// one (open, rename, labels, due date) and is exercised through the routes
/// that reach it in `BoardOverlay.test.tsx`; what is only testable here is the
/// *space* menu and the fact that the two never both open. A card sits inside
/// a column which sits inside the columns strip, and all three carry a
/// `contextmenu` handler — so without `stopPropagation` at each level a
/// right-click on a card opens the card's menu and the column's on top of it.
///
/// "Delete card" is absent from both, deliberately: `boardApi` has list, read
/// and save, and no delete to reach for. See `BoardSurface.tsx`'s comment by
/// the menu state.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";
import { installBoard, mountBoard as mount, tile, THREE_CARDS } from "./boardFixture";

beforeEach(() => {
  installBoard(structuredClone(THREE_CARDS));
});

describe("the board's space menu", () => {
  it("opens New card on a right-click over bare column space, and it starts the composer", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    const column = document.querySelector('[data-board-column="Todo"]')!;

    fireEvent.contextMenu(column);
    const newCard = await screen.findByRole("menuitem", { name: "New card" });
    fireEvent.click(newCard);

    expect(await screen.findByPlaceholderText("Card title")).toBeInTheDocument();
  });
});

describe("a card's context menu", () => {
  it("opens exactly one menu — the card's, not the column's underneath it", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");

    fireEvent.contextMenu(tile("Wire the watcher"));

    expect(screen.queryAllByRole("menu")).toHaveLength(1);
    // The card's rows, not the space menu's single "New card".
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New card" })).not.toBeInTheDocument();
  });
});
