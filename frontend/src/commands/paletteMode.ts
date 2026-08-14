/// Which half of the palette a query is asking for.
///
/// ⌘P and ⌘K open the same overlay — there is one picker, not two stacked on
/// each other — and the *query string* is what decides whether it is listing
/// files or commands. That is the VS Code contract, and it is the reason this
/// is a pure function on a string rather than a mode signal somebody has to
/// keep in sync with what is typed: delete the `>` and you are back in files,
/// because there is no second piece of state that could disagree.
///
/// Its own module, and not a private helper in `CommandPalette.tsx`, so the
/// parsing can be tested without a DOM — the palette itself needs jsdom and the
/// Solid compiler, this needs neither.

/// The prefix, spelled once. `registry.ts` seeds it when ⌘K opens the palette
/// straight into commands.
export const COMMAND_PREFIX = ">";

export type PaletteMode = "files" | "commands";

/// Leading whitespace is ignored: a stray space before the `>` is a typo, not a
/// request for the other mode.
export function paletteMode(query: string): PaletteMode {
  return query.trimStart().startsWith(COMMAND_PREFIX) ? "commands" : "files";
}

/// What to actually match against — the query with the mode marker taken off.
export function paletteTerm(query: string): string {
  const raw = query.trimStart();
  return (raw.startsWith(COMMAND_PREFIX) ? raw.slice(COMMAND_PREFIX.length) : raw).trim();
}
