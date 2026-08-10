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
///   * **A card-face edit is the same write as a move.** Renaming a card,
///     adding a label and setting a due date all go through `editCard`, which
///     re-reads before writing for the reason above — the body it hands back
///     to Rust is the body it just read, so an edit made in the card's editor
///     tab survives a rename made on the board a second later.
///
/// **The body is not edited here.** A card is a markdown file and VoidLink has
/// an editor; double-click, `Enter` and the context menu open the file as an
/// ordinary tab. A textarea in this component would be a second editor with no
/// LSP, no preview and no diff, and it would never catch up.

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
import { Plus, X } from "lucide-solid";
import { boardApi, isBoardConflict, onBoardChanged } from "@/api/board";
import type { BoardCard, BoardSnapshot } from "@/types/board";
import { pushToast } from "@/commands/toast";
import { EmptyState, EmptyStateAction } from "@/components/layout/EmptyState";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { cn } from "@/components/ui/cn";
import {
  activeDrag,
  beginDrag,
  insertionIndex,
  registerDropZone,
  type Point,
} from "@/components/layout/dragDrop";
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
  mintCardId,
  movedCardMarkdown,
  planMove,
  stampCreatedISO,
  todayISO,
  type CardEdit,
  type CardMove,
} from "./boardModel";

const EMPTY_BOARD: BoardSnapshot = { columns: [], cards: [] };

/// Where the board sits inside a repository. Duplicated from `BOARD_DIR` in
/// `board/mod.rs` because the path a card's editor tab opens is assembled here
/// and nothing crosses the IPC boundary carrying it — `BoardCard.path` is
/// board-relative on purpose.
const BOARD_DIR = ".voidlink/board";

/// A label's chip dot, by the tone `labelTone` assigns it. Written out rather
/// than interpolated because Tailwind only emits classes it can see (the same
/// reason `TabStrip`'s `GROUP_DOT` is a literal map).
const LABEL_DOT: Record<number, string> = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
};

/// Which field of a card the user is editing on its face, if any. One at a
/// time and one card at a time: these are all inline inputs on a 260px tile,
/// and two of them open at once is a tile that has to grow.
type EditField = "title" | "label" | "due";
interface CardEditing {
  id: string;
  field: EditField;
}

interface BoardSurfaceProps {
  /// The repository root of the open project. Its board lives under
  /// `.voidlink/board`; empty means no repo is open, which is the one state
  /// this surface cannot do anything useful in.
  repoPath: string;
  /// Open a card's markdown file, by absolute path, as an ordinary editor tab.
  ///
  /// A callback rather than a call into the layout store because the board is
  /// an overlay over the workbench and the workbench owns "open a file" —
  /// `App.tsx` funnels the file finder, the tree and a terminal deep-link
  /// through one function, and a card is not a new kind of open. Optional so
  /// the surface renders in a test with no workbench around it.
  onOpenCard?: (absolutePath: string) => void;
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
  const isEmpty = () => !snapshot.loading && board().cards.length === 0;

  /// Labels the user has narrowed the board to. Client-side over the snapshot
  /// already in hand — see `filterByLabels`.
  const [filter, setFilter] = createSignal<string[]>([]);
  const labels = createMemo(() => boardLabels(board()));
  const visible = createMemo(() => filterByLabels(board(), filter()));
  const columns = createMemo(() => groupIntoColumns(visible()));

  /// The board as it stands with nothing hidden. What a move is planned
  /// against: `planMove` computes an order from a card's neighbours, and the
  /// neighbours of a filtered column are not the neighbours in the file.
  const allColumns = createMemo(() => groupIntoColumns(board()));

  // A filter the user cannot see is a board that looks broken. Dropped when
  // the last card carrying a selected label goes away, so a filter can never
  // outlive the label it names.
  createEffect(() => {
    const known = new Set(labels());
    const kept = filter().filter((l) => known.has(l));
    if (kept.length !== filter().length) setFilter(kept);
  });

  const [dragging, setDragging] = createSignal<string | null>(null);
  /// The column a dragged card is currently over, for the drop affordance.
  /// Column-level rather than card-level: a 2px caret on a 24px-tall card is
  /// hard to aim at, and the column is the destination that actually matters.
  const [dropColumn, setDropColumn] = createSignal<string | null>(null);
  const [composing, setComposing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<CardEditing | null>(null);
  const [menu, setMenu] = createSignal<{
    card: BoardCard;
    x: number;
    y: number;
    returnTo: HTMLElement | null;
  } | null>(null);
  /// The menu for board space that is not a card — a column's empty area, or
  /// the strip beside the last column. It offers the one thing there is to do
  /// there, which is the composer the header's own "+ New card" opens.
  ///
  /// "Delete card" is deliberately absent from *both* menus: `boardApi` has
  /// list / read / save and no delete, and inventing a backend command is a
  /// new action rather than a new way to reach one.
  const [spaceMenu, setSpaceMenu] = createSignal<{ x: number; y: number } | null>(null);

  /// Today, read at render rather than captured at module load — a board left
  /// open across midnight re-reads it on its next refetch, and the board
  /// refetches on every external write.
  const today = () => todayISO();

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
  /// `beforeId` is the card the pointer was in front of *among the tiles the
  /// user can see*, which under a label filter is not the column on disk. It
  /// is resolved against the unfiltered column here so "put it just above that
  /// card" means the same thing either way, and `planMove` gets the real
  /// neighbours to take a midpoint between.
  function dropInto(columnName: string, beforeId: string | null, id: string) {
    resetDrag();

    const destination = allColumns().find((c) => c.name === columnName);
    if (!destination) return;
    // Measured against the column *without* the card being dragged, which is
    // the list `planMove` inserts into.
    const without = destination.cards.filter((c) => c.id !== id);
    const found = beforeId ? without.findIndex((c) => c.id === beforeId) : -1;
    const index = found === -1 ? without.length : found;

    void applyMoves(planMove(allColumns(), id, columnName, index));
  }

  // ── Editing a card's face ─────────────────────────────────────────────────
  // The body is not one of these: it opens in the editor. What is left is what
  // belongs on a card face, and each one is the same rev-checked write.

  /// Open a card's markdown as an ordinary editor tab.
  function openCard(card: BoardCard) {
    props.onOpenCard?.(`${props.repoPath}/${BOARD_DIR}/${card.path}`);
  }

  /// Apply a card-face edit: re-read, rewrite, refetch.
  ///
  /// The re-read is the whole point and is not an optimisation to drop — the
  /// user may have retitled this card on the board while its body was being
  /// edited in the tab the surface just opened, and `fresh.body` is how that
  /// body survives being written over by a rename.
  async function editCard(card: BoardCard, edit: CardEdit) {
    setBusy(true);
    try {
      const fresh = await boardApi.readCard(props.repoPath, card.id);
      await boardApi.saveCard(
        props.repoPath,
        card.id,
        editedCardMarkdown(fresh, fresh.body, edit),
        fresh.rev,
      );
    } catch (error) {
      // Never retried silently. A conflict means somebody else's version of
      // this card is on disk, and re-applying the edit on top of it would
      // discard a change the user never saw.
      pushToast(
        isBoardConflict(error)
          ? `“${card.title}” changed on disk — your edit was not applied, and the board has been reloaded.`
          : `Could not save “${card.title}”: ${String(error)}`,
        "error",
      );
    } finally {
      setBusy(false);
      void refetch();
    }
  }

  function commitEdit(card: BoardCard, field: EditField, value: string) {
    setEditing(null);
    const trimmed = value.trim();
    switch (field) {
      case "title":
        // An empty title would leave a card showing its own file name. Nothing
        // to apply is not an error — the edit is simply abandoned.
        if (!trimmed || trimmed === card.title) return;
        void editCard(card, { title: trimmed });
        return;
      case "label":
        if (!trimmed || card.labels.includes(trimmed)) return;
        void editCard(card, { labels: [...card.labels, trimmed] });
        return;
      case "due":
        if (dayOf(card.due) === trimmed) return;
        void editCard(card, { due: trimmed || null });
        return;
    }
  }

  function cardMenuItems(card: BoardCard): MenuItem[] {
    return [
      { label: "Open in editor", onSelect: () => openCard(card) },
      {
        label: "Rename",
        separatorBefore: true,
        onSelect: () => setEditing({ id: card.id, field: "title" }),
      },
      { label: "Add label", onSelect: () => setEditing({ id: card.id, field: "label" }) },
      {
        label: card.due ? "Change due date" : "Set due date",
        onSelect: () => setEditing({ id: card.id, field: "due" }),
      },
      {
        label: "Clear due date",
        disabledReason: card.due ? undefined : "This card has no due date",
        onSelect: () => void editCard(card, { due: null }),
      },
    ];
  }

  function toggleFilter(label: string) {
    setFilter((current) =>
      current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
    );
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
          <span class="text-label text-muted-foreground shrink-0">
            {/* Under a filter this says both numbers. A bare "2 cards" next to
                a board that holds five is the surface telling the user their
                files went missing. */}
            <Show
              when={filter().length > 0}
              fallback={
                <>
                  {board().cards.length} card{board().cards.length === 1 ? "" : "s"} in{" "}
                  <span class="font-mono">{BOARD_DIR}/</span>
                </>
              }
            >
              {visible().cards.length} of {board().cards.length} cards
            </Show>
          </span>
          <Show when={labels().length > 0}>
            <div
              role="group"
              aria-label="Filter by label"
              class="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto scrollbar-thin"
            >
              <For each={labels()}>
                {(label) => (
                  <button
                    type="button"
                    aria-pressed={filter().includes(label)}
                    // Named for what pressing it does, not just for the label,
                    // because the visible text is one word and `aria-pressed`
                    // alone does not say what is being pressed. The visible
                    // text is inside the name, which is what WCAG 2.5.3 asks.
                    aria-label={
                      filter().includes(label)
                        ? `Stop filtering by ${label}`
                        : `Show only cards labelled ${label}`
                    }
                    title={
                      filter().includes(label)
                        ? `Stop filtering by ${label}`
                        : `Show only cards labelled ${label}`
                    }
                    onClick={() => toggleFilter(label)}
                    // `border-width` is constant across every state (§7.6); the
                    // pressed state moves border-colour and background only, so
                    // filtering cannot reflow the header.
                    class="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded border text-micro transition-colors"
                    classList={{
                      "border-primary/60 bg-primary/10 text-foreground": filter().includes(label),
                      "border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/40":
                        !filter().includes(label),
                    }}
                  >
                    <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${LABEL_DOT[labelTone(label)]}`} />
                    {label}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="flex-1" />
          <button
            type="button"
            onClick={() => setComposing(true)}
            class="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border border-border text-label text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
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
            /* Only genuinely empty space reaches this: a column and a card
               each stop propagation before it fires. */
            onContextMenu={(e) => {
              e.preventDefault();
              setSpaceMenu({ x: e.clientX, y: e.clientY });
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
                    setSpaceMenu({ x: e.clientX, y: e.clientY });
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
                          disabled={busy()}
                          overdue={isOverdue(card.due, today())}
                          editing={editing()?.id === card.id ? (editing()?.field ?? null) : null}
                          onGrab={(e) => startCardDrag(e, card)}
                          onOpen={() => openCard(card)}
                          onStartEdit={(field) => setEditing({ id: card.id, field })}
                          onCancelEdit={() => setEditing(null)}
                          onCommitEdit={(field, value) => commitEdit(card, field, value)}
                          onRemoveLabel={(label) =>
                            void editCard(card, {
                              labels: card.labels.filter((l) => l !== label),
                            })
                          }
                          onContextMenu={(e, el) => {
                            e.preventDefault();
                            // A card's menu is the card's; without this the
                            // column underneath opens its own as well.
                            e.stopPropagation();
                            setMenu({ card, x: e.clientX, y: e.clientY, returnTo: el });
                          }}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* `keyed`, so the child sees the value rather than an accessor: the
            first thing a chosen row does is close the menu, and an accessor
            read after that is a read of a `<Show>` that has already gone. */}
        <Show when={menu()} keyed>
          {(m) => (
            <Menu
              x={m.x}
              y={m.y}
              items={cardMenuItems(m.card)}
              label={`Card: ${m.card.title}`}
              returnFocusTo={m.returnTo}
              onClose={() => setMenu(null)}
            />
          )}
        </Show>
        <Show when={spaceMenu()} keyed>
          {(m) => (
            <Menu
              x={m.x}
              y={m.y}
              items={[{ label: "New card", onSelect: () => setComposing(true) }]}
              label="Board"
              onClose={() => setSpaceMenu(null)}
            />
          )}
        </Show>
      </div>
    </Show>
  );
}

/// One card. A `div` rather than a `button` because it is a drag handle first;
/// the whole tile is the grip, which is the only affordance the surface has.
/// It carries `role="button"` and a tab stop instead, so the keyboard gets what
/// the pointer has (§10.2) — `Enter` and `Space` open the card, `F2` renames
/// it, matching the tab strip's group chip rather than inventing a contract.
///
/// It is not a drop *target*: the column is, and it resolves the position from
/// where the pointer is among the cards it already laid out. A card-sized
/// target is hard to aim at and was the reason a foreign drag could light one
/// up — there is nothing left here for a drag from elsewhere to land on.
///
/// **Its two rows have fixed heights.** A card that gains a label, loses one,
/// or swaps a field for an inline input must not move the cards below it
/// (§7.6): a board is a list people aim at, and a tile that grows under the
/// pointer moves every drop target beneath it. So the meta row is one line
/// that clips rather than wraps, and the title row is one line either way.
function CardTile(props: {
  card: BoardCard;
  misfiled: boolean;
  dragging: boolean;
  disabled: boolean;
  overdue: boolean;
  /// Which field is being edited inline on this card, or `null`.
  editing: EditField | null;
  onGrab: (e: PointerEvent) => void;
  onOpen: () => void;
  onStartEdit: (field: EditField) => void;
  onCancelEdit: () => void;
  onCommitEdit: (field: EditField, value: string) => void;
  onRemoveLabel: (label: string) => void;
  onContextMenu: (e: MouseEvent, tile: HTMLElement | null) => void;
}) {
  let tile: HTMLDivElement | undefined;

  /// Focus goes back to the tile when an inline input closes, for the same
  /// reason the group chip's rename does it: an input that unmounts with focus
  /// inside it drops the keyboard onto `<body>`.
  const returnFocus = () => queueMicrotask(() => tile?.focus());

  return (
    <div
      ref={tile}
      data-card-id={props.card.id}
      aria-label={props.card.title}
      // A tile with an input open is a text field, not a control and not a
      // grip — same fork `TabGroupChip` takes while renaming.
      role={props.editing ? undefined : "button"}
      tabIndex={props.editing ? undefined : 0}
      onPointerDown={(e) => {
        // Everything inside a `data-no-drag` island is a control the user is
        // aiming at, not a place to grab the card by.
        if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
        if (!props.disabled) props.onGrab(e);
      }}
      onDblClick={(e) => {
        if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
        props.onOpen();
      }}
      onContextMenu={(e) => props.onContextMenu(e, tile ?? null)}
      onKeyDown={(e) => {
        // Only the tile's own keys. An inline input's `Enter` is its own.
        if (e.target !== e.currentTarget) return;
        if (e.key === "F2") {
          e.preventDefault();
          props.onStartEdit("title");
          return;
        }
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        props.onOpen();
      }}
      class="rounded border border-border/70 bg-background px-2 py-1.5 cursor-grab select-none hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
      classList={{ "opacity-50": props.dragging }}
    >
      <div class="h-5 flex items-center">
        <Show
          when={props.editing === "title"}
          fallback={<div class="flex-1 min-w-0 text-body truncate">{props.card.title}</div>}
        >
          <InlineInput
            value={props.card.title}
            ariaLabel={`Rename ${props.card.title}`}
            class="flex-1 h-5 text-body"
            onCommit={(v) => {
              props.onCommitEdit("title", v);
              returnFocus();
            }}
            onCancel={() => {
              props.onCancelEdit();
              returnFocus();
            }}
          />
        </Show>
      </div>

      {/* One line, clipped rather than wrapped — see the header note. */}
      <div class="mt-0.5 h-4 flex items-center gap-1 overflow-hidden">
        <Show when={props.editing === "label"}>
          <InlineInput
            value=""
            placeholder="Label"
            ariaLabel={`Add a label to ${props.card.title}`}
            class="flex-1 h-4 text-micro"
            onCommit={(v) => {
              props.onCommitEdit("label", v);
              returnFocus();
            }}
            onCancel={() => {
              props.onCancelEdit();
              returnFocus();
            }}
          />
        </Show>
        <Show when={props.editing === "due"}>
          <InlineInput
            type="date"
            value={dayOf(props.card.due)}
            ariaLabel={`Due date for ${props.card.title}`}
            class="flex-1 h-4 text-micro"
            onCommit={(v) => {
              props.onCommitEdit("due", v);
              returnFocus();
            }}
            onCancel={() => {
              props.onCancelEdit();
              returnFocus();
            }}
          />
        </Show>

        <Show when={!props.editing}>
          <div class="flex items-center gap-1 min-w-0 overflow-hidden">
            <For each={props.card.labels}>
              {(label) => (
                <span
                  data-no-drag
                  class="shrink-0 inline-flex items-center gap-1 h-3.5 pl-1 pr-0.5 rounded bg-muted/60 max-w-[96px]"
                >
                  {/* The dot carries the colour and the text carries the name.
                      Colour is never the only channel (§10.12), and the label
                      stays foreground-on-muted rather than tinted text on a
                      tinted chip, which is the pair §10.13 calls borderline. */}
                  <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${LABEL_DOT[labelTone(label)]}`} />
                  <span class="text-micro truncate">{label}</span>
                  <button
                    type="button"
                    aria-label={`Remove label ${label} from ${props.card.title}`}
                    title={`Remove label ${label}`}
                    onClick={() => props.onRemoveLabel(label)}
                    class="shrink-0 rounded opacity-60 hover:opacity-100 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity"
                  >
                    <X class="w-3 h-3" />
                  </button>
                </span>
              )}
            </For>
            <button
              data-no-drag
              type="button"
              aria-label={`Add a label to ${props.card.title}`}
              title="Add a label"
              onClick={() => props.onStartEdit("label")}
              class="shrink-0 rounded text-muted-foreground opacity-60 hover:opacity-100 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity"
            >
              <Plus class="w-3 h-3" />
            </button>
          </div>

          {/* The card's file says one column and the board shows another. Said
              out loud rather than absorbed: the fix is a one-word edit in a file
              the user can open, and a board that silently relocated it would
              hide that. */}
          <Show when={props.misfiled}>
            <span
              class="min-w-0 truncate text-micro text-warning"
              title={`Its file says column: ${props.card.column}`}
            >
              column “{props.card.column}” is not declared
            </span>
          </Show>

          <div class="flex-1" />

          <Show when={props.card.due}>
            {(due) => (
              <button
                data-no-drag
                type="button"
                onClick={() => props.onStartEdit("due")}
                // Overdue is `--warning`, plus the word "overdue" in the
                // tooltip — the colour is never the only thing that says it.
                title={
                  props.overdue
                    ? `Overdue — was due ${dayOf(due())}`
                    : `Due ${dayOf(due())} — click to change`
                }
                class="shrink-0 rounded px-0.5 text-micro font-mono tabular-nums hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                classList={{
                  "text-warning": props.overdue,
                  "text-muted-foreground": !props.overdue,
                }}
              >
                {props.overdue ? "! " : ""}
                {dayOf(due())}
              </button>
            )}
          </Show>

          <Show when={props.card.created}>
            {(created) => (
              <span
                class="shrink-0 text-micro font-mono tabular-nums text-muted-foreground/70"
                title={`Created ${created()}`}
              >
                {dayOf(created())}
              </span>
            )}
          </Show>
        </Show>
      </div>
    </div>
  );
}

/// The inline editor the card face swaps in for one of its own fields.
///
/// Same keyboard contract as the tab strip's group rename, deliberately: Enter
/// commits, Escape abandons, blur commits. Three call sites here and one there
/// is already one copy too many to let drift.
function InlineInput(props: {
  value: string;
  type?: "text" | "date";
  placeholder?: string;
  ariaLabel: string;
  class?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  let input: HTMLInputElement | undefined;
  /// Escape has to be able to beat the blur that follows it. Without the
  /// latch, cancelling with the keyboard would commit on the way out.
  let cancelled = false;

  queueMicrotask(() => {
    input?.focus();
    input?.select();
  });

  return (
    <input
      data-no-drag
      ref={input}
      type={props.type ?? "text"}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onPointerDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (!cancelled) props.onCommit(input?.value ?? "");
      }}
      onKeyDown={(e) => {
        // The overlay closes on Escape and the surface opens a card on Enter.
        // Neither belongs to a field the user is typing in.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          props.onCommit(input?.value ?? "");
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          props.onCancel();
        }
      }}
      // No size here: `cn` does not merge, so a caller's `text-body` would not
      // reliably beat a `text-micro` set on this line. The row that hosts the
      // input owns its height and its type size, which is also the only way
      // the swap can be guaranteed not to change the row's height.
      class={cn(
        "min-w-0 rounded bg-muted/40 px-1 focus:outline-none focus:ring-1 focus:ring-ring",
        props.class,
      )}
    />
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
