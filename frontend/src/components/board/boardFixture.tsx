/// The fake `.voidlink/board/` the board tests run against.
///
/// Shared by `BoardOverlay.test.tsx` (jsdom: what the surface renders and what
/// it writes) and `BoardOverlay.browser.test.tsx` (real geometry: the drag).
/// It lives in its own module because the drag had to move to the browser
/// project — the gesture resolves a drop position from
/// `getBoundingClientRect`, and jsdom returns a zero rect for every element,
/// so every drop in jsdom resolves to the same slot and the test could only
/// ever pass by accident.
///
/// Not named `*.test.tsx`: that glob is what the render project collects, and
/// a fixture is not a test.
import { render, screen } from "@solidjs/testing-library";
import { vi } from "vitest";
import { mockTauri } from "@/test/tauri";
import { BoardOverlay } from "./BoardOverlay";

export const REPO = "/repo";

export interface StoredCard {
  id: string;
  title: string;
  column: string;
  order: number;
  rev: number;
  body: string;
}

/// A stand-in for the directory, because the thing under test is a
/// read-modify-write against files. A fixed list of cards would let a drag
/// "pass" by rendering the same board it started with.
let disk: StoredCard[] = [];
export const boardDisk = () => disk;

export const asWire = (c: StoredCard) => ({
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
export function field(content: string, name: string): string {
  return content.match(new RegExp(`^${name}: "?(.*?)"?$`, "m"))?.[1] ?? "";
}

export function installBoard(cards: StoredCard[], columns = ["Todo", "Doing", "Done"]) {
  disk = cards;
  mockTauri({
    board_list_cards: () => ({ columns, cards: disk.map(asWire) }),
    board_read_card: (args: Record<string, unknown>) => {
      const card = disk.find((c) => c.id === args.cardId);
      if (!card) throw new Error(`no such card: ${String(args.cardId)}`);
      return { ...asWire(card), body: card.body };
    },
    board_save_card: (args: Record<string, unknown>) => {
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

export const THREE_CARDS: StoredCard[] = [
  { id: "a", title: "Wire the watcher", column: "Todo", order: 1, rev: 1, body: "why\n" },
  { id: "b", title: "Write the docs", column: "Todo", order: 2, rev: 1, body: "" },
  { id: "c", title: "Ship it", column: "Doing", order: 1, rev: 1, body: "" },
];

export const onClose = vi.fn(() => {});

export function mountBoard(repoPath = REPO, onOpenCard?: (path: string) => void) {
  onClose.mockClear();
  return render(() => (
    <BoardOverlay repoPath={repoPath} onClose={onClose} onOpenCard={onOpenCard} />
  ));
}

export const tile = (title: string) => screen.getByLabelText(title);
export const columnOf = (title: string) =>
  tile(title).closest("[data-board-column]")?.getAttribute("data-board-column");
export const columnBody = (name: string) =>
  document.querySelector(`[data-board-column="${name}"]`)!;
