/// Dragging a card across the board, in a real browser.
///
/// The gesture *is* the surface — a board you cannot drag a card across is a
/// list with headings — so this is the test that matters for it. It lives in
/// the browser project because the drag resolves its destination from
/// `getBoundingClientRect`: the column under the pointer, and the card the
/// release lands in front of. jsdom reports a zero rect for every element, so
/// there the pointer is inside nothing, no column would ever be hit, and the
/// assertions could not fail. It used to pass there only because the old
/// implementation was HTML5 drag-and-drop, where `fireEvent.drop(column)` names
/// the target directly and no geometry is consulted at all — the test was
/// asserting the write, and taking the routing on faith.
///
/// Everything that is *not* geometry — what the board renders, what the write
/// sends, the external-edit refetch — stays in `BoardOverlay.test.tsx`.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@solidjs/testing-library";
import { lastInvokeArgs, mockTauri, tauriCalls } from "@/test/tauri";
import { cancelDrag } from "@/components/layout/dragDrop";
import {
  asWire,
  boardDisk,
  columnBody,
  columnOf,
  installBoard,
  mountBoard,
  REPO,
  THREE_CARDS,
  tile,
} from "./boardFixture";

/// Drive a pointer drag from `source` to `at`. The first move has to clear
/// `DRAG_THRESHOLD_PX` or the controller treats the press as a click.
function dragTo(source: Element, at: { x: number; y: number }) {
  const from = source.getBoundingClientRect();
  source.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: 1,
      clientX: from.left + from.width / 2,
      clientY: from.top + from.height / 2,
    }),
  );
  for (const p of [at, at]) {
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        buttons: 1,
        clientX: p.x,
        clientY: p.y,
      }),
    );
  }
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

/// A point low in a column's body — past every card in it, so the drop appends
/// rather than landing in front of something.
function endOf(name: string) {
  const r = columnBody(name).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 8 };
}

beforeEach(() => {
  cancelDrag();
  installBoard(structuredClone(THREE_CARDS));
});

describe("dragging a card between columns", () => {
  it("moves it, by rewriting exactly that one card's file", async () => {
    mountBoard();
    const card = await screen.findByLabelText("Wire the watcher");
    expect(columnOf("Wire the watcher")).toBe("Todo");

    dragTo(card, endOf("Done"));

    await waitFor(() => expect(columnOf("Wire the watcher")).toBe("Done"));

    // One card written, and it is the one that was dragged.
    expect(tauriCalls("board_save_card")).toHaveLength(1);
    const args = lastInvokeArgs("board_save_card")!;
    expect(args.repoRoot).toBe(REPO);
    expect(args.cardId).toBe("a");
    expect(args.content).toContain('column: "Done"');
    // The card's own body survives the move: a drag changes where it sits,
    // not what it says.
    expect(args.content).toContain("why");

    // Everything else is untouched on disk.
    expect(boardDisk().find((c) => c.id === "b")).toMatchObject({ column: "Todo", rev: 1 });
    expect(boardDisk().find((c) => c.id === "c")).toMatchObject({ column: "Doing", rev: 1 });
  });

  /// The whole reason the write carries a `rev`.
  it("re-reads the card immediately before writing it, and sends that revision", async () => {
    mountBoard();
    const card = await screen.findByLabelText("Ship it");
    dragTo(card, endOf("Todo"));

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    expect(tauriCalls("board_read_card")).toHaveLength(1);
    expect(lastInvokeArgs("board_save_card")!.expectedRev).toBe("rev-1");
    // And no commit is asked for, ever.
    expect(lastInvokeArgs("board_save_card")).not.toHaveProperty("message");
  });

  /// The race the `rev` exists for, narrowed to the only window the surface
  /// cannot close by re-reading: between its read and its write.
  ///
  /// An external edit made *before* the drop is not this case — the re-read
  /// picks it up and the move lands on top of it, which is the point of
  /// re-reading. So the other writer is scheduled inside `board_read_card`,
  /// where it is genuinely unobservable to the caller.
  it("refuses to clobber a card someone else wrote between the read and the write", async () => {
    mountBoard();
    const card = await screen.findByLabelText("Wire the watcher");

    mockTauri({
      board_read_card: (args: Record<string, unknown>) => {
        const stored = boardDisk().find((c) => c.id === args.cardId)!;
        const asRead = { ...asWire(stored), body: stored.body };
        stored.title = "Retitled elsewhere";
        stored.rev = 9;
        return asRead;
      },
    });

    dragTo(card, endOf("Done"));

    // The board reloads and shows what is actually on disk, in its own column.
    await waitFor(() => expect(screen.getByLabelText("Retitled elsewhere")).toBeInTheDocument());
    expect(columnOf("Retitled elsewhere")).toBe("Todo");
    expect(boardDisk().find((c) => c.id === "a")!.title).toBe("Retitled elsewhere");
  });

  it("writes nothing when a card is dropped back where it started", async () => {
    mountBoard();
    const card = await screen.findByLabelText("Wire the watcher");
    const at = tile("Wire the watcher").getBoundingClientRect();
    dragTo(card, { x: at.left + at.width / 2, y: at.top + 2 });
    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(0));
  });

  it("drops into the position the pointer is at, not just the column", async () => {
    mountBoard();
    await screen.findByLabelText("Ship it");
    // "Ship it" is alone in Doing; move it into Todo *above* "Wire the
    // watcher", which is the assertion a column-level target could not make.
    const anchor = tile("Wire the watcher").getBoundingClientRect();
    dragTo(tile("Ship it"), { x: anchor.left + anchor.width / 2, y: anchor.top + 2 });

    await waitFor(() => expect(columnOf("Ship it")).toBe("Todo"));
    const order = [...columnBody("Todo").querySelectorAll("[data-card-id]")].map(
      (el) => el.getAttribute("data-card-id"),
    );
    expect(order).toEqual(["c", "a", "b"]);
  });
});
