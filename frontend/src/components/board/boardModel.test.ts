import { describe, expect, it } from "vitest";
import type { BoardCard, BoardSnapshot } from "@/types/board";
import {
  buildCardMarkdown,
  groupIntoColumns,
  isMisfiled,
  mintCardId,
  movedCardMarkdown,
  planMove,
} from "./boardModel";

function card(id: string, column: string, order: number): BoardCard {
  return {
    id,
    title: id,
    column,
    order,
    labels: [],
    created: "2026-08-04T10:00:00.000-03:00",
    path: `${id}.md`,
    rev: `rev-${id}`,
  };
}

const COLUMNS = ["Todo", "Doing", "Done"];

function snapshot(cards: BoardCard[], columns = COLUMNS): BoardSnapshot {
  return { columns, cards };
}

const ids = (cards: BoardCard[]) => cards.map((c) => c.id);

describe("groupIntoColumns", () => {
  it("puts each card in the column its frontmatter names", () => {
    const grouped = groupIntoColumns(
      snapshot([card("a", "Todo", 1), card("b", "Doing", 1), card("c", "Done", 1)]),
    );
    expect(grouped.map((c) => c.name)).toEqual(COLUMNS);
    expect(grouped.map((c) => ids(c.cards))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps declared columns that hold nothing", () => {
    const grouped = groupIntoColumns(snapshot([card("a", "Todo", 1)]));
    expect(grouped).toHaveLength(3);
    expect(grouped[1].cards).toEqual([]);
  });

  /// The property that matters most: a hand-edited or agent-written card with
  /// a column nobody declared is still work someone wrote down.
  it("falls a card with an unknown column into the first column rather than dropping it", () => {
    const stray = card("stray", "Blocked", 1);
    const grouped = groupIntoColumns(snapshot([card("a", "Todo", 2), stray]));

    expect(ids(grouped[0].cards)).toContain("stray");
    expect(grouped.flatMap((c) => ids(c.cards))).toHaveLength(2);
    expect(isMisfiled(stray, snapshot([stray]))).toBe(true);
    expect(isMisfiled(card("a", "Todo", 1), snapshot([]))).toBe(false);
  });

  it("orders a column by order, breaking ties on id so the sequence is stable", () => {
    const grouped = groupIntoColumns(
      snapshot([
        card("z", "Todo", 2),
        card("m", "Todo", 1),
        // Two cards handed the same order by concurrent writers.
        card("b", "Todo", 3),
        card("a", "Todo", 3),
      ]),
    );
    expect(ids(grouped[0].cards)).toEqual(["m", "z", "a", "b"]);

    // Re-grouping the same snapshot in a different input order must not move
    // anything: a refresh that reshuffled tied cards would make the board
    // twitch on every external write.
    const reversed = groupIntoColumns(
      snapshot([card("a", "Todo", 3), card("b", "Todo", 3), card("z", "Todo", 2), card("m", "Todo", 1)]),
    );
    expect(ids(reversed[0].cards)).toEqual(["m", "z", "a", "b"]);
  });
});

describe("planMove", () => {
  const board = () =>
    groupIntoColumns(
      snapshot([
        card("a", "Todo", 1),
        card("b", "Todo", 2),
        card("c", "Todo", 3),
        card("x", "Doing", 1),
      ]),
    );

  /// The claim the float ordering exists to make.
  it("rewrites exactly one card when inserting between two others", () => {
    const moves = planMove(board(), "x", "Todo", 1);
    expect(moves).toEqual([{ id: "x", column: "Todo", order: 1.5 }]);
  });

  it("places the moved card where it was asked to go", () => {
    const moves = planMove(board(), "x", "Todo", 1);
    const moved = { ...card("x", "Doing", 1), column: moves[0].column, order: moves[0].order };
    const after = groupIntoColumns(
      snapshot([card("a", "Todo", 1), card("b", "Todo", 2), card("c", "Todo", 3), moved]),
    );
    expect(ids(after[0].cards)).toEqual(["a", "x", "b", "c"]);
    expect(after[1].cards).toEqual([]);
  });

  it("appends past the end and prepends before the start with one write each", () => {
    expect(planMove(board(), "x", "Todo", 99)).toEqual([{ id: "x", column: "Todo", order: 4 }]);
    expect(planMove(board(), "x", "Todo", 0)).toEqual([{ id: "x", column: "Todo", order: 0 }]);
  });

  it("gives the first card of an empty column an order of its own", () => {
    expect(planMove(board(), "a", "Done", 0)).toEqual([{ id: "a", column: "Done", order: 1 }]);
  });

  it("writes nothing when a card is dropped where it already is", () => {
    expect(planMove(board(), "b", "Todo", 1)).toEqual([]);
    expect(planMove(board(), "nope", "Todo", 0)).toEqual([]);
    expect(planMove(board(), "a", "Nowhere", 0)).toEqual([]);
  });

  /// The escape hatch: no midpoint exists between two cards that share an
  /// order, so the column is renumbered rather than the drop being ignored.
  it("renumbers the destination when no midpoint exists between the neighbours", () => {
    const tied = groupIntoColumns(
      snapshot([card("a", "Todo", 1), card("b", "Todo", 1), card("x", "Doing", 1)]),
    );
    const moves = planMove(tied, "x", "Todo", 1);
    expect(moves).toEqual([
      { id: "a", column: "Todo", order: 1 },
      { id: "x", column: "Todo", order: 2 },
      { id: "b", column: "Todo", order: 3 },
    ]);
  });
});

describe("mintCardId", () => {
  it("dates and slugs the title", () => {
    expect(mintCardId("Wire the watcher", "2026-08-04T10:00:00.000-03:00", [])).toBe(
      "2026-08-04-wire-the-watcher",
    );
  });

  it("suffixes a taken id rather than overwriting the card that holds it", () => {
    const taken = ["2026-08-04-ship-it", "2026-08-04-ship-it-2"];
    expect(mintCardId("Ship it", "2026-08-04T00:00:00.000-03:00", taken)).toBe(
      "2026-08-04-ship-it-3",
    );
  });

  it("still produces a file name for a title with nothing sluggable in it", () => {
    expect(mintCardId("!!! ???", "2026-08-04T00:00:00.000-03:00", [])).toBe("2026-08-04-card");
  });
});

describe("the on-disk format", () => {
  it("writes flat frontmatter the Rust parser reads back", () => {
    expect(
      buildCardMarkdown({
        id: "2026-08-04-wire-the-watcher",
        title: "Wire the watcher",
        column: "Doing",
        order: 1.5,
        labels: ["rust", "watch"],
        created: "2026-08-04T10:00:00.000-03:00",
        body: "Why it matters.",
      }),
    ).toBe(
      [
        "---",
        "id: 2026-08-04-wire-the-watcher",
        "type: card",
        'title: "Wire the watcher"',
        'column: "Doing"',
        "order: 1.5",
        'labels: ["rust", "watch"]',
        'created: "2026-08-04T10:00:00.000-03:00"',
        "---",
        "Why it matters.",
        "",
      ].join("\n"),
    );
  });

  it("omits labels entirely when there are none", () => {
    const md = buildCardMarkdown({
      id: "x",
      title: "X",
      column: "Todo",
      order: 1,
      labels: [],
      created: "2026-08-04T10:00:00.000-03:00",
      body: "",
    });
    expect(md).not.toContain("labels:");
  });

  /// A move changes two lines and nothing else. The body and the labels are
  /// the user's; a drag must not rewrite them.
  it("a moved card keeps its title, labels, created stamp and body", () => {
    const original: BoardCard = {
      ...card("2026-08-04-a", "Todo", 1),
      title: "A real title",
      labels: ["ops"],
    };
    const md = movedCardMarkdown(
      original,
      { id: original.id, column: "Done", order: 7.5 },
      "The body, untouched.",
    );
    expect(md).toContain('title: "A real title"');
    expect(md).toContain('labels: ["ops"]');
    expect(md).toContain('created: "2026-08-04T10:00:00.000-03:00"');
    expect(md).toContain('column: "Done"');
    expect(md).toContain("order: 7.5");
    expect(md).toContain("The body, untouched.");
  });
});
