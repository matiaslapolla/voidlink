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
import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import {
  emitTauriEvent,
  lastInvokeArgs,
  tauriCalls,
  tauriListenerCount,
} from "@/test/tauri";
import { isOverlayOpen } from "@/commands/overlay";
import { closeBoard, openBoard } from "@/commands/registry";
import { BOARD_CHANGED_EVENT } from "@/api/board";

import { BoardOverlayHost } from "./BoardOverlay";
// The fake disk and the mount helpers are shared with the browser project —
// see `boardFixture.tsx` for why the drag had to move there.
import {
  boardDisk,
  columnBody,
  columnOf,
  installBoard,
  mountBoard as mount,
  onClose,
  REPO,
  THREE_CARDS,
} from "./boardFixture";

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
