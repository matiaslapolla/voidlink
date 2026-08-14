/// The palette's **file mode**: the tracked-file list, its ranking, its row and
/// its ignored-files toggle.
///
/// This was a whole overlay of its own until ⌘P and ⌘K were unified — the
/// finder and the palette were two pickers wearing the same `QuickPick` chrome,
/// each with its own open state, and the user had to know which chord led to
/// which half of "open a thing". What was actually specific to the finder is
/// what is left here, and `CommandPalette.tsx` composes it as one of its two
/// modes.
///
/// The resource is deliberately *not* created here. Its source has to stay
/// falsy while the palette is in command mode — that is what keeps ⌘K from
/// walking the repo for a list it will not show — and only the palette knows
/// which mode it is in.
import { Show } from "solid-js";
import { Eye, EyeOff, File } from "lucide-solid";
import { fuzzyMatch, type MatchRange } from "@/commands/fuzzy";
import { FuzzyText, QuickPickRow } from "@/commands/QuickPick";

export interface RankedFile {
  path: string;
  score: number;
  ranges: MatchRange[];
}

/// How many rows a file list is ever worth drawing. Unchanged from the standalone
/// finder: past a couple of screens the answer is "type more", not "scroll".
export const FILE_ROW_LIMIT = 200;

/// Repo-relative paths, ranked against `term`. An empty term is the resting
/// list — the first `FILE_ROW_LIMIT` paths, unscored — which is why the whole
/// repo can be handed in without paying for a match per file on open.
export function rankFiles(paths: readonly string[], term: string): RankedFile[] {
  if (!term) return paths.slice(0, FILE_ROW_LIMIT).map((path) => ({ path, score: 0, ranges: [] }));
  const out: RankedFile[] = [];
  for (const path of paths) {
    // `pathAware`: a hit in the file's own name beats the same letters buried
    // in a directory, which is what makes typing a basename work.
    const match = fuzzyMatch(path, term, { pathAware: true });
    if (match) out.push({ path, score: match.score, ranges: match.ranges });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, FILE_ROW_LIMIT);
}

/// Alt+H, in both the spellings macOS produces. The letter is dead-keyed into
/// "˙" there, so both are accepted.
export function isToggleIgnoredChord(e: KeyboardEvent): boolean {
  return e.altKey && (e.key === "h" || e.key === "˙");
}

/// The header button that mirrors that chord.
export function IgnoredFilesToggle(props: { showIgnored: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onToggle}
      aria-label={props.showIgnored ? "Hide gitignored files" : "Show gitignored files"}
      aria-pressed={props.showIgnored}
      title={
        props.showIgnored
          ? "Hide gitignored files (⌥H)"
          : "Show gitignored files, e.g. .env (⌥H)"
      }
      class={`shrink-0 p-1 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        props.showIgnored
          ? "text-foreground bg-accent/60"
          : "text-muted-foreground/70 hover:text-foreground hover:bg-accent/40"
      }`}
    >
      {props.showIgnored ? <Eye class="w-3.5 h-3.5" /> : <EyeOff class="w-3.5 h-3.5" />}
    </button>
  );
}

/// `kindLabel` is the palette's leading column — the same one the action, open
/// tab and recent-file rows carry. It is a prop rather than a constant because
/// the column exists to tell rows in one mixed list apart, and only the list
/// knows what this row is next to.
export function FileRow(props: {
  path: string;
  ranges: MatchRange[];
  highlighted: boolean;
  kindLabel: string;
}) {
  const cut = () => props.path.lastIndexOf("/");
  const name = () => (cut() === -1 ? props.path : props.path.slice(cut() + 1));
  const dir = () => (cut() === -1 ? "" : props.path.slice(0, cut()));
  /// The matcher ran against the whole path, so the ranges are rebased onto the
  /// two halves the row draws rather than re-matching each of them.
  const shift = (from: number, to: number): MatchRange[] =>
    props.ranges
      .map(([s, e]): MatchRange => [Math.max(s, from) - from, Math.min(e, to) - from])
      .filter(([s, e]) => e > s);

  return (
    <QuickPickRow highlighted={props.highlighted}>
      <span class="text-micro tracking-wide text-muted-foreground/70 w-16 shrink-0 truncate">
        {props.kindLabel}
      </span>
      <File class="w-3.5 h-3.5 shrink-0 opacity-60" />
      <FuzzyText
        text={name()}
        ranges={shift(cut() + 1, props.path.length)}
        class="truncate font-medium"
      />
      <Show when={dir()}>
        <FuzzyText
          text={dir()}
          ranges={shift(0, cut())}
          class="ml-2 text-label text-muted-foreground/70 truncate"
        />
      </Show>
    </QuickPickRow>
  );
}
