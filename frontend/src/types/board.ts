/// The project board's wire types, mirroring `src-tauri/src/board/mod.rs`.
///
/// Same entry/detail split the brain makes (`types/brain.ts`): a list hands
/// back metadata only, and reading one card adds its body. The board adds one
/// field to both — `rev`, the token a write has to hand back so a card edited
/// on disk since it was read is not silently clobbered.

export interface BoardCard {
  /// The file stem under `.voidlink/board/`, and the card's identity.
  id: string;
  title: string;
  /// The column this card claims. Not guaranteed to be one the board declares
  /// — a card can be hand-edited into a column that does not exist. See
  /// `boardModel.ts` for where that lands.
  column: string;
  /// Position within its column. A float, so an insert between two cards is
  /// their midpoint and rewrites exactly one file.
  order: number;
  labels: string[];
  created: string | null;
  /** Board-relative path, e.g. "2026-08-04-wire-the-watcher.md". */
  path: string;
  /// What was on disk when this was read. Opaque — compare it, never parse it.
  rev: string;
}

export interface BoardCardDetail extends BoardCard {
  body: string;
}

export interface BoardSnapshot {
  /// Declared columns, in board order. Always populated: a repo with no
  /// `board.md` gets the defaults rather than an empty board.
  columns: string[];
  cards: BoardCard[];
}

export interface BoardWrite {
  /** Repo-relative path written, e.g. ".voidlink/board/foo.md". */
  path: string;
  /// The revision the write produced — the `expectedRev` of the next write to
  /// the same card.
  rev: string;
}
