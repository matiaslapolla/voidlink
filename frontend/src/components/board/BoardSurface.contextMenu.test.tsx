/// The board's context menus (Stream D): empty space offers "New card" (the
/// same composer the header's own "+ New card" button opens — no second
/// implementation), and a card offers "Open card in editor" when the caller
/// gave one. "Delete card" is deliberately absent — see `BoardSurface.tsx`'s
/// comment by the menu state for why: `boardApi` has no delete command to
/// reach for.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, fireEvent } from "@solidjs/testing-library";
import { installBoard, mountBoard as mount, tile, THREE_CARDS } from "./boardFixture";

beforeEach(() => {
  installBoard(structuredClone(THREE_CARDS));
});

describe("the board's empty-space menu", () => {
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
  it("offers Open card in editor when the caller gave onOpenCard, and passes the board-relative path", async () => {
    const onOpenCard = vi.fn();
    mount(undefined, onOpenCard);
    await screen.findByLabelText("Wire the watcher");

    fireEvent.contextMenu(tile("Wire the watcher"));
    const open = await screen.findByRole("menuitem", { name: "Open card in editor" });
    fireEvent.click(open);

    expect(onOpenCard).toHaveBeenCalledWith("a.md");
  });

  it("offers no menu at all when the caller gave no onOpenCard", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    fireEvent.contextMenu(tile("Wire the watcher"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not also open the empty-space menu for a right-click on a card", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    fireEvent.contextMenu(tile("Wire the watcher"));
    // Only one menu on screen, not the card's plus the column's.
    expect(screen.queryAllByRole("menu")).toHaveLength(0);
  });
});
