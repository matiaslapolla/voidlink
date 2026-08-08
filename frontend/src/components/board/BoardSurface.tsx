/// The project board: columns of cards, each card a markdown file under
/// `<repoRoot>/.voidlink/board/`.
///
/// This component renders and gestures. Where a card belongs, what a move
/// costs, and how an id is minted all live in `boardModel.ts`, which is pure —
/// so the two questions with wrong answers are tested in plain node and this
/// file stays about pixels and pointers.
///
/// Three things here are load-bearing:
///
///   * **A move re-reads the card immediately before writing it.** Not to be
///     tidy: the file is the only state, and the window between "the board was
///     listed" and "this card is written" is long enough for an editor or an
///     agent to have retitled it. Re-reading collapses that window to the
///     round trip itself, and hands Rust the `rev` it will refuse a stale
///     write against — so the drag moves the card *and* keeps the other
///     writer's edit to the body.
///   * **The board refetches on `BOARD_CHANGED_EVENT`.** A card written by
///     anything other than this surface has to show up here without a manual
///     refresh, or the file-per-card design is a claim the UI contradicts.
///   * **Nothing here decides the destination index.** The drop target names
///     the card it lands in front of; `planMove` turns that into orders.

import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Plus } from "lucide-solid";
import { boardApi, isBoardConflict, onBoardChanged } from "@/api/board";
import type { BoardCard, BoardSnapshot } from "@/types/board";
import { pushToast } from "@/commands/toast";
import { EmptyState, EmptyStateAction } from "@/components/layout/EmptyState";
import { ContextMenu, type ContextMenuItem } from "@/components/git/ContextMenu";
import {
  activeDrag,
  beginDrag,
  insertionIndex,
  registerDropZone,
  type Point,
} from "@/components/layout/dragDrop";
import {
  buildCardMarkdown,
  groupIntoColumns,
  isMisfiled,
  mintCardId,
  movedCardMarkdown,
  planMove,
  stampCreatedISO,
  type CardMove,
} from "./boardModel";

const EMPTY_BOARD: BoardSnapshot = { columns: [], cards: [] };

interface BoardSurfaceProps {
  /// The repository root of the open project. Its board lives under
  /// `.voidlink/board`; empty means no repo is open, which is the one state
  /// this surface cannot do anything useful in.
  repoPath: string;
  /// Open a card's markdown file in the editor window. Absent means the
  /// caller has no editor to open one in (there isn't one today — every real
  /// caller passes it, via `openEditorTab`); optional only so a caller with
  /// no editor is not forced to invent a no-op.
  onOpenCard?: (repoRelativePath: string) => void;
}

export function BoardSurface(props: BoardSurfaceProps) {
  const [snapshot, { refetch }] = createResource(
    () => props.repoPath,
    async (repoPath): Promise<BoardSnapshot> =>
      repoPath ? await boardApi.listCards(repoPath) : EMPTY_BOARD,
  );

  // External edits. Registered eagerly rather than in `onMount` so the
  // subscription exists for a surface that is measured before it is mounted;
  // the `disposed` latch is what covers the listener resolving after cleanup.
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  void onBoardChanged((repoRoot) => {
    if (repoRoot === props.repoPath) void refetch();
  }).then((fn) => {
    if (disposed) void fn();
    else unlisten = fn;
  });
  onCleanup(() => {
    disposed = true;
    if (unlisten) void unlisten();
  });

  const board = () => snapshot() ?? EMPTY_BOARD;
  const columns = createMemo(() => groupIntoColumns(board()));
  const isEmpty = () => !snapshot.loading && board().cards.length === 0;

  const [dragging, setDragging] = createSignal<string | null>(null);
  /// The column a dragged card is currently over, for the drop affordance.
  /// Column-level rather than card-level: a 2px caret on a 24px-tall card is
  /// hard to aim at, and the column is the destination that actually matters.
  const [dropColumn, setDropColumn] = createSignal<string | null>(null);
  const [composing, setComposing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  // ── Context menus (Stream D) ────────────────────────────────────────────
  // Empty board space: "New card", the same flow the header's own "+ New
  // card" button starts — both just show the composer, so there is nothing
  // here to duplicate. Per-card: "Open card in editor", via `onOpenCard`.
  // "Delete card" is deliberately absent: `boardApi` has no delete command —
  // list/read/save only — and inventing one is a new backend action, out of
  // scope for a stream that surfaces existing actions rather than adding
  // them. See the stream's final report for the full reasoning.
  const [emptyMenu, setEmptyMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [cardMenu, setCardMenu] = createSignal<{ x: number; y: number; card: BoardCard } | null>(
    null,
  );

  function resetDrag() {
    setDragging(null);
    setDropColumn(null);
  }

  // ── Dragging a card ───────────────────────────────────────────────────────
  // Pointer events, through the shared controller — see `dragDrop.ts` for why
  // HTML5 drag-and-drop cannot work inside this window at all.
  //
  // One zone per *column*, and the position within it is resolved from the
  // cards the column already laid out. The card tiles themselves are grips and
  // nothing else, which is what stops a drag from somewhere else in the app
  // from lighting one up.

  const columnEls = new Map<string, HTMLElement>();
  function registerColumn(name: string, el: HTMLElement) {
    columnEls.set(name, el);
    onCleanup(() => columnEls.delete(name));
  }

  /// The card the pointer would drop in front of, or `null` for the end of the
  /// column. Measured off the tiles rather than computed from `columns()`, so a
  /// scrolled column answers about what the user can actually see.
  function cardBefore(columnName: string, at: Point): string | null {
    const host = columnEls.get(columnName);
    if (!host) return null;
    const tiles = [...host.querySelectorAll<HTMLElement>("[data-card-id]")].filter(
      (el) => el.dataset.cardId !== dragging(),
    );
    const i = insertionIndex(
      tiles.map((el) => el.getBoundingClientRect()),
      at,
      "y",
    );
    return tiles[i]?.dataset.cardId ?? null;
  }

  function startCardDrag(e: PointerEvent, card: BoardCard) {
    if (busy()) return;
    setDragging(card.id);
    beginDrag(e, { kind: "card", id: card.id, label: card.title });
  }

  /// The gesture ended — dropped, cancelled with `Escape`, or abandoned below
  /// the drag threshold. Either way the tile stops being dimmed and no column
  /// stays highlighted. Watching the controller rather than each exit is what
  /// makes "no stale affordance" true by construction.
  createEffect(() => {
    if (!activeDrag() && dragging()) resetDrag();
  });

  // Registered once per column name the board has ever shown this session;
  // `registerColumn`'s cleanup is what keeps a renamed column from lingering.
  createEffect(() => {
    for (const column of columns()) {
      const name = column.name;
      registerDropZone({
        id: `board-column:${name}`,
        el: () => columnEls.get(name),
        accepts: (p) => p.kind === "card",
        over: (_p, at) => {
          setDropColumn(name);
          const before = cardBefore(name, at);
          return before ? `Move into ${name}` : `Move to the end of ${name}`;
        },
        leave: () => setDropColumn(null),
        drop: (p, at) => dropInto(name, cardBefore(name, at), p.id),
      });
    }
  });

  /// Write a plan. Sequential rather than concurrent: the normal plan is one
  /// write, and the renumbering plan touches cards that are about to be sorted
  /// against each other — a partial application of it in a racing order would
  /// leave the column somewhere nobody asked for.
  async function applyMoves(moves: CardMove[]) {
    if (moves.length === 0) return;
    setBusy(true);
    try {
      for (const move of moves) {
        const card = board().cards.find((c) => c.id === move.id);
        if (!card) continue;
        try {
          const fresh = await boardApi.readCard(props.repoPath, card.id);
          await boardApi.saveCard(
            props.repoPath,
            card.id,
            movedCardMarkdown(fresh, move, fresh.body),
            fresh.rev,
          );
        } catch (error) {
          // Both branches stop the plan. A conflict means the board on screen
          // is stale, and applying the rest of a plan computed against a stale
          // board is how one refused write becomes a scrambled column.
          pushToast(
            isBoardConflict(error)
              ? `“${card.title}” changed on disk — the board has been reloaded.`
              : `Could not move “${card.title}”: ${String(error)}`,
            "error",
          );
          break;
        }
      }
    } finally {
      setBusy(false);
      void refetch();
    }
  }

  /// Drop `id` into `columnName`, in front of `beforeId` (or at the end when
  /// that is `null`).
  function dropInto(columnName: string, beforeId: string | null, id: string) {
    resetDrag();

    const destination = columns().find((c) => c.name === columnName);
    if (!destination) return;
    // Measured against the column *without* the card being dragged, which is
    // the list `planMove` inserts into.
    const without = destination.cards.filter((c) => c.id !== id);
    const index = beforeId
      ? Math.max(0, without.findIndex((c) => c.id === beforeId))
      : without.length;

    void applyMoves(planMove(columns(), id, columnName, index));
  }

  async function createCard(title: string) {
    const created = stampCreatedISO();
    const id = mintCardId(
      title,
      created,
      board().cards.map((c) => c.id),
    );
    const first = columns()[0];
    const order = (first?.cards.at(-1)?.order ?? 0) + 1;
    try {
      await boardApi.saveCard(
        props.repoPath,
        id,
        buildCardMarkdown({
          id,
          title,
          column: first?.name ?? "Todo",
          order,
          labels: [],
          created,
          body: "",
        }),
        // A card nobody has written yet. Rust refuses this if the id is
        // already on disk, which is the case a slug collision produces.
        null,
      );
      setComposing(false);
      void refetch();
    } catch (error) {
      pushToast(`Could not create the card: ${String(error)}`, "error");
    }
  }

  return (
    <Show
      when={props.repoPath}
      fallback={
        <div class="h-full flex items-center justify-center text-title text-muted-foreground">
          Open a repository to see its board.
        </div>
      }
    >
      <div class="h-full flex flex-col">
        <div class="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0">
          <span class="text-label text-muted-foreground">
            {board().cards.length} card{board().cards.length === 1 ? "" : "s"} in{" "}
            <span class="font-mono">.voidlink/board/</span>
          </span>
          <div class="flex-1" />
          <button
            type="button"
            onClick={() => setComposing(true)}
            class="flex items-center gap-1 px-2 py-0.5 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
          >
            <Plus class="w-3 h-3" /> New card
          </button>
        </div>

        <Show when={composing()}>
          <NewCardForm onCancel={() => setComposing(false)} onCreate={(t) => void createCard(t)} />
        </Show>

        <Show
          when={!isEmpty() || composing()}
          fallback={
            <EmptyState
              id="boardEmpty"
              size="pane"
              class="flex-1"
              action={
                // Not "New card": that is the header button's label, and two
                // controls with one name is what a screen reader — and a
                // render test — has no way to tell apart.
                <EmptyStateAction onClick={() => setComposing(true)}>
                  Add the first card
                </EmptyStateAction>
              }
            />
          }
        >
          <div
            class="flex-1 min-h-0 flex gap-2 p-2 overflow-x-auto scrollbar-thin"
            onContextMenu={(e) => {
              // Only genuinely empty space: a column or a card's own handler
              // (below) stops propagation before this can fire.
              e.preventDefault();
              setEmptyMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <For each={columns()}>
              {(column) => (
                <div
                  data-board-column={column.name}
                  ref={(el) => registerColumn(column.name, el)}
                  class="w-[260px] shrink-0 flex flex-col rounded-[var(--island-radius-inner)] border bg-card/40 transition-colors"
                  classList={{
                    "border-primary/60": dropColumn() === column.name,
                    "border-border/60": dropColumn() !== column.name,
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setEmptyMenu({ x: e.clientX, y: e.clientY });
                  }}
                >
                  <div class="flex items-center gap-1.5 px-2 py-1 border-b border-border/50 shrink-0">
                    <span class="text-label font-medium truncate">{column.name}</span>
                    <span class="text-micro font-mono tabular-nums text-muted-foreground">
                      {column.cards.length}
                    </span>
                  </div>
                  <div class="flex-1 min-h-0 overflow-y-auto scrollbar-thin p-1 space-y-1">
                    <For each={column.cards}>
                      {(card) => (
                        <CardTile
                          card={card}
                          misfiled={isMisfiled(card, board())}
                          dragging={dragging() === card.id}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            // No `onOpenCard` means no row this menu could
                            // show — right-click does nothing, per the
                            // stream's own "no menu worth showing" rule,
                            // rather than opening an empty popover.
                            if (props.onOpenCard) setCardMenu({ x: e.clientX, y: e.clientY, card });
                          }}
                          disabled={busy()}
                          onGrab={(e) => startCardDrag(e, card)}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={emptyMenu()}>
          {(m) => (
            <ContextMenu
              x={m().x}
              y={m().y}
              items={[{ label: "New card", onSelect: () => setComposing(true) }]}
              onClose={() => setEmptyMenu(null)}
            />
          )}
        </Show>
        <Show when={cardMenu()}>
          {(m) => (
            <ContextMenu
              x={m().x}
              y={m().y}
              items={cardMenuItems(m().card)}
              onClose={() => setCardMenu(null)}
            />
          )}
        </Show>
      </div>
    </Show>
  );

  /// The one row this menu has to offer today. `onOpenCard` is what
  /// `openEditorTab` becomes at the call site (`App.tsx`) — the same
  /// mechanism `PanelApp`'s file tree and `GitSidebar`'s diff rows already use
  /// to put a file in the editor window from a window that isn't it.
  function cardMenuItems(card: BoardCard): ContextMenuItem[] {
    if (!props.onOpenCard) return [];
    const path = card.path;
    return [{ label: "Open card in editor", onSelect: () => props.onOpenCard?.(path) }];
  }
}

/// One card. A `div` rather than a `button` because it is a drag handle first;
/// the whole tile is the grip, which is the only affordance the surface has.
///
/// It is not a drop *target*: the column is, and it resolves the position from
/// where the pointer is among the cards it already laid out. A card-sized
/// target is hard to aim at and was the reason a foreign drag could light one
/// up — there is nothing left here for a drag from elsewhere to land on.
function CardTile(props: {
  card: BoardCard;
  misfiled: boolean;
  dragging: boolean;
  disabled: boolean;
  onGrab: (e: PointerEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <div
      data-card-id={props.card.id}
      aria-label={props.card.title}
      onPointerDown={(e) => {
        if (!props.disabled) props.onGrab(e);
      }}
      onContextMenu={props.onContextMenu}
      class="rounded border border-border/70 bg-background px-2 py-1.5 cursor-grab select-none hover:border-border transition-colors"
      classList={{ "opacity-50": props.dragging }}
    >
      <div class="text-body truncate">{props.card.title}</div>
      <div class="mt-0.5 flex flex-wrap items-center gap-1">
        <For each={props.card.labels}>
          {(label) => (
            <span class="px-1 rounded bg-muted/60 text-micro text-muted-foreground">{label}</span>
          )}
        </For>
        {/* The card's file says one column and the board shows another. Said
            out loud rather than absorbed: the fix is a one-word edit in a file
            the user can open, and a board that silently relocated it would
            hide that. */}
        <Show when={props.misfiled}>
          <span class="text-micro text-warning" title={`Its file says column: ${props.card.column}`}>
            column “{props.card.column}” is not declared
          </span>
        </Show>
      </div>
    </div>
  );
}

function NewCardForm(props: { onCreate: (title: string) => void; onCancel: () => void }) {
  const [title, setTitle] = createSignal("");
  const submit = () => {
    const t = title().trim();
    if (!t) return;
    props.onCreate(t);
  };
  return (
    <div class="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0">
      <input
        type="text"
        autofocus
        value={title()}
        onInput={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") props.onCancel();
        }}
        placeholder="Card title"
        class="flex-1 rounded border border-border bg-muted/40 px-2 py-1 text-body focus:outline-none focus:ring-1 focus:ring-ring"
      />
      <button
        type="button"
        onClick={submit}
        class="px-2 py-1 rounded bg-primary text-primary-foreground text-label hover:bg-primary/90"
      >
        Add
      </button>
      <button
        type="button"
        onClick={props.onCancel}
        class="px-2 py-1 rounded text-label text-muted-foreground hover:text-foreground hover:bg-accent/40"
      >
        Cancel
      </button>
    </div>
  );
}
