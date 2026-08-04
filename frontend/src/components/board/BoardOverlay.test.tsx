/// The board overlay, mounted.
///
/// The gesture *is* the surface — a board you cannot drag a card across is a
/// list with headings — so the drag test is the one that matters here. The rest
/// guard the states a board spends most of its life in (empty, no repo) and the
/// arguments the write actually sends across the boundary, which is where the
/// file-per-card design either holds or quietly stops holding.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { BoardOverlay, BoardOverlayHost } from "./BoardOverlay";

const REPO = "/repo";

interface StoredCard {
  id: string;
  title: string;
  column: string;
  order: number;
  rev: number;
  body: string;
}

/// A stand-in for `.voidlink/board/`, because the thing under test is a
/// read-modify-write against files. A fixed list of cards would let a drag
/// "pass" by rendering the same board it started with.
let disk: StoredCard[] = [];

const asWire = (c: StoredCard) => ({
  id: c.id,
  title: c.title,
  column: c.column,
  order: c.order,
  labels: [] as string[],
  created: "2026-08-04T10:00:00.000-03:00",
  path: `${c.id}.md`,
  rev: `rev-${c.rev}`,
});

/// Read one frontmatter scalar back out of what the surface wrote. The point
/// of parsing rather than trusting: the fake disk then holds what the *file*
/// says, so a move that produced the wrong markdown shows up as the wrong
/// board rather than as a passing test.
function field(content: string, name: string): string {
  return content.match(new RegExp(`^${name}: "?(.*?)"?$`, "m"))?.[1] ?? "";
}

function installBoard(cards: StoredCard[], columns = ["Todo", "Doing", "Done"]) {
  disk = cards;
  mockTauri({
    board_list_cards: () => ({ columns, cards: disk.map(asWire) }),
    board_read_card: (args) => {
      const card = disk.find((c) => c.id === args.cardId);
      if (!card) throw new Error(`no such card: ${String(args.cardId)}`);
      return { ...asWire(card), body: card.body };
    },
    board_save_card: (args) => {
      const id = String(args.cardId);
      const content = String(args.content);
      const existing = disk.find((c) => c.id === id);
      if ((existing ? `rev-${existing.rev}` : null) !== (args.expectedRev ?? null)) {
        throw new Error(`board-conflict: ${id} changed on disk since you read it`);
      }
      const next: StoredCard = {
        id,
        title: field(content, "title"),
        column: field(content, "column"),
        order: Number(field(content, "order")),
        rev: (existing?.rev ?? 0) + 1,
        body: content.split("---\n")[2] ?? "",
      };
      if (existing) Object.assign(existing, next);
      else disk.push(next);
      return { path: `.voidlink/board/${id}.md`, rev: `rev-${next.rev}` };
    },
  });
}

const THREE_CARDS: StoredCard[] = [
  { id: "a", title: "Wire the watcher", column: "Todo", order: 1, rev: 1, body: "why\n" },
  { id: "b", title: "Write the docs", column: "Todo", order: 2, rev: 1, body: "" },
  { id: "c", title: "Ship it", column: "Doing", order: 1, rev: 1, body: "" },
];

const onClose = vi.fn(() => {});

function mount(repoPath = REPO) {
  onClose.mockClear();
  return render(() => <BoardOverlay repoPath={repoPath} onClose={onClose} />);
}

const tile = (title: string) => screen.getByLabelText(title);
const columnOf = (title: string) =>
  tile(title).closest("[data-board-column]")?.getAttribute("data-board-column");
const columnBody = (name: string) => document.querySelector(`[data-board-column="${name}"]`)!;

beforeEach(() => {
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

/// The gesture the surface exists for.
describe("dragging a card between columns", () => {
  it("moves it, by rewriting exactly that one card's file", async () => {
    mount();
    const card = await screen.findByLabelText("Wire the watcher");
    expect(columnOf("Wire the watcher")).toBe("Todo");

    fireEvent.dragStart(card);
    fireEvent.dragOver(columnBody("Done"));
    fireEvent.drop(columnBody("Done"));

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
    expect(disk.find((c) => c.id === "b")).toMatchObject({ column: "Todo", rev: 1 });
    expect(disk.find((c) => c.id === "c")).toMatchObject({ column: "Doing", rev: 1 });
  });

  /// The whole reason the write carries a `rev`.
  it("re-reads the card immediately before writing it, and sends that revision", async () => {
    mount();
    const card = await screen.findByLabelText("Ship it");
    fireEvent.dragStart(card);
    fireEvent.drop(columnBody("Todo"));

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
    mount();
    const card = await screen.findByLabelText("Wire the watcher");

    mockTauri({
      board_read_card: (args) => {
        const stored = disk.find((c) => c.id === args.cardId)!;
        const asRead = { ...asWire(stored), body: stored.body };
        stored.title = "Retitled elsewhere";
        stored.rev = 9;
        return asRead;
      },
    });

    fireEvent.dragStart(card);
    fireEvent.drop(columnBody("Done"));

    // The board reloads and shows what is actually on disk, in its own column.
    await waitFor(() => expect(screen.getByLabelText("Retitled elsewhere")).toBeInTheDocument());
    expect(columnOf("Retitled elsewhere")).toBe("Todo");
    expect(disk.find((c) => c.id === "a")!.title).toBe("Retitled elsewhere");
  });

  it("writes nothing when a card is dropped back where it started", async () => {
    mount();
    const card = await screen.findByLabelText("Wire the watcher");
    fireEvent.dragStart(card);
    fireEvent.drop(tile("Wire the watcher"));
    await waitFor(() => expect(tauriCalls("board_save_card")).toHaveLength(0));
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

    disk.push({
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
