/// The board overlay, mounted in jsdom.
///
/// What is here: the states a board spends most of its life in (empty, no
/// repo), the arguments the write actually sends across the boundary — which is
/// where the file-per-card design either holds or quietly stops holding — and
/// the external-edit refetch.
///
/// What is *not* here: the drag. It resolves its destination from
/// `getBoundingClientRect` and jsdom has no layout, so it lives in
/// `BoardOverlay.browser.test.tsx` and shares this file's fixture.
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import {
  emitTauriEvent,
  lastInvokeArgs,
  mockTauri,
  tauriCalls,
  tauriListenerCount,
} from "@/test/tauri";
import { isOverlayOpen } from "@/commands/overlay";
import { closeBoard, openBoard } from "@/commands/registry";
import { BOARD_CHANGED_EVENT } from "@/api/board";
import { resetToasts, useToasts } from "@/commands/toast";

import { BoardOverlayHost } from "./BoardOverlay";
// The fake disk and the mount helpers are shared with the browser project —
// see `boardFixture.tsx` for why the drag had to move there.
import {
  asWire,
  boardDisk,
  columnBody,
  columnOf,
  installBoard,
  mountBoard as mount,
  onClose,
  onOpenCard,
  REPO,
  THREE_CARDS,
} from "./boardFixture";

beforeEach(() => {
  resetToasts();
  installBoard(structuredClone(THREE_CARDS));
});

describe("the board it renders", () => {
  it("lays the cards out in the columns their frontmatter names", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    expect(columnOf("Wire the watcher")).toBe("Todo");
    expect(columnOf("Ship it")).toBe("Doing");
    // A declared column with nothing in it still exists — the point of
    // declaring them in `board.md` at all.
    expect(columnBody("Done")).not.toBeNull();
  });

  /// A card whose column nobody declared is still work somebody wrote down.
  it("shows a card with an undeclared column in the first column, and says so", async () => {
    installBoard([{ id: "x", title: "Orphan", column: "Blocked", order: 1, rev: 1, body: "" }]);
    mount();
    await screen.findByLabelText("Orphan");
    expect(columnOf("Orphan")).toBe("Todo");
    expect(screen.getByText(/“Blocked” is not declared/)).toBeInTheDocument();
  });
});

/// The decision this stream is built on: a card's body opens in the real
/// editor, as a file, because that is what it already is.
describe("opening a card's body", () => {
  const CARD_PATH = `${REPO}/.voidlink/board/a.md`;

  it("opens the markdown file on double-click", async () => {
    mount();
    fireEvent.dblClick(await screen.findByLabelText("Wire the watcher"));
    expect(onOpenCard).toHaveBeenCalledWith(CARD_PATH);
  });

  it("opens it on Enter, from the keyboard, without a pointer", async () => {
    const user = userEvent.setup();
    mount();
    const card = await screen.findByLabelText("Wire the watcher");
    // The tile is a real tab stop, which is the thing that makes the keyboard
    // path exist at all (§10.2).
    expect(card).toHaveAttribute("tabindex", "0");
    card.focus();
    await user.keyboard("{Enter}");
    expect(onOpenCard).toHaveBeenCalledWith(CARD_PATH);
  });

  it("opens it from the context menu", async () => {
    const user = userEvent.setup();
    mount();
    fireEvent.contextMenu(await screen.findByLabelText("Wire the watcher"));
    await user.click(await screen.findByRole("menuitem", { name: "Open in editor" }));
    expect(onOpenCard).toHaveBeenCalledWith(CARD_PATH);
  });

  /// Opening a card writes nothing. A board that touched the file to show it
  /// would spend a `rev` on a read.
  it("writes nothing", async () => {
    mount();
    fireEvent.dblClick(await screen.findByLabelText("Wire the watcher"));
    expect(tauriCalls("board_save_card")).toHaveLength(0);
  });
});

/// The rename is the same rev-checked read-modify-write a move is — see
/// `BoardSurface`'s header for why that is not optional.
describe("renaming a card on its face", () => {
  async function startRename(title: string) {
    const user = userEvent.setup();
    mount();
    const card = await screen.findByLabelText(title);
    card.focus();
    await user.keyboard("{F2}");
    return { user, input: await screen.findByLabelText(`Rename ${title}`) };
  }

  it("re-reads the card, writes the new title with that revision, and survives the refetch", async () => {
    const { user, input } = await startRename("Wire the watcher");
    await user.clear(input);
    await user.type(input, "Wire it properly{Enter}");

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    const args = lastInvokeArgs("board_save_card")!;
    expect(args.cardId).toBe("a");
    expect(args.content).toContain('title: "Wire it properly"');
    // The re-read is what supplies the revision, and the body it read is what
    // goes back — a rename must not empty a card.
    expect(tauriCalls("board_read_card")).toHaveLength(1);
    expect(args.expectedRev).toBe("rev-1");
    expect(args.content).toContain("why");

    expect(await screen.findByLabelText("Wire it properly")).toBeInTheDocument();
    expect(boardDisk().find((c) => c.id === "a")!.title).toBe("Wire it properly");
  });

  it("abandons the edit on Escape, writing nothing", async () => {
    const { user, input } = await startRename("Wire the watcher");
    await user.clear(input);
    await user.type(input, "Never mind{Escape}");
    await waitFor(() => expect(screen.getByLabelText("Wire the watcher")).toBeInTheDocument());
    expect(tauriCalls("board_save_card")).toHaveLength(0);
  });

  /// The failure the `rev` exists to produce, and the only acceptable
  /// response to it: say so, reload, and do not retry.
  it("says so rather than silently losing the edit when the card changed underneath it", async () => {
    const { user, input } = await startRename("Wire the watcher");

    // Somebody else writes the card inside the window the surface cannot see:
    // between its read and its write.
    mockTauri({
      board_read_card: (args: Record<string, unknown>) => {
        const stored = boardDisk().find((c) => c.id === args.cardId)!;
        const asRead = { ...asWire(stored), body: stored.body };
        stored.title = "Retitled elsewhere";
        stored.rev = 9;
        return asRead;
      },
    });

    await user.clear(input);
    await user.type(input, "Wire it properly{Enter}");

    await waitFor(() =>
      expect(useToasts().toasts().map((t) => t.message)).toContainEqual(
        expect.stringContaining("changed on disk"),
      ),
    );
    // And the board shows what is actually on disk, not the edit that failed.
    expect(await screen.findByLabelText("Retitled elsewhere")).toBeInTheDocument();
    expect(screen.queryByLabelText("Wire it properly")).toBeNull();
  });
});

describe("labels on the card face", () => {
  it("adds one, and writes it into the card's frontmatter", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByLabelText("Wire the watcher");

    await user.click(screen.getByRole("button", { name: "Add a label to Wire the watcher" }));
    await user.type(screen.getByLabelText("Add a label to Wire the watcher"), "rust{Enter}");

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    expect(lastInvokeArgs("board_save_card")!.content).toContain('labels: ["rust"]');
    // The chip is on the card, not only in the filter bar the label now feeds.
    expect(
      await screen.findByRole("button", { name: "Remove label rust from Wire the watcher" }),
    ).toBeInTheDocument();
  });

  it("removes one, leaving the card with no labels line at all", async () => {
    const user = userEvent.setup();
    installBoard([
      { id: "a", title: "Labelled", column: "Todo", order: 1, rev: 1, body: "", labels: ["rust"] },
    ]);
    mount();
    await screen.findByLabelText("Labelled");

    await user.click(screen.getByRole("button", { name: "Remove label rust from Labelled" }));

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    expect(lastInvokeArgs("board_save_card")!.content).not.toContain("labels:");
    // The chip goes, and so does the filter row the label was the only source
    // of — a filter for a label nothing carries is a control with no effect.
    await waitFor(() => expect(screen.queryByText("rust")).toBeNull());
  });

  it("narrows the board to the cards carrying the label the filter names", async () => {
    const user = userEvent.setup();
    installBoard([
      { id: "a", title: "Rusty", column: "Todo", order: 1, rev: 1, body: "", labels: ["rust"] },
      { id: "b", title: "Plain", column: "Todo", order: 2, rev: 1, body: "" },
    ]);
    mount();
    await screen.findByLabelText("Rusty");
    expect(screen.getByLabelText("Plain")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show only cards labelled rust" }));

    await waitFor(() => expect(screen.queryByLabelText("Plain")).toBeNull());
    expect(screen.getByLabelText("Rusty")).toBeInTheDocument();
    // Narrowing is not deleting: the header says what is hidden.
    expect(screen.getByText("1 of 2 cards")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop filtering by rust" }));
    expect(await screen.findByLabelText("Plain")).toBeInTheDocument();
  });
});

describe("dates on the card face", () => {
  it("shows the day a card was created", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    expect(screen.getAllByTitle("Created 2026-08-04T10:00:00.000-03:00").length).toBeGreaterThan(0);
  });

  it("sets a due date, writes it, and shows it", async () => {
    const user = userEvent.setup();
    mount();
    fireEvent.contextMenu(await screen.findByLabelText("Wire the watcher"));
    await user.click(await screen.findByRole("menuitem", { name: "Set due date" }));

    const input = await screen.findByLabelText("Due date for Wire the watcher");
    fireEvent.input(input, { target: { value: "2026-08-31" } });
    await user.keyboard("{Enter}");

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    expect(lastInvokeArgs("board_save_card")!.content).toContain('due: "2026-08-31"');
    expect(await screen.findByTitle(/Due 2026-08-31/)).toBeInTheDocument();
  });

  /// The one thing a due date is for.
  it("marks a card whose due date has passed, in words as well as in colour", async () => {
    installBoard([
      { id: "a", title: "Late", column: "Todo", order: 1, rev: 1, body: "", due: "2000-01-01" },
    ]);
    mount();
    await screen.findByLabelText("Late");
    expect(screen.getByTitle("Overdue — was due 2000-01-01")).toHaveClass("text-warning");
  });

  it("clears a due date from the context menu, and offers nothing to clear when there is none", async () => {
    const user = userEvent.setup();
    installBoard([
      { id: "a", title: "Dated", column: "Todo", order: 1, rev: 1, body: "", due: "2026-08-31" },
      { id: "b", title: "Undated", column: "Todo", order: 2, rev: 1, body: "" },
    ]);
    mount();

    fireEvent.contextMenu(await screen.findByLabelText("Undated"));
    expect(await screen.findByRole("menuitem", { name: "Clear due date" })).toHaveAttribute(
      "title",
      "This card has no due date",
    );
    await user.keyboard("{Escape}");

    fireEvent.contextMenu(screen.getByLabelText("Dated"));
    await user.click(await screen.findByRole("menuitem", { name: "Clear due date" }));

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    expect(lastInvokeArgs("board_save_card")!.content).not.toContain("due:");
  });

  /// The compatibility claim, from the surface's side: every card on disk
  /// today predates this field.
  it("loads a card written before the due date existed, without one and without complaint", async () => {
    mount();
    expect(await screen.findByLabelText("Wire the watcher")).toBeInTheDocument();
    expect(useToasts().toasts()).toEqual([]);
    expect(screen.queryByTitle(/^Due /)).toBeNull();
  });
});

describe("creating a card", () => {
  it("writes a new file into the first column, with no expected revision", async () => {
    const user = userEvent.setup();
    installBoard([]);
    mount();

    await user.click(await screen.findByRole("button", { name: /new card/i }));
    await user.type(screen.getByPlaceholderText("Card title"), "A fresh card");
    await user.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(1));
    const args = lastInvokeArgs("board_save_card")!;
    expect(args.cardId).toMatch(/^\d{4}-\d{2}-\d{2}-a-fresh-card$/);
    expect(args.expectedRev).toBeNull();
    expect(args.content).toContain('column: "Todo"');
    await waitFor(() => expect(screen.getByLabelText("A fresh card")).toBeInTheDocument());
  });
});

/// The file-per-card design is a claim the UI has to honour: a card written by
/// anything else must appear without a manual refresh.
describe("external edits", () => {
  it("refetches when Rust reports the board changed", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    await waitFor(() => expect(tauriListenerCount(BOARD_CHANGED_EVENT)).toBe(1));

    boardDisk().push({
      id: "d",
      title: "Written by an agent",
      column: "Doing",
      order: 2,
      rev: 1,
      body: "",
    });
    emitTauriEvent(BOARD_CHANGED_EVENT, REPO);

    expect(await screen.findByLabelText("Written by an agent")).toBeInTheDocument();
  });

  it("ignores a change reported for a different repository", async () => {
    mount();
    await screen.findByLabelText("Wire the watcher");
    await waitFor(() => expect(tauriListenerCount(BOARD_CHANGED_EVENT)).toBe(1));
    const before = tauriCalls("board_list_cards").length;

    emitTauriEvent(BOARD_CHANGED_EVENT, "/some/other/repo");

    expect(tauriCalls("board_list_cards")).toHaveLength(before);
  });
});

/// §9.7 wants the empty state to name why it is empty and offer the fix as a
/// real control, not as prose.
describe("the empty states", () => {
  it("names the fix when the board has no cards", async () => {
    installBoard([]);
    mount();
    expect(await screen.findByText("This project's board has no cards.")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add the first card" }));
    expect(screen.getByPlaceholderText("Card title")).toBeInTheDocument();
  });

  it("says what would fix it when no repository is open", () => {
    mount("");
    expect(screen.getByText(/open a repository/i)).toBeInTheDocument();
  });
});

describe("dismissal and overlay registration", () => {
  it("closes on ESC, on the scrim and on the button, but not on the panel", async () => {
    const user = userEvent.setup();
    mount();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close Board" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  /// A child webview composites above the DOM, so an overlay that does not
  /// register here is simply invisible whenever a browser tab is open.
  it("registers while the board is open and releases when it closes", () => {
    openBoard();
    expect(isOverlayOpen()).toBe(true);
    closeBoard();
    expect(isOverlayOpen()).toBe(false);
  });

  it("registers nothing while the host is closed", () => {
    render(() => <BoardOverlayHost open={false} repoPath={REPO} onClose={onClose} />);
    expect(isOverlayOpen()).toBe(false);
  });
});
