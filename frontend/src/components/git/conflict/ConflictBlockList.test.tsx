/// Per-conflict resolution controls, mounted.
///
/// The failure this guards against is the same shape as the diff renderer's
/// wrong-hunk-index bug, one level up: a file has N conflicts, every card
/// offers three identically-worded actions, and a card wired to the wrong
/// block rewrites lines the user was not looking at — after which the buffer
/// still parses, still shows one fewer conflict, and looks resolved. So every
/// assertion here is about *which block* came back, scoped to the card it was
/// clicked in.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { parseConflicts, type ConflictBlock } from "@/components/editor/conflictMarkers";

import { ConflictBlockList } from "./ConflictBlockList";

/// A real two-conflict file, parsed by the real parser rather than hand-built:
/// the line numbers the cards print are `parseConflicts`' output, and a
/// fixture that invented them would agree with itself and nothing else.
const FILE = [
  "top",
  "<<<<<<< HEAD",
  "our first",
  "=======",
  "their first",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "our second",
  "||||||| base",
  "ancestor second",
  "=======",
  "their second",
  ">>>>>>> feature",
  "bottom",
].join("\n");

function blocks(): ConflictBlock[] {
  return parseConflicts(FILE).blocks;
}

function mount(over: Partial<Parameters<typeof ConflictBlockList>[0]> = {}) {
  const onAccept = vi.fn();
  const onFocusBlock = vi.fn();
  render(() => (
    <ConflictBlockList
      blocks={blocks()}
      activeIndex={0}
      onAccept={onAccept}
      onFocusBlock={onFocusBlock}
      {...over}
    />
  ));
  return { onAccept, onFocusBlock };
}

describe("what each card shows", () => {
  it("lists one card per conflict, numbered and located", () => {
    mount();
    expect(screen.getByText("Conflict 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Conflict 2 of 2")).toBeInTheDocument();
    // 0-indexed inside, 1-indexed on screen: the numbers have to match what an
    // editor's gutter would say or they are worse than no numbers.
    expect(screen.getByText("· lines 2–6")).toBeInTheDocument();
    expect(screen.getByText("· lines 8–14")).toBeInTheDocument();
  });

  it("shows both sides with the branch names git wrote into the markers", () => {
    mount();
    expect(screen.getAllByText("Ours (HEAD)")).toHaveLength(2);
    expect(screen.getAllByText("Theirs (feature)")).toHaveLength(2);
    expect(screen.getByText("our first")).toBeInTheDocument();
    expect(screen.getByText("their second")).toBeInTheDocument();
  });

  /// Only diff3 markers carry an ancestor. Printing "Common ancestor: (empty)"
  /// for a block that has none would state a fact about the merge that git did
  /// not record.
  it("shows the common ancestor only for the block that has one", () => {
    mount();
    expect(screen.getAllByText("Common ancestor")).toHaveLength(1);
    expect(screen.getByText("ancestor second")).toBeInTheDocument();
  });
});

describe("acting on one conflict", () => {
  /// The contract. Three buttons per card, two cards, and the only thing
  /// telling them apart is which block object comes back.
  it("sends the block of the card whose button was clicked", async () => {
    const user = userEvent.setup();
    const { onAccept } = mount();

    await user.click(screen.getByRole("button", { name: "Accept theirs for conflict 2" }));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(blocks()[1], "theirs");

    await user.click(screen.getByRole("button", { name: "Accept ours for conflict 1" }));
    expect(onAccept).toHaveBeenLastCalledWith(blocks()[0], "ours");
  });

  it("distinguishes the three choices", async () => {
    const user = userEvent.setup();
    const { onAccept } = mount();

    await user.click(screen.getByRole("button", { name: "Accept both for conflict 1" }));
    expect(onAccept).toHaveBeenCalledExactlyOnceWith(blocks()[0], "both");
  });

  /// The list and the header's prev/next cursor have to agree about which
  /// conflict is current, or the header's own accept buttons act somewhere
  /// other than where the highlight is.
  it("reports a click on a card so the cursor can follow it", async () => {
    const user = userEvent.setup();
    const { onFocusBlock } = mount();

    await user.click(screen.getByText("Conflict 2 of 2"));
    expect(onFocusBlock).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("marks the active card and only the active one", () => {
    mount({ activeIndex: 1 });
    const cards = screen.getAllByRole("listitem");
    expect(cards[0].className).not.toMatch(/border-primary/);
    expect(cards[1].className).toMatch(/border-primary/);
  });
});

describe("a file with nothing left to resolve", () => {
  it("renders an empty list rather than a card with no content", () => {
    render(() => (
      <ConflictBlockList blocks={[]} activeIndex={0} onAccept={vi.fn()} onFocusBlock={vi.fn()} />
    ));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
