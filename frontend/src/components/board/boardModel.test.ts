import { describe, expect, it } from "vitest";
import type { BoardCard, BoardSnapshot } from "@/types/board";
import {
  boardLabels,
  buildCardMarkdown,
  dayOf,
  editedCardMarkdown,
  filterByLabels,
  groupIntoColumns,
  isMisfiled,
  isOverdue,
  labelTone,
  LABEL_TONE_COUNT,
  matchesLabels,
  mintCardId,
  movedCardMarkdown,
  planMove,
  todayISO,
} from "./boardModel";

function card(id: string, column: string, order: number): BoardCard {
  return {
    id,
    title: id,
    column,
    order,
    labels: [],
    created: "2026-08-04T10:00:00.000-03:00",
    due: null,
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

/// The `due` field, which is the one thing in this change that has to agree
/// with a parser written in another language.
describe("the due date on disk", () => {
  /// The round trip, this half of it.
  ///
  /// `EVERY_FIELD_MARKDOWN` in `src-tauri/src/board/mod.rs` is the same string,
  /// and that module's `parse_card_reads_back_every_field_the_frontend_serialises`
  /// asserts the parser reads every field out of it. Change the serialised form
  /// on either side without the other and one of the two tests fails.
  it("serialises a card with every field set to the exact bytes the Rust parser reads", () => {
    expect(
      buildCardMarkdown({
        id: "2026-08-04-wire-the-watcher",
        title: "Wire the watcher",
        column: "Doing",
        order: 1.5,
        labels: ["rust", "watch"],
        created: "2026-08-04T10:00:00.000-03:00",
        due: "2026-08-31",
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
        'due: "2026-08-31"',
        "---",
        "Why it matters.",
        "",
      ].join("\n"),
    );
  });

  /// The compatibility claim in the direction that matters most: what this
  /// build writes for a card with no due date is byte-identical to what the
  /// build before it wrote, so an older VoidLink reads it unchanged.
  it("omits the line entirely when there is no due date, however it is spelled", () => {
    const base = {
      id: "x",
      title: "X",
      column: "Todo",
      order: 1,
      labels: [],
      created: "2026-08-04T10:00:00.000-03:00",
      body: "",
    };
    const absent = buildCardMarkdown(base);
    expect(absent).not.toContain("due:");
    expect(buildCardMarkdown({ ...base, due: null })).toBe(absent);
    expect(buildCardMarkdown({ ...base, due: "" })).toBe(absent);
  });

  /// The other direction: a card the app read with no `due` keeps having none
  /// when something unrelated is written to it.
  it("does not invent a due date for a card that was loaded without one", () => {
    const md = movedCardMarkdown(card("a", "Todo", 1), { id: "a", column: "Done", order: 2 }, "b");
    expect(md).not.toContain("due:");
  });

  it("sets, keeps and clears the due date through an edit", () => {
    const dated = { ...card("a", "Todo", 1), due: "2026-08-31" };
    expect(editedCardMarkdown(dated, "", { title: "Renamed" })).toContain('due: "2026-08-31"');
    expect(editedCardMarkdown(dated, "", { due: "2026-09-01" })).toContain('due: "2026-09-01"');
    // `null` clears it; `undefined` is "not part of this edit" and is the case
    // above. Confusing the two is how a rename silently drops a deadline.
    expect(editedCardMarkdown(dated, "", { due: null })).not.toContain("due:");
  });

  it("keeps the body and every untouched field", () => {
    const original: BoardCard = {
      ...card("a", "Todo", 1),
      title: "A real title",
      labels: ["ops"],
      due: "2026-08-31",
    };
    const md = editedCardMarkdown(original, "The body, untouched.", { labels: ["ops", "rust"] });
    expect(md).toContain('title: "A real title"');
    expect(md).toContain('labels: ["ops", "rust"]');
    expect(md).toContain('created: "2026-08-04T10:00:00.000-03:00"');
    expect(md).toContain('due: "2026-08-31"');
    expect(md).toContain("The body, untouched.");
  });
});

describe("overdue", () => {
  it("marks a date before today and leaves today alone", () => {
    expect(isOverdue("2026-08-30", "2026-08-31")).toBe(true);
    // A deadline is a day, not an instant.
    expect(isOverdue("2026-08-31", "2026-08-31")).toBe(false);
    expect(isOverdue("2026-09-01", "2026-08-31")).toBe(false);
  });

  it("says nothing about a card with no due date", () => {
    expect(isOverdue(null, "2026-08-31")).toBe(false);
    expect(isOverdue("", "2026-08-31")).toBe(false);
    expect(isOverdue(undefined, "2026-08-31")).toBe(false);
  });

  it("compares the day of a full stamp, so `created` can be passed to it too", () => {
    expect(dayOf("2026-08-04T10:00:00.000-03:00")).toBe("2026-08-04");
    expect(dayOf(null)).toBe("");
    // The clock the cards are stamped in is the clock "today" is read from.
    expect(todayISO(Date.parse("2026-08-31T02:00:00.000Z"))).toBe("2026-08-30");
  });
});

describe("labels", () => {
  const labelled = (id: string, labels: string[]) => ({ ...card(id, "Todo", 1), labels });

  it("lists every label on the board once, sorted", () => {
    expect(
      boardLabels(snapshot([labelled("a", ["rust", "ops"]), labelled("b", ["rust"])])),
    ).toEqual(["ops", "rust"]);
    expect(boardLabels(snapshot([card("a", "Todo", 1)]))).toEqual([]);
  });

  it("gives one label one colour, every time, within the palette that exists", () => {
    expect(labelTone("rust")).toBe(labelTone("rust"));
    for (const label of ["rust", "ops", "", "a much longer label than any of these"]) {
      expect(labelTone(label)).toBeGreaterThanOrEqual(1);
      expect(labelTone(label)).toBeLessThanOrEqual(LABEL_TONE_COUNT);
    }
  });

  it("narrows the board, conjunctively, and passes everything through an empty filter", () => {
    const board = snapshot([
      labelled("a", ["rust", "ops"]),
      labelled("b", ["rust"]),
      labelled("c", []),
    ]);

    expect(ids(filterByLabels(board, []).cards)).toEqual(["a", "b", "c"]);
    expect(ids(filterByLabels(board, ["rust"]).cards)).toEqual(["a", "b"]);
    // A second label narrows further rather than widening.
    expect(ids(filterByLabels(board, ["rust", "ops"]).cards)).toEqual(["a"]);
    expect(ids(filterByLabels(board, ["nobody-uses-this"]).cards)).toEqual([]);

    expect(matchesLabels(labelled("a", ["rust"]), ["rust"])).toBe(true);
    expect(matchesLabels(labelled("a", ["rust"]), ["ops"])).toBe(false);
  });

  /// A column emptied by a filter still exists. Dropping it would make the
  /// board look like it lost a column rather than like it is filtered.
  it("keeps the declared columns whatever the filter hides", () => {
    const filtered = filterByLabels(snapshot([labelled("a", ["rust"])]), ["nothing"]);
    expect(filtered.columns).toEqual(COLUMNS);
    expect(groupIntoColumns(filtered)).toHaveLength(3);
  });
});
