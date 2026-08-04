import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BoardCardDetail, BoardSnapshot, BoardWrite } from "@/types/board";

/// The project board: cards under `<repoRoot>/.voidlink/board`. Scoped by repo
/// root for the same reason `api/brain.ts` is — a board belongs to the project
/// you have open, and there is nothing global to point at.
///
/// Marshalling only. Which column a card belongs to, what order means, and how
/// an id is minted are `components/board/boardModel.ts`'s business.

/// Broadcast by Rust when a file under `.voidlink/board/` changed on disk.
/// Payload is the repository root. Mirrors `watch::BOARD_CHANGED_EVENT`, and
/// exists separately from the git pulse because `.voidlink/` is normally
/// gitignored — see that constant for the whole argument.
export const BOARD_CHANGED_EVENT = "voidlink://board-changed";

export const boardApi = {
  listCards(repoPath: string): Promise<BoardSnapshot> {
    return invoke<BoardSnapshot>("board_list_cards", { repoRoot: repoPath });
  },

  readCard(repoPath: string, cardId: string): Promise<BoardCardDetail> {
    return invoke<BoardCardDetail>("board_read_card", { repoRoot: repoPath, cardId });
  },

  /// Write a card and stop. There is no commit, deliberately — see
  /// `board_save_card`.
  ///
  /// `expectedRev` is the `rev` the caller last saw for this card, or `null`
  /// when it believes the card is new. Rust refuses the write if the disk
  /// disagrees; `isBoardConflict` below is how to recognise that refusal.
  saveCard(
    repoPath: string,
    cardId: string,
    content: string,
    expectedRev: string | null,
  ): Promise<BoardWrite> {
    return invoke<BoardWrite>("board_save_card", {
      repoRoot: repoPath,
      cardId,
      content,
      expectedRev,
    });
  },
};

/// Rust marks a refused write with this prefix rather than a typed error,
/// because the IPC boundary flattens errors to strings. Kept beside the
/// transport so the one place that spells the sentinel is the one place that
/// reads it.
const CONFLICT_PREFIX = "board-conflict:";

/// Whether a rejected `saveCard` was refused because somebody else wrote the
/// card first, as opposed to failing for any other reason.
export function isBoardConflict(error: unknown): boolean {
  return String(error).includes(CONFLICT_PREFIX);
}

/// Subscribe to external edits of this repo's board. Returns the unlisten
/// function; a caller that lets it go out of scope leaks the listener.
export function onBoardChanged(
  handler: (repoRoot: string) => void,
): Promise<UnlistenFn> {
  return listen<string>(BOARD_CHANGED_EVENT, (event) => handler(event.payload));
}
