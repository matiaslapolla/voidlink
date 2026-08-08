/// The board's model: grouping, ordering, and id minting. Pure and DOM-free.
///
/// Everything here is a decision about *what the board is*, kept out of both
/// the component (which renders) and `api/board.ts` (which marshals), so the
/// two questions that actually have wrong answers — where does a card go, and
/// what does moving it cost — are testable in plain node.
///
/// Two properties are load-bearing and each is easy to lose:
///
///   * **A card is never dropped.** Column membership is a hand-editable
///     string in a file; a typo, a renamed column, or an agent inventing one
///     must not make work disappear. It lands in the first column instead.
///   * **A move rewrites one file.** Orders are floats and an insert is the
///     midpoint of its neighbours, so dragging a card does not renumber the
///     column it landed in. `planMove` returns the writes, and the normal case
///     is exactly one.

import type { BoardCard, BoardSnapshot } from "@/types/board";

/// One column, with the cards that claim it, in board order.
export interface BoardColumn {
  name: string;
  cards: BoardCard[];
}

/// What a move costs: one entry per card whose file has to be rewritten.
export interface CardMove {
  id: string;
  column: string;
  order: number;
}

/// The order given to the first card of an empty column, and the gap left
/// between cards when a whole column has to be renumbered. Whole numbers so a
/// file someone opens reads as a list rather than as arithmetic.
const ORDER_STEP = 1;

/// Sort key within a column: declared order, then id.
///
/// The id tiebreak is not cosmetic — it is the same tiebreak `board_list_cards`
/// applies in Rust, and it is what stops two cards handed the same `order` by
/// concurrent writers from swapping places on every refresh.
function byOrderThenId(a: BoardCard, b: BoardCard): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/// Group a snapshot's cards into its declared columns.
///
/// A card naming a column the board does not declare goes into the **first**
/// column rather than being dropped. Losing it would be the worst available
/// outcome: the file is still on disk, so the user sees work vanish from the
/// board while `git status` insists it is there.
export function groupIntoColumns(snapshot: BoardSnapshot): BoardColumn[] {
  const columns = snapshot.columns.length > 0 ? snapshot.columns : [""];
  const declared = new Set(columns);
  const buckets = new Map<string, BoardCard[]>(columns.map((name) => [name, []]));

  for (const card of snapshot.cards) {
    const name = declared.has(card.column) ? card.column : columns[0];
    buckets.get(name)!.push(card);
  }

  return columns.map((name) => ({
    name,
    cards: [...buckets.get(name)!].sort(byOrderThenId),
  }));
}

/// Whether a card is displayed somewhere other than where its frontmatter
/// says. True only for the fallback above, so the surface can mark it rather
/// than quietly showing the user a lie about their own file.
export function isMisfiled(card: BoardCard, snapshot: BoardSnapshot): boolean {
  return snapshot.columns.length > 0 && !snapshot.columns.includes(card.column);
}

/// The writes needed to put `cardId` at `toIndex` of `toColumn`.
///
/// `toIndex` is an index into the destination column **as it will read after
/// the move** — dropping onto the third slot of a column means `toIndex === 2`
/// whether or not the card was already in that column.
///
/// Returns `[]` when the card is unknown or already exactly there, so a drag
/// that ends where it started writes nothing.
export function planMove(
  columns: BoardColumn[],
  cardId: string,
  toColumn: string,
  toIndex: number,
): CardMove[] {
  const card = columns.flatMap((c) => c.cards).find((c) => c.id === cardId);
  if (!card) return [];

  const destination = columns.find((c) => c.name === toColumn);
  if (!destination) return [];

  // The destination as it stands with the card taken out of it — the list the
  // insertion point is measured against.
  const without = destination.cards.filter((c) => c.id !== cardId);
  const index = Math.max(0, Math.min(toIndex, without.length));

  if (card.column === toColumn && destination.cards[index]?.id === cardId) return [];

  const previous = without[index - 1];
  const next = without[index];

  const order =
    previous && next
      ? (previous.order + next.order) / 2
      : previous
        ? previous.order + ORDER_STEP
        : next
          ? next.order - ORDER_STEP
          : ORDER_STEP;

  // The midpoint has to actually be *between* the neighbours. It is not when
  // two cards already share an order (concurrent writers, or a hand-edited
  // file), and it stops being one at the far end of float precision after
  // enough inserts into the same gap. Renumbering the destination is the
  // escape hatch: more writes than a move should cost, but it is the only
  // outcome that leaves the column in the order the user asked for.
  if (previous && next && !(order > previous.order && order < next.order)) {
    const inserted = [...without.slice(0, index), card, ...without.slice(index)];
    return inserted.map((c, i) => ({
      id: c.id,
      column: toColumn,
      order: (i + 1) * ORDER_STEP,
    }));
  }

  return [{ id: card.id, column: toColumn, order }];
}

/// A card id from its title: a date prefix, a slug, and a numeric suffix when
/// that is already taken.
///
/// Adapted from `BrainSurface`'s note ids, and the same shape on purpose — the
/// two directories sit side by side under `.voidlink/`, and a file name that
/// sorts by date and reads as its title is why either is pleasant to open in an
/// editor.
export function mintCardId(title: string, createdISO: string, taken: Iterable<string>): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // A title of nothing but punctuation still has to produce a file name.
  const base = `${createdISO.slice(0, 10)}-${slug || "card"}`;

  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

/// Serialize a card back to the on-disk format.
///
/// Flat frontmatter, the same dialect `brain/mod.rs` parses and `board/mod.rs`
/// reuses: scalars and one flow array, nothing that needs a YAML engine on
/// either side. `labels` is omitted rather than written empty, so a card
/// nobody labelled has no line about labels — and `due` is omitted the same
/// way, which is what makes the field optional in both directions: a card with
/// no due date is byte-identical to one written before the field existed.
///
/// The Rust parser in `board/mod.rs` has to read back exactly what this emits.
/// `boardModel.test.ts` and that module's tests quote the same fixture for a
/// card with every field set, so neither side can drift alone.
export function buildCardMarkdown(card: {
  id: string;
  title: string;
  column: string;
  order: number;
  labels: string[];
  created: string;
  /// ISO `YYYY-MM-DD`, or absent. Empty and `null` mean the same thing the
  /// Rust parser makes them mean: no due date, and no line.
  due?: string | null;
  body: string;
}): string {
  const lines = [
    "---",
    `id: ${card.id}`,
    "type: card",
    `title: ${yamlQuote(card.title)}`,
    `column: ${yamlQuote(card.column)}`,
    `order: ${card.order}`,
  ];
  if (card.labels.length > 0) {
    lines.push(`labels: [${card.labels.map(yamlQuote).join(", ")}]`);
  }
  lines.push(`created: ${yamlQuote(card.created)}`);
  if (card.due) lines.push(`due: ${yamlQuote(card.due)}`);
  lines.push("---");
  return `${lines.join("\n")}\n${card.body}\n`;
}

/// What a card-face edit is allowed to change. Everything else about the file
/// — the body above all — comes from the card that was just re-read.
export type CardEdit = Partial<Pick<BoardCard, "title" | "column" | "order" | "labels" | "due">>;

/// Apply an edit to a freshly-read card, producing the file to write.
///
/// One function for every write the surface makes, so "what a card looks like
/// on disk after you touched one field" has a single definition and a single
/// test. The `card` argument is meant to be the result of a read that happened
/// *after* the user's gesture — see `BoardSurface`'s header on why.
export function editedCardMarkdown(card: BoardCard, body: string, edit: CardEdit): string {
  return buildCardMarkdown({
    id: card.id,
    title: edit.title ?? card.title,
    column: edit.column ?? card.column,
    order: edit.order ?? card.order,
    labels: edit.labels ?? card.labels,
    // A card written before `created` existed, or hand-edited without it,
    // keeps having none rather than acquiring today's date on a drag.
    created: card.created ?? "",
    // `undefined` means "not part of this edit"; `null` means "clear it".
    due: edit.due === undefined ? card.due : edit.due,
    body,
  });
}

/// Apply a move to a card. The move case of `editedCardMarkdown`, kept under
/// its own name because it is the one the drag path reads.
export function movedCardMarkdown(card: BoardCard, move: CardMove, body: string): string {
  return editedCardMarkdown(card, body, { column: move.column, order: move.order });
}

// ── Labels ──────────────────────────────────────────────────────────────────

/// How many chart tokens the label chips cycle through. `--chart-1` through
/// `--chart-5` are the palette the app already has; a label chip is not a
/// reason to introduce a sixth colour.
export const LABEL_TONE_COUNT = 5;

/// Which chart token a label wears, as `1..LABEL_TONE_COUNT`.
///
/// Derived from the string rather than stored per label, so the same label is
/// the same colour on every card, in every project, with nothing to keep in
/// sync — and so a label an agent invents in a file is coloured the moment it
/// appears rather than after somebody assigns it one.
export function labelTone(label: string): number {
  // FNV-1a, 32-bit, kept in integer range by `Math.imul`. Any stable hash
  // would do; this one is short and has no collisions worth caring about
  // across five buckets.
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (Math.abs(hash) % LABEL_TONE_COUNT) + 1;
}

/// Every label used anywhere on the board, deduplicated and sorted.
///
/// Sorted rather than in first-seen order: the filter bar is a list the user
/// scans, and a list that reorders itself whenever a card is written is a list
/// nobody can build a habit against.
export function boardLabels(snapshot: BoardSnapshot): string[] {
  return [...new Set(snapshot.cards.flatMap((c) => c.labels))].sort((a, b) => a.localeCompare(b));
}

/// Whether `card` survives a filter on `selected`.
///
/// Conjunctive: a card has to carry *every* selected label. Two labels
/// selected therefore narrows further rather than widening, which is what
/// "filter" means everywhere else in the app — and an empty selection is no
/// filter at all rather than a filter nothing passes.
export function matchesLabels(card: BoardCard, selected: readonly string[]): boolean {
  return selected.every((label) => card.labels.includes(label));
}

/// The snapshot as the filter leaves it. Purely client-side over what has
/// already been fetched: the board is a directory the app has read in full, so
/// asking Rust to filter it would be a round trip to answer a question the
/// frontend already holds the data for.
///
/// The declared columns survive the filter — a column emptied by a filter still
/// exists, and hiding it would make the board look like it lost a column.
export function filterByLabels(snapshot: BoardSnapshot, selected: readonly string[]): BoardSnapshot {
  if (selected.length === 0) return snapshot;
  return { columns: snapshot.columns, cards: snapshot.cards.filter((c) => matchesLabels(c, selected)) };
}

// ── Dates ───────────────────────────────────────────────────────────────────

/// The day part of a stamp, for display. `created` is a full ISO timestamp and
/// `due` is already a date; both answer here, and a card with neither answers
/// with the empty string rather than with "Invalid Date".
export function dayOf(stamp: string | null | undefined): string {
  return stamp ? stamp.slice(0, 10) : "";
}

/// Today, on the same `-03:00` wall clock the cards are stamped in. Sharing
/// the clock is what stops a card due today from reading as overdue for the
/// three hours either side of midnight UTC.
export function todayISO(now: number = Date.now()): string {
  return stampCreatedISO(now).slice(0, 10);
}

/// Whether a due date has already passed. Due *today* is not overdue — a
/// deadline is a day, not an instant, and marking it red at 00:00 on the day
/// it is due would cry wolf on every card the user is about to finish.
///
/// Lexicographic because both sides are zero-padded `YYYY-MM-DD`, which orders
/// identically to the dates they name and needs no `Date` to say so.
export function isOverdue(due: string | null | undefined, today: string = todayISO()): boolean {
  return !!due && dayOf(due) < today;
}

/// The `-03:00` wall clock the brain's entries are stamped in, so the two
/// directories sort together. Same function as `BrainSurface`'s
/// `stampCreatedISO`, which is not exported from a `.tsx` a node test can load.
export function stampCreatedISO(now: number = Date.now()): string {
  const OFFSET_MS = -3 * 60 * 60 * 1000;
  return new Date(now + OFFSET_MS).toISOString().replace(/Z$/, "-03:00");
}
