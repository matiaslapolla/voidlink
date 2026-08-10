# Stream F — the board becomes usable

Branch: `feat/board-cards`. Independent; merge last.

```text
<context>
VoidLink's project board is columns of cards, each card a markdown file under
`<repoRoot>/.voidlink/board/`. The Rust side is complete: `BoardCard` carries
`title`, `column`, `order`, `labels`, `created` and a `rev` token that makes a
write refuse to clobber a card edited on disk since it was read;
`BoardCardDetail` adds `body`. `BoardSurface.tsx` renders and drags, and
`boardModel.ts` is a pure module holding the two questions with wrong answers
(where a card belongs, what a move costs).

What is missing is editing. You can drag a card between columns and that is all.
The user wants cards with a real body, a date, labels — a board you could
actually plan in.

The deliberate decision, already made: **a card's body opens in the real
editor**, not in a second editor built inside the board. VoidLink has Monaco,
markdown preview, LSP and a diff view; a card is a markdown file; opening it as
a file tab is one line of reuse instead of a textarea that will never catch up.
The board itself gains only what belongs on a card face — inline title rename,
label chips, and the date.
</context>

<task>
1. Double-clicking a card (and a context row, and Enter on a focused card) opens
   its markdown file as a normal editor tab, at
   `<repoRoot>/.voidlink/board/<card.path>`.

2. Inline title rename on the card face. Commits through the existing
   rev-checked write, which means re-reading the card immediately before writing
   it — the pattern `BoardSurface` already uses for a move, and for the reason
   stated in its header comment.

3. Label chips on the card face: add, remove, and filter the board by label.
   Colours from the existing chart tokens, not a new palette.

4. Surface the date. Show `created` on the card, and add a due date. A due date
   is a new frontmatter field — extend `buildCardMarkdown` and the Rust parser
   together, and make an absent field parse as absent rather than as an error,
   so every card written before this change still loads.

5. Keep the board live. It refetches on `BOARD_CHANGED_EVENT` today so a card
   written by anything else appears without a manual refresh; a card edited in
   the editor tab this stream opens is exactly that case, and the round trip
   must work.
</task>

<reuse>
- `frontend/src/types/board.ts` — `BoardCard`, `BoardCardDetail`,
  `BoardSnapshot`, `BoardWrite`, and the `rev` contract ("opaque — compare it,
  never parse it").
- `frontend/src/api/board.ts` — `boardApi`, `isBoardConflict`, `onBoardChanged`.
- `frontend/src/components/board/boardModel.ts` — `buildCardMarkdown`,
  `groupIntoColumns`, `isMisfiled`, `mintCardId`, `planMove`. Pure and
  node-tested; new field parsing belongs here, not in the component.
- `frontend/src/components/board/BoardSurface.tsx` — the drag/drop wiring
  (`beginDrag`, `registerDropZone`, `insertionIndex`), the conflict handling,
  and its three load-bearing rules in the header comment. Read them before
  writing a save path.
- `src-tauri/src/board/mod.rs` — the frontmatter parser and writer, and the
  `rev` check. A new field is added here and in `boardModel.ts` in the same
  change or the two disagree.
- `frontend/src/store/layout/index.ts` — the action that opens a file tab. Use
  the existing one; opening a card is not a new kind of open.
- `frontend/src/components/layout/TabStrip.tsx` — nothing to change, but the
  group chip's inline rename (`<input>` swapped in, F2 and double-click, focus
  return) is the worked example for the card title rename. Match its keyboard
  contract rather than inventing one.
- `frontend/src/components/ui/Menu.tsx` — for any card menu.
- `frontend/src/components/layout/EmptyState.tsx` — `EmptyState`,
  `EmptyStateAction`, already used by this surface.
- `frontend/src/components/board/boardModel.test.ts` — extend.
</reuse>

<constraints>
- **The file is the only state.** Every write re-reads the card first and hands
  Rust the `rev` it will refuse a stale write against. Do not cache a card and
  write from the cache; that is the exact bug the `rev` token exists to catch,
  and an agent or an editor tab editing the same file is now a routine case
  rather than a hypothetical.
- A conflict is shown to the user (`isBoardConflict` + a toast), never silently
  retried.
- New frontmatter fields are optional in both directions. A card written by an
  older build loads; a card written by this build loads in an older one with the
  field ignored. Test both.
- The Rust parser and `buildCardMarkdown` must agree on the serialised form.
  Add a test that round-trips a card with every field set through both.
- `boardModel.ts` stays pure and DOM-free.
- Follow `frontend/design-system/MASTER.md`: §7.6 no layout shift when a card
  gains a chip, and every disabled control states a reason; §10 AA contrast on
  label chips.
- No raw colour literals in `src/components/**` (`tokenHygiene.test.ts`).
- Solid, not React: props are getters, never destructured.
- Inspect board files with `cat`/`rg` against a real `.voidlink/board/`
  directory, not with a throwaway script that boots app code.
- Build exactly this stream. Do not touch the layout store, the sidebars, the
  tab strip's own behaviour, or window lifecycle.
</constraints>

<assumptions>
- The due date is `due:` in frontmatter, an ISO `YYYY-MM-DD` string, absent when
  unset. Displayed on the card face; overdue gets the `--warning` token, not a
  new colour.
- Label colours are assigned deterministically from the label string so the same
  label is the same colour everywhere, rather than stored per label.
- Filtering by label is client-side over the already-fetched snapshot. No new
  Rust command.
- `.voidlink/board/` is not in `.gitignore` and board files are meant to be
  committed. This stream does not change that, but note that `.voidlink/` shows
  as untracked in this repo today.
</assumptions>

<out_of_scope>
- A card detail panel inside the board. The editor tab is the body editor —
  that decision is made.
- New columns, column renaming, or board configuration UI.
- Card assignees, checklists, attachments, comments.
- Syncing the board to anything external.
- Any change to how the editor renders markdown.
- The agent board's scratch files under `.voidlink/board/` that are currently
  untracked in this repo — do not commit them.
</out_of_scope>

<acceptance>
- Double-click, Enter and a context row all open a card's markdown in a real
  editor tab. Editing and saving it there updates the card on the board without
  a manual refresh (`BOARD_CHANGED_EVENT` round trip).
- Inline title rename works, survives a refetch, and shows a toast rather than
  silently losing the edit when the card changed on disk underneath it.
- Labels can be added and removed on the card face; filtering by label narrows
  the board.
- `created` shows on every card; a due date can be set, shows, and marks overdue.
- A card file written before this change loads with no due date and no error.
  A card with every field set round-trips through `buildCardMarkdown` and the
  Rust parser identically — one test covering both directions.
- Unit tests in `boardModel.test.ts` for the new field's parse/serialise and for
  label filtering. Rust tests for the parser change.
- Render test: a card gaining a label chip does not shift the cards below it.
- `cargo check` and `cargo test` clean; `npm run test`,
  `npx vitest run --project browser`, `npx tsc --noEmit`, `npx eslint .` clean;
  `npm run build` succeeds.
</acceptance>
```
